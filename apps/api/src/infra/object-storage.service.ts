import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError } from '../common/errors';
import { ENV, type Env } from '../config/env';

export interface ObjectDigest {
  bytes: number;
  sha256: Buffer;
  /** tối đa 16 byte đầu — nhận dạng định dạng thật (không tin Content-Type client khai) */
  head: Buffer;
}

/**
 * Object storage S3 (ADR-014, ADR-025). Hai client: `internal` (API ↔ S3, có thể qua mạng nội bộ) và `public` (chỉ để
 * KÝ URL cho client; ký không cần mạng). Không bao giờ có URL công khai: chỉ presigned PUT 5 phút / GET 60 giây.
 */
@Injectable()
export class ObjectStorage implements OnModuleDestroy {
  private readonly log = new Logger('ObjectStorage');
  private readonly internal: S3Client | null;
  private readonly signer: S3Client | null;
  private readonly bucket: string;

  constructor(@Inject(ENV) env: Env) {
    this.bucket = env.S3_BUCKET ?? '';
    const ok = env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY && env.S3_SECRET_KEY;
    const mk = (endpoint: string) =>
      new S3Client({
        endpoint,
        region: env.S3_REGION,
        forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
        credentials: { accessKeyId: env.S3_ACCESS_KEY ?? '', secretAccessKey: env.S3_SECRET_KEY ?? '' },
        // không tự thêm checksum CRC vào request (một số kho S3 tương thích không hỗ trợ) — sha256 do server tự tính
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        maxAttempts: 2,
      });
    this.internal = ok ? mk(env.S3_ENDPOINT ?? '') : null;
    this.signer = ok ? mk(env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT ?? '') : null;
  }

  get configured(): boolean {
    return this.internal !== null;
  }

  private clients() {
    if (!this.internal || !this.signer) throw new AppError('CONFIGURATION_NOT_READY', 'Chưa cấu hình lưu trữ file');
    return { internal: this.internal, signer: this.signer };
  }

  /** PUT ký kèm Content-Type + Content-Length (client gửi khác ⇒ chữ ký sai, S3 từ chối). */
  async presignPut(key: string, mime: string, bytes: number, expiresIn = 300): Promise<string> {
    const { signer } = this.clients();
    return getSignedUrl(
      signer,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: mime, ContentLength: bytes }),
      {
        expiresIn,
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
  }

  async presignGet(key: string, filename: string, expiresIn = 60): Promise<string> {
    const { signer } = this.clients();
    return getSignedUrl(
      signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      }),
      { expiresIn },
    );
  }

  /** null = chưa có object. Kích thước lấy từ HEAD (không tải). */
  async size(key: string): Promise<number | null> {
    const { internal } = this.clients();
    try {
      const h = await internal.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return h.ContentLength ?? 0;
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'Không đọc được kho lưu trữ file');
    }
  }

  /** Tải object, TỰ tính sha256 + đếm byte; vượt `maxBytes` ⇒ dừng sớm (trả bytes = maxBytes + 1). */
  async digest(key: string, maxBytes: number): Promise<ObjectDigest> {
    const { internal } = this.clients();
    let body: Readable;
    try {
      const r = await internal.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      body = r.Body as Readable;
    } catch {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'Không đọc được kho lưu trữ file');
    }
    const h = createHash('sha256');
    let bytes = 0;
    const head: Buffer[] = [];
    let headLen = 0;
    for await (const chunk of body) {
      const b = Buffer.from(chunk as Uint8Array);
      bytes += b.length;
      if (bytes > maxBytes) {
        body.destroy();
        return { bytes: maxBytes + 1, sha256: Buffer.alloc(32), head: Buffer.concat(head) };
      }
      if (headLen < 16) {
        head.push(b.subarray(0, 16 - headLen));
        headLen += Math.min(b.length, 16 - headLen);
      }
      h.update(b);
    }
    return { bytes, sha256: h.digest(), head: Buffer.concat(head) };
  }

  /** Xóa object bị từ chối — lỗi chỉ ghi log (bản ghi REJECTED vẫn đúng; dọn rác ở job định kỳ sau). */
  async remove(key: string): Promise<void> {
    const { internal } = this.clients();
    await internal.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })).catch((e: unknown) => {
      this.log.warn(`không xóa được object bị từ chối: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  onModuleDestroy(): void {
    this.internal?.destroy();
    this.signer?.destroy();
  }
}
