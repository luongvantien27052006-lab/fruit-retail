import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Argon2id (ADR-012) bằng `node:crypto.argon2` có sẵn trong Node 24 (không cần thư viện native). Lưu dạng chuỗi PHC
 * `$argon2id$v=19$m=…,t=…,p=…$<salt b64>$<hash b64>` để đổi tham số về sau mà hash cũ vẫn kiểm được.
 *
 * - `PASSWORD`: mật khẩu admin — m = 64 MiB, t = 3, p = 1 (≈ 100 ms; trên mức tối thiểu OWASP 19 MiB/t=2).
 * - `CODE`: mã khôi phục 2FA ngẫu nhiên ≥ 80 bit — không cần chống dò như mật khẩu người đặt, dùng m = 19 MiB, t = 2
 *   để kiểm 10 mã không tốn quá ~0,3 s.
 */
export const ARGON_PROFILES = {
  PASSWORD: { memory: 65_536, passes: 3, parallelism: 1 },
  CODE: { memory: 19_456, passes: 2, parallelism: 1 },
} as const;
interface Profile {
  memory: number;
  passes: number;
  parallelism: number;
}

const PHC_RE = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{16,})\$([A-Za-z0-9+/]{32,})$/;
const TAG_LEN = 32;
/** Giới hạn độ dài đầu vào (chống DoS bằng chuỗi cực dài; mật khẩu admin thật không dài vậy) */
export const MAX_SECRET_LEN = 256;

function run(message: string, nonce: Buffer, p: Profile, tagLength = TAG_LEN): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2('argon2id', { message, nonce, tagLength, ...p }, (err, out) => (err ? reject(err) : resolve(out))),
  );
}

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

export async function hashSecret(secret: string, profile: Profile = ARGON_PROFILES.PASSWORD): Promise<string> {
  if (secret.length > MAX_SECRET_LEN) throw new Error('chuỗi bí mật quá dài');
  const salt = randomBytes(16);
  const tag = await run(secret, salt, profile);
  return `$argon2id$v=19$m=${profile.memory},t=${profile.passes},p=${profile.parallelism}$${b64(salt)}$${b64(tag)}`;
}

/** So khớp thời gian hằng; chuỗi PHC hỏng ⇒ false (không ném) để luồng đăng nhập luôn trả cùng một lỗi. */
export async function verifySecret(stored: string, secret: string): Promise<boolean> {
  if (secret.length > MAX_SECRET_LEN) return false;
  const m = PHC_RE.exec(stored);
  if (!m) return false;
  const [, mem, t, p, salt, hash] = m as unknown as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64');
  const memory = Number(mem);
  // chặn tham số vô lý trong DB (ví dụ bị sửa tay) làm treo CPU/RAM
  if (memory < 8_192 || memory > 262_144 || Number(t) < 1 || Number(p) < 1 || Number(p) > 8) return false;
  const got = await run(
    secret,
    Buffer.from(salt, 'base64'),
    { memory, passes: Number(t), parallelism: Number(p) },
    expected.length,
  );
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Hash giả để luồng "không có tài khoản" tốn thời gian như luồng sai mật khẩu (không lộ email nào tồn tại). */
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashSecret(randomBytes(18).toString('base64'));
  return dummy;
}
