import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { z } from 'zod';

/**
 * Bằng chứng thiết bị POS (SEC3, ADR-012, ADR-022): thiết bị giữ khóa riêng Ed25519 (Credential Manager/Keystore), ký
 * thông điệp chuẩn gồm mục đích + X-Device-Id + thời điểm + nonce ngẫu nhiên do thiết bị sinh + dữ liệu ràng buộc của
 * request. Server kiểm chữ ký bằng `pos_devices.public_key`, thời điểm trong ±120 s, và ghi nonce (một lần) vào
 * `auth_challenges` (DEVICE_NONCE) — nonce dùng lại ⇒ từ chối.
 */
export const PROOF_VERSION = 'fruit-device-proof/v1';
export const PROOF_SKEW_S = 120;
/** hạn dòng nonce > cửa sổ thời điểm lớn nhất (ts có thể sớm hơn server PROOF_SKEW_S) ⇒ không xóa nonce còn dùng được */
export const NONCE_TTL_S = 5 * 60;

export type ProofPurpose = 'register' | 'pin' | 'refresh';

const b64url = (n: number, m = n) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${n},${m}}$`));
export const DeviceProofSchema = z
  .object({
    /** epoch giây theo đồng hồ thiết bị */
    ts: z.number().int().positive(),
    /** 16–32 byte ngẫu nhiên, base64url không đệm */
    nonce: b64url(22, 43),
    /** chữ ký Ed25519 64 byte, base64url không đệm */
    signature: b64url(86),
  })
  .strict();
export type DeviceProof = z.infer<typeof DeviceProofSchema>;

/** Chuỗi được ký — mỗi trường trên một dòng, không trường nào chứa xuống dòng (đã kiểm định dạng ở schema). */
export function proofMessage(
  purpose: ProofPurpose,
  deviceId: string,
  ts: number,
  nonce: string,
  binding: string,
): Buffer {
  return Buffer.from([PROOF_VERSION, purpose, deviceId.toLowerCase(), String(ts), nonce, binding].join('\n'), 'utf8');
}

/** Ràng buộc request: refresh ký trên SHA-256 của refresh token (không đưa token rõ vào thông điệp ký). */
export const refreshBinding = (refreshToken: string) =>
  createHash('sha256').update(refreshToken, 'utf8').digest('base64url');

export function verifyEd25519(publicKeyRaw: Uint8Array, message: Buffer, signatureB64url: string): boolean {
  const sig = Buffer.from(signatureB64url, 'base64url');
  if (sig.length !== 64 || publicKeyRaw.length !== 32) return false;
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyRaw).toString('base64url') },
      format: 'jwk',
    });
    return cryptoVerify(null, message, key, sig);
  } catch {
    return false;
  }
}

/**
 * Khóa công khai Ed25519 thô 32 byte, nạp được thành KeyObject. Node không kiểm điểm thuộc đường cong; tính hợp lệ thật
 * do chữ ký đăng ký bảo đảm (chứng minh giữ khóa riêng — khóa rác không ký được).
 */
export function isValidEd25519PublicKey(raw: Uint8Array): boolean {
  if (raw.length !== 32) return false;
  try {
    createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}

export const fingerprintOf = (publicKeyRaw: Uint8Array) =>
  new Uint8Array(createHash('sha256').update(publicKeyRaw).digest());

/**
 * Mã ghép đôi hiển thị trên thiết bị: 50 bit đầu của fingerprint, base32 (RFC 4648), dạng `XXXXX-XXXXX`. Người kích
 * hoạt nhập mã đọc từ màn hình máy (API danh sách KHÔNG trả mã này) ⇒ không kích hoạt nhầm thiết bị lạ trong hàng chờ.
 * 50 bit: tìm khóa trùng mã của một máy thật cần ~2^50 phép tính trong thời gian máy đó còn chờ (kiểm thử lát 4 L3).
 */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function pairingCode(fingerprint: Uint8Array): string {
  let bits = 0n;
  for (let i = 0; i < 7; i++) bits = (bits << 8n) | BigInt(fingerprint[i] ?? 0);
  bits >>= 6n; // 56 → 50 bit
  let out = '';
  for (let i = 9; i >= 0; i--) out += B32[Number((bits >> BigInt(i * 5)) & 31n)];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}
export const normalizePairingCode = (c: string) => c.toUpperCase().replace(/[\s-]/g, '');
