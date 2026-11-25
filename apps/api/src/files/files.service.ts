import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import { v7 as uuidv7 } from 'uuid';
import type { Principal } from '../common/access';
import { AuditOutboxService, type Tx } from '../common/audit-outbox.service';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { ObjectStorage } from '../infra/object-storage.service';

const MB = 1024 * 1024;
type Mime = 'image/jpeg' | 'image/webp';
interface KindRule {
  maxBytes: number;
  mimes: readonly Mime[];
  /** chỉ nhận ảnh chụp trực tiếp từ camera của app (ADR-014: ảnh hủy hàng, ảnh cân) */
  cameraOnly: boolean;
  /** loại tài khoản được tải loại này (TB1 kiểm thử lát 7): khách chỉ ảnh khiếu nại; ảnh nghiệp vụ nội bộ chỉ nội bộ */
  userTypes: readonly Principal['userType'][];
}
const STAFF_ADMIN = ['STAFF', 'MASTER'] as const;
/** Loại file client được tải lên (ADR-014, ADR-025). File báo cáo do server tạo — không đi qua presign. */
export const FILE_KINDS: Readonly<Record<string, KindRule>> = {
  PHOTO_SPOILAGE: { maxBytes: 5 * MB, mimes: ['image/jpeg', 'image/webp'], cameraOnly: true, userTypes: STAFF_ADMIN },
  PHOTO_WEIGHT: { maxBytes: 5 * MB, mimes: ['image/jpeg', 'image/webp'], cameraOnly: true, userTypes: STAFF_ADMIN },
  PHOTO_COMPLAINT: {
    maxBytes: 5 * MB,
    mimes: ['image/jpeg', 'image/webp'],
    cameraOnly: false,
    userTypes: ['CUSTOMER', 'STAFF', 'MASTER'],
  },
  PHOTO_RECEIPT: { maxBytes: 5 * MB, mimes: ['image/jpeg', 'image/webp'], cameraOnly: false, userTypes: STAFF_ADMIN },
  PHOTO_PRODUCT: { maxBytes: 5 * MB, mimes: ['image/jpeg', 'image/webp'], cameraOnly: false, userTypes: STAFF_ADMIN },
};
export const PRESIGN_TTL_S = 300;
export const DOWNLOAD_TTL_S = 60;
/** PENDING quá 1 giờ ⇒ complete từ chối (EXPIRED) */
export const PENDING_MAX_AGE_S = 3600;
/**
 * Trần số file TẠO (mọi trạng thái) mỗi người: 20 / giờ, 100 / ngày (TB1 kiểm thử lát 7 — trước chỉ đếm PENDING nên
 * presign → complete liên tục tải không giới hạn). Một file ≤ 5 MB ⇒ ≤ 500 MB / người / ngày.
 */
export const MAX_PENDING_PER_USER = 20;
export const MAX_FILES_PER_DAY = 100;

/** Định dạng thật theo byte đầu (không tin Content-Type client khai) */
export function sniffImage(head: Buffer): Mime | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}

