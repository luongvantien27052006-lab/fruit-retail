import { toWire } from '@fruit/money_weight';

/** Trường bí mật không bao giờ đi vào audit/outbox/response: thay bằng "[REDACTED]" (FR-INV-18, ADR-015). */
const SECRET_KEY_RE = /(password|pin|secret|token|otp|_enc$|_hash$|^phone$|^address$|authorization|cookie)/i;

/**
 * Chuyển giá trị bất kỳ thành JSON thuần, xác định (ADR-016): bigint → chuỗi qua codec `toWire`, Date → ISO,
 * Buffer/Uint8Array → bị che, undefined → bỏ. Từ chối hàm/symbol/vòng lặp (ném lỗi, không âm thầm).
 * `redact` = true: thay giá trị của khóa bí mật bằng "[REDACTED]" (dùng cho audit before/after, payload outbox).
 */
export function toJsonSafe(value: unknown, redact = false, seen = new WeakSet<object>()): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'bigint':
      return toWire(value);
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`Số không hữu hạn: ${value}`);
      return value;
    case 'undefined':
      return undefined;
    case 'function':
    case 'symbol':
      throw new Error(`Không tuần tự hóa được ${typeof value}`);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('Date không hợp lệ');
    return value.toISOString();
  }
  if (value instanceof Uint8Array) return '[BINARY]';
  const obj = value as object;
  if (seen.has(obj)) throw new Error('Đối tượng có vòng lặp');
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return obj.map((v) => toJsonSafe(v, redact, seen) ?? null);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (redact && SECRET_KEY_RE.test(k)) {
        if (v !== null && v !== undefined) out[k] = '[REDACTED]';
        continue;
      }
      const s = toJsonSafe(v, redact, seen);
      if (s !== undefined) out[k] = s;
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}
