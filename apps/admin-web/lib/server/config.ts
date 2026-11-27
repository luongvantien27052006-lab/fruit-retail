/** Địa chỉ API phía server (mạng nội bộ compose: http://api:3000). Không bao giờ lộ ra trình duyệt. */
export function apiBase(): string {
  const u = process.env['API_INTERNAL_URL'];
  if (!u) throw new Error('Thiếu API_INTERNAL_URL');
  return u.replace(/\/$/, '');
}

/**
 * Nguồn công khai của trang quản lý (vd https://staging.example.vn, local http://localhost:8080). Dùng kiểm Origin
 * (chống CSRF) — KHÔNG suy từ Host/X-Forwarded-* (giả được). Thiếu ⇒ mọi request ghi bị từ chối (đóng an toàn).
 */
export function publicOrigin(): string | null {
  const o = process.env['ADMIN_ORIGIN'];
  if (!o) return null;
  try {
    return new URL(o).origin;
  } catch {
    return null;
  }
}

/** Giới hạn thân request chuyển tiếp (JSON quản trị); tệp lớn đi presigned URL thẳng tới kho tệp */
export const MAX_BODY_BYTES = 256 * 1024;
