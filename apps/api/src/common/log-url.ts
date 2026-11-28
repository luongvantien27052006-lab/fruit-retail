/**
 * Che giá trị nhạy cảm trong URL trước khi ghi log (review bảo mật cổng CP04: tìm NCC theo SĐT ⇒ `?q=0901234567` lọt log
 * dạng rõ, trái ADR-015). Giữ đường dẫn + tên tham số (lần vết); che giá trị của tham số chữ tự do / định danh, và mọi
 * giá trị có ≥ 7 chữ số (kể cả có dấu phân cách — SĐT, STK, mã vạch…). Tên tham số so SAU khi giải mã (`%71` = `q`).
 */
const MASK_KEYS = new Set(['q', 'phone', 'code', 'email', 'name', 'search']);
/** ≥ 7 chữ số, cho phép dấu phân cách . - ( ) khoảng trắng xen giữa (090.123.4567) */
const DIGITS = /\d(?:[\s.()-]*\d){6,}/;

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};

export function safeUrl(url: unknown): unknown {
  if (typeof url !== 'string') return url;
  const i = url.indexOf('?');
  if (i < 0) return url;
  const query = url
    .slice(i + 1)
    .split('&')
    .map((kv) => {
      const j = kv.indexOf('=');
      if (j < 0) return kv;
      const rawKey = kv.slice(0, j);
      const k = decode(rawKey);
      const v = decode(kv.slice(j + 1));
      return MASK_KEYS.has(k.toLowerCase()) || DIGITS.test(v) ? `${rawKey}=[redacted]` : kv;
    })
    .join('&');
  return `${url.slice(0, i)}?${query}`;
}
