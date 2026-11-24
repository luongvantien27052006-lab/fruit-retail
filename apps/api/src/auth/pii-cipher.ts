import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { AuthKeys } from './auth-config';

/**
 * AES-256-GCM theo ADR-015: `version(1)=1 | key_id(2, big-endian) | nonce(12) | ciphertext | tag(16)`.
 * AAD = `table:column:row_id` — ciphertext chép sang dòng/cột khác sẽ không giải mã được.
 */
const VERSION = 1;
const HEADER = 1 + 2 + 12;
const TAG = 16;

export class PiiCipher {
  constructor(private readonly keys: AuthKeys) {}

  encrypt(plain: Buffer | string, aad: string): Uint8Array<ArrayBuffer> {
    const id = this.keys.pii.writeId;
    const key = this.keys.pii.keys.get(id);
    if (!key) throw new Error('khóa ghi PII không có');
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, nonce);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([c.update(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain), c.final()]);
    const head = Buffer.alloc(3);
    head.writeUInt8(VERSION, 0);
    head.writeUInt16BE(id, 1);
    return new Uint8Array(Buffer.concat([head, nonce, ct, c.getAuthTag()]));
  }

  /** Sai khóa/AAD/dữ liệu ⇒ ném lỗi (không trả rác). */
  decrypt(blob: Uint8Array, aad: string): Buffer {
    const b = Buffer.from(blob);
    if (b.length < HEADER + TAG || b.readUInt8(0) !== VERSION) throw new Error('ciphertext PII sai định dạng');
    const key = this.keys.pii.keys.get(b.readUInt16BE(1));
    if (!key) throw new Error('ciphertext PII dùng khóa không còn cấu hình');
    const d = createDecipheriv('aes-256-gcm', key, b.subarray(3, HEADER));
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(b.subarray(b.length - TAG));
    return Buffer.concat([d.update(b.subarray(HEADER, b.length - TAG)), d.final()]);
  }

  /** HMAC-SHA256(pepper, giá trị đã chuẩn hóa) — tra cứu/ghi nhật ký không lộ giá trị gốc. */
  hmac(normalized: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(createHmac('sha256', this.keys.pepper).update(normalized, 'utf8').digest());
  }
}

export const totpAad = (userId: string) => `users:totp_secret_enc:${userId}`;
