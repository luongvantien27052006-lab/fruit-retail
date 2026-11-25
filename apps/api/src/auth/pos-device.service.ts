import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import { v7 as uuidv7 } from 'uuid';
import type { Principal } from '../common/access';
import { AuditOutboxService, type Tx } from '../common/audit-outbox.service';
import { findSqlState } from '../common/db-errors';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { ScopeService } from '../common/scope.service';
import { AuthAttempts } from './auth-attempts';
import {
  type DeviceProof,
  ENROLLMENT_TTL_S,
  enrollmentCodeHash,
  fingerprintOf,
  isValidEd25519PublicKey,
  newEnrollmentCode,
  NONCE_TTL_S,
  normalizeEnrollmentCode,
  normalizePairingCode,
  pairingCode,
  PROOF_SKEW_S,
  type ProofPurpose,
  proofMessage,
  verifyEd25519,
} from './device-proof';
import { sha256 } from './tokens';

/** Thiết bị chờ kích hoạt quá 7 ngày ⇒ hết hạn (không kích hoạt được, không tính vào trần hàng chờ) */
export const PENDING_TTL_DAYS = 7;
/** Trần thiết bị PENDING (còn hạn) mỗi cửa hàng — /auth/devices/register là route công khai */
export const MAX_PENDING_PER_STORE = 20;
/** Trần mã ghi danh còn dùng được (chưa dùng, chưa hết hạn) mỗi cửa hàng */
export const MAX_LIVE_ENROLLMENT_CODES = 10;
const DEVICE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVOKE_RETRIES = 3;

export interface VerifiedDevice {
  id: string;
  storeId: string;
}

const proofInvalid = () =>
  new AppError(
    'AUTHENTICATION_REQUIRED',
    'Chữ ký thiết bị không hợp lệ, đã dùng, hoặc đồng hồ thiết bị lệch quá 2 phút',
  );
const notActivated = () => new AppError('DEVICE_NOT_ACTIVATED', 'Thiết bị chưa được kích hoạt');
const notFound = () => new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy thiết bị');
const enrollmentInvalid = () =>
  new AppError('AUTHENTICATION_REQUIRED', 'Mã ghi danh không đúng, đã dùng hoặc đã hết hạn — xin mã mới từ quản lý');

const isUnique = (e: unknown) => (e as { code?: unknown } | null)?.code === 'P2002' || findSqlState(e) === '23505';
const isDeadlock = (e: unknown) => {
  const s = findSqlState(e);
  return s === '40P01' || s === '40001' || (e as { code?: unknown } | null)?.code === 'P2034';
};

/** X-Device-Id của thiết bị POS: UUID (chữ thường) do thiết bị tự sinh lúc đăng ký = `pos_devices.id`. */
export function posDeviceIdFrom(raw: string | undefined): string {
  const id = raw?.toLowerCase();
  if (!id || !DEVICE_UUID_RE.test(id)) throw new AppError('INVALID_REQUEST', 'Thiếu X-Device-Id (UUID thiết bị POS)');
  return id;
}

/**
 * Thiết bị POS (SEC3 — ADR-012, ADR-022): đăng ký PENDING bằng khóa công khai do máy sinh → Master/cửa hàng trưởng
 * kích hoạt (đối chiếu mã ghép đôi) → thu hồi (trigger DB thu hồi mọi phiên của thiết bị trong cùng transaction).
 */
