/**
 * Che giá trị nhạy cảm trong URL trước khi ghi log (review bảo mật cổng CP04: tìm NCC theo SĐT ⇒ `?q=0901234567` lọt log
 * dạng rõ, trái ADR-015). Giữ đường dẫn + tên tham số (lần vết); che giá trị của tham số chữ tự do / định danh, và mọi
 * giá trị có ≥ 7 chữ số liên tiếp (SĐT, STK, mã vạch…).
 */
const MASK_KEYS = new Set(['q', 'phone', 'code', 'email', 'name', 'search']);
const DIGITS = /\d{7,}/;

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
      const k = kv.slice(0, j);
      let v = kv.slice(j + 1);
      try {
        v = decodeURIComponent(v.replace(/\+/g, ' '));
      } catch {
        /* giữ nguyên */
      }
      return MASK_KEYS.has(k.toLowerCase()) || DIGITS.test(v) ? `${k}=[redacted]` : kv;
    })
    .join('&');
  return `${url.slice(0, i)}?${query}`;
}
