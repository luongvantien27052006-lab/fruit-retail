import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import type { Env } from '../config/env';

/**
 * Khóa của tầng xác thực, đọc một lần lúc API khởi động (ADR-012, ADR-015, ADR-021). Thiếu/sai định dạng ⇒ ném lỗi,
 * API không khởi động (FR-INV-17 — không có khóa mặc định). Không bao giờ in giá trị khóa trong lỗi.
 *
 * - `JWT_SIGNING_KEYS` = `kid:base64(PKCS#8 DER Ed25519),kid:…` — khóa CUỐI là khóa ký; mọi khóa trong danh sách
 *   đều dùng để kiểm (xoay khóa: thêm khóa mới vào cuối, đợi ≥ 15 phút rồi bỏ khóa cũ).
 * - `PII_ENC_KEYS` = `id:base64(32 byte),…` — id 1..65535; khóa ghi = id lớn nhất; khóa cũ chỉ để giải mã.
 * - `PII_HASH_PEPPER` = base64 ≥ 32 byte — HMAC tra cứu (email/SĐT đăng nhập trong login_logs, ip_hash).
 */
export interface AuthKeys {
  jwt: { signKid: string; sign: KeyObject; verify: ReadonlyMap<string, KeyObject> };
  pii: { writeId: number; keys: ReadonlyMap<number, Buffer> };
  pepper: Buffer;
}

export const AUTH_KEYS = Symbol('AUTH_KEYS');

const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const B64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

function entries(name: string, raw: string | undefined): [string, Buffer][] {
  if (!raw?.trim()) throw new Error(`Thiếu ${name}`);
  const out: [string, Buffer][] = [];
  for (const part of raw.split(',')) {
    const i = part.indexOf(':');
    const id = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    if (i <= 0 || !B64_RE.test(val)) throw new Error(`${name}: mục thứ ${out.length + 1} sai định dạng id:base64`);
    out.push([id, Buffer.from(val, val.includes('-') || val.includes('_') ? 'base64url' : 'base64')]);
  }
  if (new Set(out.map(([k]) => k)).size !== out.length) throw new Error(`${name}: id trùng`);
  return out;
}

export function loadAuthKeys(env: Env): AuthKeys {
  const verify = new Map<string, KeyObject>();
  let signKid = '';
  let sign: KeyObject | undefined;
  for (const [kid, der] of entries('JWT_SIGNING_KEYS', env.JWT_SIGNING_KEYS)) {
    if (!KID_RE.test(kid)) throw new Error('JWT_SIGNING_KEYS: kid chỉ gồm [A-Za-z0-9_-], ≤ 32 ký tự');
    let key: KeyObject;
    try {
      key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    } catch {
      throw new Error(`JWT_SIGNING_KEYS: khóa ${kid} không phải PKCS#8 DER`);
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error(`JWT_SIGNING_KEYS: khóa ${kid} phải là Ed25519`);
    verify.set(kid, createPublicKey(key));
    signKid = kid;
    sign = key;
  }
  const keys = new Map<number, Buffer>();
  for (const [id, key] of entries('PII_ENC_KEYS', env.PII_ENC_KEYS)) {
    const n = Number(id);
    if (!/^\d{1,5}$/.test(id) || n < 1 || n > 65535) throw new Error('PII_ENC_KEYS: id phải là số 1..65535');
    if (key.length !== 32) throw new Error(`PII_ENC_KEYS: khóa ${id} phải đúng 32 byte`);
    keys.set(n, key);
  }
  const pepperRaw = env.PII_HASH_PEPPER?.trim();
  if (!pepperRaw || !B64_RE.test(pepperRaw)) throw new Error('Thiếu hoặc sai PII_HASH_PEPPER (base64)');
  const pepper = Buffer.from(pepperRaw, 'base64');
  if (pepper.length < 32) throw new Error('PII_HASH_PEPPER phải ≥ 32 byte');
  if (!sign) throw new Error('Thiếu JWT_SIGNING_KEYS');
  return { jwt: { signKid, sign, verify }, pii: { writeId: Math.max(...keys.keys()), keys }, pepper };
}