@Injectable()
export class PosDeviceService {
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly ao: AuditOutboxService,
    private readonly attempts: AuthAttempts,
    private readonly cls: ClsService<RequestStore>,
    private readonly scope: ScopeService,
  ) {}

  private get tx() {
    return this.txHost.tx;
  }

  // ───────────────────────────── đăng ký (công khai) ─────────────────────────────

  async register(b: {
    enrollment_code: string;
    name: string;
    platform: string;
    public_key: string;
    device_proof: DeviceProof;
  }) {
    const id = posDeviceIdFrom(this.cls.get('deviceId'));
    const publicKey = new Uint8Array(Buffer.from(b.public_key, 'base64url'));
    if (!isValidEd25519PublicKey(publicKey))
      throw new AppError('INVALID_REQUEST', 'public_key phải là khóa Ed25519 thô 32 byte (base64url)');
    // chứng minh giữ khóa riêng (không cần nonce một lần: phát lại chỉ đụng ràng buộc duy nhất id/fingerprint ⇒ 409)
    const enrollment = normalizeEnrollmentCode(b.enrollment_code);
    this.checkProof(publicKey, 'register', id, `${enrollment}\n${b.public_key}`, b.device_proof);
    // M1: chỉ máy có mã ghi danh (người quản trị vừa tạo cho đúng cửa hàng) mới vào được hàng chờ. Khóa dòng mã ⇒ hai
    // máy dùng cùng mã song song: máy sau thấy mã đã dùng. Sai / đã dùng / hết hạn / cửa hàng ngừng: cùng một lỗi.
    const [ec] = await this.tx.$queryRaw<{ id: string; store_id: string; usable: boolean }[]>`
      SELECT id, store_id, (used_at IS NULL AND expires_at > now()) AS usable
      FROM core.pos_enrollment_codes WHERE code_hash = ${Buffer.from(enrollmentCodeHash(enrollment))} FOR UPDATE`;
    if (!ec?.usable) throw enrollmentInvalid();
    const store = await this.tx.store.findUnique({
      where: { id: ec.store_id },
      select: { id: true, status: true, archivedAt: true },
    });
    if (!store || store.status !== 'ACTIVE' || store.archivedAt) throw enrollmentInvalid();
    // tuần tự hóa đăng ký theo cửa hàng để trần hàng chờ không bị vượt khi gửi song song
    await this.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('pos-register:' || ${store.id}, 0))`;
    const pending = await this.tx.posDevice.count({
      where: { storeId: store.id, status: 'PENDING', registeredAt: { gt: pendingCutoff() } },
    });
    if (pending >= MAX_PENDING_PER_STORE)
      throw new AppError('RATE_LIMITED', 'Cửa hàng có quá nhiều thiết bị chờ kích hoạt — kích hoạt hoặc từ chối bớt');
    const fingerprint = fingerprintOf(publicKey);
    // L3: hai máy chờ cùng mã ghép đôi trong một cửa hàng ⇒ người kích hoạt có thể nhầm — từ chối máy sau
    const code = pairingCode(fingerprint);
    const waiting = await this.tx.posDevice.findMany({
      where: { storeId: store.id, status: 'PENDING', registeredAt: { gt: pendingCutoff() } },
      select: { fingerprint: true },
    });
    if (waiting.some((w) => pairingCode(w.fingerprint) === code))
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        'Trùng mã ghép đôi với máy đang chờ — sinh khóa mới rồi đăng ký lại',
      );
    try {
      // lỗi trùng làm hỏng transaction của request — không sao: ném 409 ngay, interceptor rollback
      await this.tx.posDevice.create({
        data: { id, storeId: store.id, name: b.name, platform: b.platform, publicKey, fingerprint },
        select: { id: true },
      });
    } catch (e) {
      if (isUnique(e)) throw new AppError('INVALID_STATE_TRANSITION', 'Thiết bị hoặc khóa này đã đăng ký');
      throw e;
    }
    // trigger: mã chưa dùng, còn hạn, thiết bị PENDING cùng cửa hàng; used_at do server đặt
    const used = await this.tx.posEnrollmentCode.updateMany({
      where: { id: ec.id, usedAt: null },
      data: { usedAt: new Date(), usedByDeviceId: id },
    });
    if (used.count !== 1) throw enrollmentInvalid();
    const row = await this.tx.posDevice.findUniqueOrThrow({ where: { id }, select: { registeredAt: true } });
    await this.ao.recordAudit({
      action: 'pos_device.register',
      resourceType: 'pos_device',
      resourceId: id,
      after: {
        store_id: store.id,
        name: b.name,
        platform: b.platform,
        pairing_code: pairingCode(fingerprint),
        enrollment_code_id: ec.id,
      },
    });
    return {
      device_id: id,
      status: 'PENDING' as const,
      pairing_code: pairingCode(fingerprint),
      registered_at: row.registeredAt.toISOString(),
    };
  }

  // ───────────────────────────── quản trị (device:write, phạm vi cửa hàng) ─────────────────────────────

  /**
   * Tạo mã ghi danh cho một cửa hàng trong phạm vi của người gọi (ngoài phạm vi ⇒ 404). Mã rõ chỉ trả MỘT lần trong
   * response; DB và audit chỉ giữ SHA-256 / id. Tối đa MAX_LIVE_ENROLLMENT_CODES mã còn dùng được mỗi cửa hàng.
   */
  async createEnrollmentCode(p: Principal, storeId: string) {
    const scope = await this.scope.stores('device:write');
    if (scope !== 'ALL' && !scope.has(storeId)) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy cửa hàng');
    const store = await this.tx.store.findUnique({
      where: { id: storeId },
      select: { id: true, status: true, archivedAt: true },
    });
    if (!store) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy cửa hàng');
    if (store.status !== 'ACTIVE' || store.archivedAt)
      throw new AppError('INVALID_STATE_TRANSITION', 'Cửa hàng không hoạt động');
    await this.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('pos-enroll:' || ${store.id}, 0))`;
    const live = await this.tx.posEnrollmentCode.count({
      where: { storeId: store.id, usedAt: null, expiresAt: { gt: new Date() } },
    });
    if (live >= MAX_LIVE_ENROLLMENT_CODES)
      throw new AppError('RATE_LIMITED', 'Cửa hàng đã có nhiều mã ghi danh chưa dùng — dùng hết hoặc chờ hết hạn');
    const id = uuidv7();
    const plain = newEnrollmentCode();
    // hạn theo đồng hồ DB (created_at do trigger đặt bằng now()) ⇒ CHECK hạn ≤ 1 giờ không phụ thuộc đồng hồ app
    await this.tx.$executeRaw`
      INSERT INTO core.pos_enrollment_codes (id, store_id, code_hash, created_by, expires_at)
      VALUES (${id}::uuid, ${store.id}::uuid, ${Buffer.from(enrollmentCodeHash(plain))}, ${p.userId}::uuid,
              now() + make_interval(secs => ${ENROLLMENT_TTL_S}))`;
    const row = await this.tx.posEnrollmentCode.findUniqueOrThrow({ where: { id }, select: { expiresAt: true } });
    await this.ao.recordAudit({
      action: 'pos_device.enrollment_code.create',
      resourceType: 'pos_enrollment_code',
      resourceId: id,
      after: { store_id: store.id, expires_at: row.expiresAt.toISOString() },
    });
    return { id, store_id: store.id, code: plain, expires_at: row.expiresAt.toISOString() };
  }

  async list(p: Principal, status?: 'PENDING' | 'ACTIVE' | 'REVOKED') {
    const scope = await this.scope.stores('device:write');
    if (scope !== 'ALL' && scope.size === 0) return { items: [] };
    const rows = await this.tx.posDevice.findMany({
      where: {
        ...(scope === 'ALL' ? {} : { storeId: { in: [...scope] } }),
        // mặc định ẩn REVOKED (rác/đã thu hồi không đẩy máy đang dùng ra khỏi 200 dòng); lọc status=REVOKED để xem
        ...(status ? { status } : { status: { in: ['PENDING', 'ACTIVE'] } }),
        // hàng chờ hết hạn không bao giờ hiện (L4)
        NOT: { status: 'PENDING', registeredAt: { lte: pendingCutoff() } },
      },
      orderBy: { registeredAt: 'desc' },
      take: 200,
      select: DEVICE_SELECT,
    });
    return { items: rows.map(toWireDevice) };
  }

  async activate(p: Principal, id: string, b: { pairing_code: string; register_id?: string | null; name?: string }) {
    const d = await this.scopedDevice(p, id, true);
    if (d.status !== 'PENDING') throw new AppError('INVALID_STATE_TRANSITION', `Thiết bị đang ${d.status}`);
    const store = await this.tx.store.findUnique({
      where: { id: d.storeId },
      select: { status: true, archivedAt: true },
    });
    if (!store || store.status !== 'ACTIVE' || store.archivedAt)
      throw new AppError('INVALID_STATE_TRANSITION', 'Cửa hàng của thiết bị không hoạt động');
    if (d.registeredAt <= pendingCutoff())
      throw new AppError('INVALID_STATE_TRANSITION', 'Yêu cầu đăng ký đã quá 7 ngày — thiết bị đăng ký lại');
    if (normalizePairingCode(b.pairing_code) !== normalizePairingCode(pairingCode(d.fingerprint)))
      throw new AppError('INVALID_REQUEST', 'Mã ghép đôi không khớp với thiết bị', { field: 'pairing_code' });
    if (b.register_id) {
      const reg = await this.tx.register.findUnique({ where: { id: b.register_id }, select: { storeId: true } });
      if (reg?.storeId !== d.storeId)
        throw new AppError('INVALID_REQUEST', 'Quầy không thuộc cửa hàng của thiết bị', { field: 'register_id' });
    }
    const r = await this.tx.posDevice.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'ACTIVE',
        activatedBy: p.userId,
        activatedAt: new Date(), // trigger đặt lại bằng now() của server
        ...(b.register_id !== undefined ? { registerId: b.register_id } : {}),
        ...(b.name ? { name: b.name } : {}),
      },
    });
    if (r.count !== 1) throw new AppError('INVALID_STATE_TRANSITION', 'Thiết bị vừa đổi trạng thái');
    const after = await this.tx.posDevice.findUniqueOrThrow({ where: { id }, select: DEVICE_SELECT });
    await this.ao.recordAudit({
      action: 'pos_device.activate',
      resourceType: 'pos_device',
      resourceId: id,
      before: { status: 'PENDING' },
      after: { status: 'ACTIVE', register_id: after.registerId, name: after.name },
    });
    return toWireDevice(after);
  }

  /**
   * Thu hồi (PENDING hoặc ACTIVE ⇒ REVOKED). Trigger `pos_device_revoke_sessions` thu hồi mọi phiên của thiết bị trong
   * cùng transaction. Thứ tự khóa: PHIÊN trước, THIẾT BỊ sau — cùng thứ tự với luồng sửa phiên (refresh khóa phiên rồi
   * trigger FOR SHARE thiết bị), tránh deadlock (lưu ý lát 1); 40P01/40001 vẫn xảy ra ⇒ thử lại cả transaction.
   * @OwnTransaction: mỗi lần thử là một transaction mới (audit cùng transaction).
   */
  async revoke(p: Principal, id: string, reason: string) {
    for (let i = 1; ; i++) {
      try {
        return await this.txHost.withTransaction(() => this.revokeOnce(p, id, reason));
      } catch (e) {
        if (i >= REVOKE_RETRIES || !isDeadlock(e)) throw e;
      }
    }
  }

  private async revokeOnce(p: Principal, id: string, reason: string) {
    const pre = await this.scopedDevice(p, id, false);
    if (pre.status === 'REVOKED') throw new AppError('INVALID_STATE_TRANSITION', 'Thiết bị đã bị thu hồi');
    const sessions = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM core.sessions WHERE pos_device_id = ${id}::uuid AND revoked_at IS NULL ORDER BY id FOR UPDATE`;
    const r = await this.tx.posDevice.updateMany({
      where: { id, status: { in: ['PENDING', 'ACTIVE'] } },
      data: { status: 'REVOKED', revokedBy: p.userId, revokedAt: new Date(), revokeReason: reason },
    });
    if (r.count !== 1) throw new AppError('INVALID_STATE_TRANSITION', 'Thiết bị đã bị thu hồi');
    void sessions;
    // L5: đếm SAU cập nhật — gồm cả phiên vừa tạo song song mà trigger thu hồi luôn (REVOKED là trạng thái cuối nên mọi
    // phiên DEVICE_REVOKED của thiết bị đều do transaction này)
    const revokedSessions = await this.tx.session.count({ where: { posDeviceId: id, revokeReason: 'DEVICE_REVOKED' } });
    const after = await this.tx.posDevice.findUniqueOrThrow({ where: { id }, select: DEVICE_SELECT });
    await this.ao.recordAudit({
      action: 'pos_device.revoke',
      resourceType: 'pos_device',
      resourceId: id,
      before: { status: pre.status },
      after: { status: 'REVOKED', revoked_sessions: revokedSessions },
      reason,
    });
    return { device: toWireDevice(after), revoked_sessions: revokedSessions };
  }

  /** Thiết bị trong phạm vi cửa hàng của người gọi; ngoài phạm vi ⇒ 404 (không lộ tồn tại). */
  private async scopedDevice(p: Principal, id: string, lockRow: boolean) {
    const scope = await this.scope.stores('device:write');
    if (lockRow) await this.tx.$queryRaw`SELECT id FROM core.pos_devices WHERE id = ${id}::uuid FOR UPDATE`;
    const d = await this.tx.posDevice.findUnique({
      where: { id },
      select: { id: true, storeId: true, status: true, registeredAt: true, fingerprint: true },
    });
    if (!d || (scope !== 'ALL' && !scope.has(d.storeId))) throw notFound();
    return d;
  }

  // ───────────────────────────── bằng chứng thiết bị (/auth/pin, /auth/refresh) ─────────────────────────────

  /**
   * Thiết bị ACTIVE + chữ ký hợp lệ + nonce chưa dùng. Nonce được ghi trong transaction RIÊNG đã commit trước khi
   * kiểm PIN/refresh: request sau đó lỗi (PIN sai…) vẫn không phát lại được cùng chữ ký. Gọi khi CHƯA mở transaction.
   */
  async verifyProof(purpose: ProofPurpose, binding: string, proof: DeviceProof): Promise<VerifiedDevice> {
    const id = posDeviceIdFrom(this.cls.get('deviceId'));
    const d = await this.tx.posDevice.findUnique({
      where: { id },
      select: { id: true, storeId: true, status: true, publicKey: true },
    });
    if (!d || d.status === 'PENDING') {
      await this.attempts.log(null, 'DEVICE_NOT_ACTIVE', null);
      throw notActivated();
    }
    if (d.status === 'REVOKED') {
      await this.attempts.log(null, 'DEVICE_REVOKED', null);
      throw new AppError('DEVICE_REVOKED', 'Thiết bị đã bị thu hồi — đăng ký lại thiết bị');
    }
    try {
      this.checkProof(d.publicKey, purpose, id, binding, proof);
    } catch (e) {
      await this.attempts.log(null, 'DEVICE_PROOF_INVALID', null);
      throw e;
    }
    const now = new Date();
    try {
      await this.txHost.withTransaction(async () => {
        // dọn nonce hết hạn của chính thiết bị này (hạn > cửa sổ thời điểm ⇒ nonce còn dùng được không bị xóa)
        await this.tx.authChallenge.deleteMany({
          where: { kind: 'DEVICE_NONCE', posDeviceId: id, expiresAt: { lt: now } },
        });
        // last_seen_at ở transaction ngắn này (không ở transaction tạo phiên): hai đăng nhập song song cùng máy mà cùng
        // giữ FOR SHARE (trigger phiên) rồi cùng UPDATE thiết bị sẽ deadlock
        const live = await this.tx.posDevice.updateMany({
          where: { id, status: 'ACTIVE' },
          data: { lastSeenAt: now },
        });
        if (live.count !== 1) throw new AppError('DEVICE_REVOKED', 'Thiết bị vừa bị thu hồi');
        // trigger auth_challenges_guard kiểm thiết bị vẫn ACTIVE (FOR SHARE) — thu hồi song song ⇒ lỗi ràng buộc
        await this.tx.authChallenge.create({
          data: {
            id: uuidv7(),
            kind: 'DEVICE_NONCE',
            posDeviceId: id,
            secretHash: sha256(`${id}:${proof.nonce}`),
            expiresAt: new Date(now.getTime() + NONCE_TTL_S * 1000),
            usedAt: now,
          },
          select: { id: true },
        });
      });
    } catch (e) {
      if (isUnique(e)) {
        await this.attempts.log(null, 'DEVICE_NONCE_REUSED', null);
        throw proofInvalid();
      }
      if (findSqlState(e) === '23514') {
        // chỉ báo DEVICE_REVOKED khi thiết bị THẬT SỰ không còn ACTIVE (23514 khác — vd hạn nonce — là lỗi hệ thống)
        const now2 = await this.tx.posDevice.findUnique({ where: { id }, select: { status: true } });
        if (now2?.status !== 'ACTIVE') {
          await this.attempts.log(null, 'DEVICE_REVOKED', null);
          throw new AppError('DEVICE_REVOKED', 'Thiết bị vừa bị thu hồi');
        }
      }
      throw e;
    }
    return { id: d.id, storeId: d.storeId };
  }

  private checkProof(publicKey: Uint8Array, purpose: ProofPurpose, id: string, binding: string, proof: DeviceProof) {
    if (Math.abs(Math.floor(Date.now() / 1000) - proof.ts) > PROOF_SKEW_S) throw proofInvalid();
    // nonce dạng chuẩn duy nhất (không bit thừa) ⇒ một giá trị byte chỉ có một chuỗi ⇒ ràng buộc duy nhất theo chuỗi đủ
    if (Buffer.from(proof.nonce, 'base64url').toString('base64url') !== proof.nonce) throw proofInvalid();
    if (!verifyEd25519(publicKey, proofMessage(purpose, id, proof.ts, proof.nonce, binding), proof.signature))
      throw proofInvalid();
  }
}

const DEVICE_SELECT = {
  id: true,
  storeId: true,
  registerId: true,
  name: true,
  platform: true,
  fingerprint: true,
  status: true,
  registeredAt: true,
  activatedAt: true,
  revokedAt: true,
  revokeReason: true,
  lastSeenAt: true,
} as const;

function toWireDevice(d: {
  id: string;
  storeId: string;
  registerId: string | null;
  name: string;
  platform: string;
  fingerprint: Uint8Array;
  status: string;
  registeredAt: Date;
  activatedAt: Date | null;
  revokedAt: Date | null;
  revokeReason: string | null;
  lastSeenAt: Date | null;
}) {
  return {
    id: d.id,
    store_id: d.storeId,
    register_id: d.registerId,
    name: d.name,
    platform: d.platform,
    status: d.status,
    registered_at: d.registeredAt.toISOString(),
    activated_at: d.activatedAt?.toISOString() ?? null,
    revoked_at: d.revokedAt?.toISOString() ?? null,
    revoke_reason: d.revokeReason,
    last_seen_at: d.lastSeenAt?.toISOString() ?? null,
  };
}

const pendingCutoff = () => new Date(Date.now() - PENDING_TTL_DAYS * 24 * 3600 * 1000);
