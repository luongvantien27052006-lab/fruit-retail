import { toWire } from '@fruit/money_weight';

/**
 * Tách tên khóa thành token (snake_case, camelCase, kebab): `customerPhone` → [customer, phone],
 * `api_key` → [api, key], `shipping_fee` → [shipping, fee].
 */
export function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Một token đứng riêng là bí mật/PII (so khớp TRỌN token, không so chuỗi con — `shipping` không chứa `pin`). */
const SECRET_TOKENS = new Set([
  'password',
  'passwd',
  'pin',
  'secret',
  'token',
  'otp',
  'totp',
  'cookie',
  'authorization',
  'phone',
  'iban',
  'cvv',
  'enc',
  'hash',
]);
/** Cặp token liên tiếp là bí mật: api_key, account_number, bank_account, card_number, private_key */
const SECRET_PAIRS = new Set(['api key', 'account number', 'bank account', 'card number', 'private key', 'access key']);
/** Địa chỉ là PII khi thuộc khách/người nhận (địa chỉ cửa hàng/kho là thông tin công khai — vẫn ghi audit). */
const PERSON_ADDRESS_PREFIX = new Set(['customer', 'receiver', 'delivery', 'shipping', 'home', 'billing', 'recipient']);

export function isSensitiveKey(key: string): boolean {
  const t = keyTokens(key);
  if (t.some((x) => SECRET_TOKENS.has(x))) return true;
  for (let i = 0; i + 1 < t.length; i++) if (SECRET_PAIRS.has(`${t[i]} ${t[i + 1]}`)) return true;
  const ai = t.indexOf('address');
  return ai > 0 && t.slice(0, ai).some((x) => PERSON_ADDRESS_PREFIX.has(x));
}

function isPlainObject(v: object): boolean {
  const p = Object.getPrototypeOf(v) as unknown;
  return p === Object.prototype || p === null;
}

/**
 * Chuyển giá trị thành JSON thuần, xác định (ADR-016): bigint → chuỗi qua codec `toWire`, Date → ISO, Uint8Array →
 * "[BINARY]", undefined → bỏ. CHỈ nhận object thuần và mảng — Set/Map/class/đối tượng có toJSON ⇒ ném lỗi (không âm
 * thầm làm mất dữ liệu). Hàm/symbol/vòng lặp/số không hữu hạn ⇒ ném lỗi.
 * `mode`: 'raw' giữ nguyên khóa (response); 'redact' thay giá trị khóa bí mật bằng "[REDACTED]" (audit before/after);
 * 'reject' ném lỗi nếu có khóa bí mật (payload outbox — sự kiện chỉ mang ID/dữ liệu không nhạy cảm, ADR-015).
 */
export function toJsonSafe(
  value: unknown,
  mode: 'raw' | 'redact' | 'reject' = 'raw',
  seen = new WeakSet<object>(),
  path = '$',
): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'bigint':
      return toWire(value);
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`Số không hữu hạn tại ${path}: ${value}`);
      return value;
    case 'undefined':
      return undefined;
    case 'function':
    case 'symbol':
      throw new Error(`Không tuần tự hóa được ${typeof value} tại ${path}`);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error(`Date không hợp lệ tại ${path}`);
    return value.toISOString();
  }
  if (value instanceof Uint8Array) return '[BINARY]';
  const obj = value as object;
  if (!Array.isArray(obj) && !isPlainObject(obj))
    throw new Error(`Chỉ tuần tự hóa object thuần/mảng — gặp ${obj.constructor?.name ?? 'object'} tại ${path}`);
  if (seen.has(obj)) throw new Error(`Đối tượng có vòng lặp tại ${path}`);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return obj.map((v, i) => toJsonSafe(v, mode, seen, `${path}[${i}]`) ?? null);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (mode !== 'raw' && isSensitiveKey(k)) {
        if (mode === 'reject') throw new Error(`Khóa nhạy cảm "${k}" tại ${path} không được đưa vào sự kiện`);
        if (v !== null && v !== undefined) out[k] = '[REDACTED]';
        continue;
      }
      const s = toJsonSafe(v, mode, seen, `${path}.${k}`);
      if (s !== undefined) out[k] = s;
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}
