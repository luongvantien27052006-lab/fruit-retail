const fmt = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  dateStyle: 'short',
  timeStyle: 'short',
});

export function dt(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : fmt.format(d);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const vnd = new Intl.NumberFormat('vi-VN');

/** "52000" ⇒ "52.000đ"; null ⇒ "—" */
export function money(v: string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  return /^-?\d+$/.test(v) ? `${vnd.format(BigInt(v))}đ` : '—';
}

/** Ô nhập tiền: bỏ dấu chấm / khoảng trắng / "đ"; trả chuỗi số nguyên không âm, rỗng ⇒ null, sai ⇒ undefined. */
export function parseMoney(s: string): string | null | undefined {
  const t = s.replace(/[.\s,đ₫]/gi, '');
  if (!t) return null;
  if (!/^\d{1,15}$/.test(t)) return undefined;
  return String(BigInt(t));
}

/** Số nguyên từ ô nhập; rỗng ⇒ null; sai ⇒ undefined */
export function parseIntOrNull(s: string): number | null | undefined {
  const t = s.trim();
  if (!t) return null;
  if (!/^-?\d{1,9}$/.test(t)) return undefined;
  return Number(t);
}