const notFound = () => new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy file');
/** khóa lưu cuối của file READY — `files/…` (khóa tải lên, có URL PUT ký) ⇒ `final/…` (chỉ server ghi) */
export const finalKeyOf = (uploadKey: string) => uploadKey.replace(/^files\//, 'final/');

/**
 * File (§3.5, FR-INV-16, ADR-014, ADR-025): presign PUT 5 phút (Content-Type + Content-Length ký) → client PUT →
 * complete: server TỰ tải lại, tính sha256 + kích thước, nhận dạng định dạng theo byte đầu; lệch khai báo ⇒ REJECTED
 * (xóa object). Trùng sha256 với file READY khác ⇒ vẫn nhận nhưng gắn `duplicate_of_id` + cảnh báo (FR-INV-16: phát hiện
 * ảnh dùng lại). Tải về: presigned GET 60 giây sau khi kiểm quyền.
 */
@Injectable()
export class FilesService {
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly storage: ObjectStorage,
    private readonly ao: AuditOutboxService,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  private get tx() {
    return this.txHost.tx;
  }

  private principal(): Principal {
    const p = this.cls.get('principal');
    if (!p) throw new AppError('AUTHENTICATION_REQUIRED', 'Cần đăng nhập');
    return p;
  }

  async presign(b: {
    kind: string;
    mime: string;
    bytes: number;
    sha256: string;
    capture_source: 'CAMERA' | 'GALLERY';
    captured_at?: string | null;
  }) {
    const p = this.principal();
    if (!this.storage.configured) throw new AppError('CONFIGURATION_NOT_READY', 'Chưa cấu hình lưu trữ file');
    const rule = FILE_KINDS[b.kind];
    if (!rule) throw new AppError('INVALID_REQUEST', 'Loại file không hợp lệ', { field: 'kind' });
    if (!rule.userTypes.includes(p.userType))
      throw new AppError('ACTION_FORBIDDEN', 'Tài khoản này không tải được loại file này', { field: 'kind' });
    if (!rule.mimes.includes(b.mime as Mime))
      throw new AppError('INVALID_REQUEST', `Loại ${b.kind} chỉ nhận ${rule.mimes.join(', ')}`, { field: 'mime' });
    if (b.bytes > rule.maxBytes)
      throw new AppError('INVALID_REQUEST', `File tối đa ${rule.maxBytes / MB} MB`, { field: 'bytes' });
    if (rule.cameraOnly && b.capture_source !== 'CAMERA')
      throw new AppError('INVALID_REQUEST', 'Ảnh này phải chụp trực tiếp bằng camera của ứng dụng', {
        field: 'capture_source',
      });
    // tuần tự hóa theo người gọi để trần PENDING không bị vượt khi gửi song song
    await this.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('file-presign:' || ${p.userId}, 0))`;
    const [hour, day] = await Promise.all(
      [3600, 86400].map((s) =>
        this.tx.file.count({ where: { createdBy: p.userId, createdAt: { gt: new Date(Date.now() - s * 1000) } } }),
      ),
    );
    if ((hour ?? 0) >= MAX_PENDING_PER_USER || (day ?? 0) >= MAX_FILES_PER_DAY)
      throw new AppError('RATE_LIMITED', 'Đã tải lên quá nhiều file — thử lại sau');
    const id = uuidv7();
    const now = new Date();
    const key = `files/${b.kind.toLowerCase()}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}`;
    await this.tx.file.create({
      data: {
        id,
        kind: b.kind,
        mime: b.mime,
        storageKey: key,
        declaredBytes: b.bytes,
        declaredSha256: new Uint8Array(Buffer.from(b.sha256, 'hex')),
        captureSource: b.capture_source,
        capturedAt: b.captured_at ? new Date(b.captured_at) : null,
        deviceId: this.cls.get('deviceId') ?? null,
        createdBy: p.userId,
      },
      select: { id: true },
    });
    await this.ao.recordAudit({
      action: 'file.presign',
      resourceType: 'file',
      resourceId: id,
      after: { kind: b.kind, mime: b.mime, bytes: b.bytes, capture_source: b.capture_source },
    });
    const url = await this.storage.presignPut(key, b.mime, b.bytes, PRESIGN_TTL_S);
    return {
      id,
      upload_url: url,
      method: 'PUT' as const,
      headers: { 'Content-Type': b.mime },
      expires_at: new Date(now.getTime() + PRESIGN_TTL_S * 1000).toISOString(),
    };
  }

  /** Tải lại + tính sha256 NGOÀI transaction (không giữ kết nối DB khi đọc S3); ghi kết quả trong transaction ngắn. */
  async complete(id: string) {
    const p = this.principal();
    if (!this.storage.configured) throw new AppError('CONFIGURATION_NOT_READY', 'Chưa cấu hình lưu trữ file');
    const f = await this.tx.file.findUnique({
      where: { id },
      select: {
        id: true,
        kind: true,
        mime: true,
        storageKey: true,
        declaredBytes: true,
        declaredSha256: true,
        status: true,
        createdBy: true,
        createdAt: true,
      },
    });
    if (!f || f.createdBy !== p.userId) throw notFound();
    if (f.status !== 'PENDING') throw new AppError('INVALID_STATE_TRANSITION', `File đã ${f.status}`);
    const rule = FILE_KINDS[f.kind];
    let reject: string | null = null;
    let digest: { bytes: number; sha256: Buffer } | null = null;
    if (!rule) reject = 'KIND_UNKNOWN';
    else if (f.createdAt.getTime() < Date.now() - PENDING_MAX_AGE_S * 1000) reject = 'EXPIRED';
    else {
      const size = await this.storage.size(f.storageKey);
      if (size === null) throw new AppError('INVALID_STATE_TRANSITION', 'Chưa tải file lên — PUT vào upload_url trước');
      if (size !== f.declaredBytes || size > rule.maxBytes) reject = 'SIZE_MISMATCH';
      else {
        // C1 (kiểm thử lát 7): URL PUT còn hạn tới 5 phút và không thu hồi được ⇒ chép sang khóa CUỐI (không URL ký nào
        // trỏ tới) rồi kiểm sha256 trên CHÍNH bản chép — nội dung đã kiểm là nội dung được lưu và tải về mãi về sau
        await this.storage.copy(f.storageKey, finalKeyOf(f.storageKey));
        const d = await this.storage.digest(finalKeyOf(f.storageKey), Math.min(rule.maxBytes, f.declaredBytes));
        digest = d;
        if (d.bytes !== f.declaredBytes) reject = 'SIZE_MISMATCH';
        else if (!d.sha256.equals(Buffer.from(f.declaredSha256))) reject = 'SHA256_MISMATCH';
        else if (sniffImage(d.head) !== f.mime) reject = 'CONTENT_TYPE_MISMATCH';
      }
    }
    const out = await this.txHost.withTransaction(async () => {
      const [locked] = await this.tx.$queryRaw<{ status: string }[]>`
        SELECT status::text FROM core.files WHERE id = ${id}::uuid FOR UPDATE`;
      if (locked?.status !== 'PENDING')
        throw new AppError('INVALID_STATE_TRANSITION', `File đã ${locked?.status ?? '?'}`);
      if (reject || !digest) {
        const reason = reject ?? 'UNKNOWN';
        await this.tx.file.update({
          where: { id },
          data: { status: 'REJECTED', rejectReason: reason },
          select: { id: true },
        });
        await this.ao.recordAudit({ action: 'file.reject', resourceType: 'file', resourceId: id, after: { reason } });
        return {
          id,
          status: 'REJECTED' as const,
          reject_reason: reason,
          bytes: null,
          sha256: null,
          duplicate_of_id: null,
          warnings: [],
        };
      }
      const sha = new Uint8Array(digest.sha256);
      // FR-INV-16: cùng nội dung với file đã nhận trước đó (ảnh dùng lại) ⇒ cảnh báo, không chặn
      // T3: tuần tự hóa theo nội dung ⇒ hai complete song song cùng ảnh: cái sau thấy cái trước (không né FR-INV-16)
      await this.tx
        .$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('file-sha:' || ${digest.sha256.toString('hex')}, 0))`;
      const dup = await this.tx.file.findFirst({
        where: { sha256: sha, status: 'READY', id: { not: id } },
        orderBy: { completedAt: 'asc' },
        select: { id: true },
      });
      await this.tx.file.update({
        where: { id },
        data: {
          status: 'READY',
          bytes: digest.bytes,
          sha256: sha,
          completedAt: new Date(),
          duplicateOfId: dup?.id ?? null,
        },
        select: { id: true },
      });
      await this.ao.recordAudit({
        action: 'file.complete',
        resourceType: 'file',
        resourceId: id,
        after: { bytes: digest.bytes, duplicate_of_id: dup?.id ?? null },
      });
      return {
        id,
        status: 'READY' as const,
        reject_reason: null,
        bytes: digest.bytes,
        sha256: digest.sha256.toString('hex'),
        duplicate_of_id: dup?.id ?? null,
        warnings: dup ? ['DUPLICATE_CONTENT'] : [],
      };
    });
    // khóa tải lên không bao giờ được phục vụ ⇒ luôn xóa; bị từ chối ⇒ xóa cả bản chép
    await this.storage.remove(f.storageKey);
    if (out.status === 'REJECTED') await this.storage.remove(finalKeyOf(f.storageKey));
    return out;
  }

  /**
   * Quyền tải: người tạo, hoặc Master. Quyền theo chủ sở hữu (owner_type — phiếu hủy, khiếu nại…) thêm khi các nghiệp vụ
   * đó gắn file (CP06+); viewer không bao giờ (route viewer riêng — CP12).
   */
  async downloadUrl(id: string) {
    const p = this.principal();
    if (!this.storage.configured) throw new AppError('CONFIGURATION_NOT_READY', 'Chưa cấu hình lưu trữ file');
    const f = await this.tx.file.findUnique({
      where: { id },
      select: { id: true, kind: true, mime: true, storageKey: true, status: true, createdBy: true },
    });
    if (!f || (f.createdBy !== p.userId && p.userType !== 'MASTER')) throw notFound();
    if (f.status !== 'READY') throw new AppError('INVALID_STATE_TRANSITION', `File đang ${f.status}`);
    const ext = f.mime === 'image/webp' ? 'webp' : 'jpg';
    const url = await this.storage.presignGet(
      finalKeyOf(f.storageKey),
      `${f.kind.toLowerCase()}-${f.id}.${ext}`,
      DOWNLOAD_TTL_S,
    );
    return { url, expires_at: new Date(Date.now() + DOWNLOAD_TTL_S * 1000).toISOString() };
  }
}
