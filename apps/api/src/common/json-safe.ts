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

/** Số nhiều tiếng Anh → số ít để so token (`phones` → `phone`, `tokens` → `token`, `addresses` → `address`). */
function singular(t: string): string {
  if (t.length > 4 && t.endsWith('sses')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

/** Một token đứng riêng là bí mật/PII (so khớp TRỌN token sau khi bỏ số nhiều — `shipping` không chứa `pin`). */
const SECRET_TOKENS = new Set([
  'password',
  'passwd',
  'passcode',
  'passphrase',
  'pin',
  'secret',
  'token',
  'otp',
  'totp',
  'cookie',
  'authorization',
  'phone',
  'sdt',
  'iban',
  'cvv',
  'enc',
  'hash',
  // địa chỉ: MẶC ĐỊNH là PII (địa chỉ khách/người nhận — ADR-015); địa chỉ cửa hàng/kho xem PUBLIC_ADDRESS_PREFIX
  'address',
  'diachi',
]);
/** Cặp token liên tiếp là bí mật: api_key, account_number, so_dien_thoai, dia_chi… */
const SECRET_PAIRS = new Set([
  'api key',
  'account number',
  'account no',
  'bank account',
  'card number',
  'private key',
  'access key',
  'dien thoai',
  'mobile number',
  'mobile no',
  'mobile phone',
  'dia chi',
]);
/** Địa chỉ CÔNG KHAI (cửa hàng, kho) — không che khi có tiền tố này: `store_address`, `warehouse_address`. */
const PUBLIC_ADDRESS_PREFIX = new Set(['store', 'warehouse', 'branch', 'shop']);
/** Băm KHÔNG bí mật (nội dung file) — được phép giữ: `content_hash`, `file_hash`. */
const PUBLIC_HASH_PREFIX = new Set(['content', 'file', 'checksum']);

/**
 * Khóa có phải bí mật/PII không (mặc định chặt: nghi ngờ ⇒ che). Route ghi audit dữ liệu công khai mang khóa trùng tên
 * (vd `address` của cửa hàng) truyền `publicKeys` vào recordAudit.
 */
export function isSensitiveKey(key: string): boolean {
  const t = keyTokens(key).map(singular);
  for (let i = 0; i < t.length; i++) {
    const x = t[i] as string;
    // `mobile` đứng cuối khóa (mobile, customer_mobile) là SĐT; `mobile_app_version` thì không
    if (x === 'mobile' && i === t.length - 1) return true;
    if (!SECRET_TOKENS.has(x)) continue;
    const prev = t.slice(0, i);
    if (x === 'address' && prev.some((p) => PUBLIC_ADDRESS_PREFIX.has(p))) continue;
    if (x === 'hash' && prev.some((p) => PUBLIC_HASH_PREFIX.has(p))) continue;
    return true;
  }
  for (let i = 0; i + 1 < t.length; i++) if (SECRET_PAIRS.has(`${t[i]} ${t[i + 1]}`)) return true;
  return false;
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
 * `keep`: tên khóa ở CẤP GỐC được giữ dù trùng mẫu nhạy cảm — vd `address` khi audit cửa hàng (khóa lồng vẫn bị che).
 */
const NO_KEEP: ReadonlySet<string> = new Set();
export function toJsonSafe(
  value: unknown,
  mode: 'raw' | 'redact' | 'reject' = 'raw',
  keep: ReadonlySet<string> = NO_KEEP,
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
    if (Array.isArray(obj)) return obj.map((v, i) => toJsonSafe(v, mode, keep, seen, `${path}[${i}]`) ?? null);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (mode !== 'raw' && !(path === '$' && keep.has(k)) && isSensitiveKey(k)) {
        if (mode === 'reject') throw new Error(`Khóa nhạy cảm "${k}" tại ${path} không được đưa vào sự kiện`);
        if (v !== null && v !== undefined) out[k] = '[REDACTED]';
        continue;
      }
      const s = toJsonSafe(v, mode, keep, seen, `${path}.${k}`);
      if (s !== undefined) out[k] = s;
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}
