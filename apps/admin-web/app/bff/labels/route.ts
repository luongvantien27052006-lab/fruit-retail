import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { withSession } from '../../../lib/server/respond';
import { csrfTokenOk } from '../../../lib/server/session';
import { upstream } from '../../../lib/server/upstream';

export const dynamic = 'force-dynamic';

/**
 * Trang tem giá kệ (CP04 lát 7). Màn /labels gửi FORM POST (target = iframe) tới đây; BFF gọi POST /admin/shelf-labels và
 * trả HTML của API làm TÀI LIỆU RIÊNG của iframe với CSP riêng:
 * - không script (`default-src 'none'`), không form, không base;
 * - `sandbox allow-same-origin allow-modals`: KHÔNG allow-scripts ⇒ không mã nào chạy trong khung; allow-same-origin chỉ để
 *   trang cha gọi `contentWindow.print()`; allow-modals để hộp in mở được;
 * - `frame-ancestors 'self'`: chỉ nhúng được trong trang quản lý.
 * Không dùng `srcdoc` / blob: vì tài liệu đó kế thừa CSP nonce của trang cha ⇒ chặn `<style>` của tem.
 * CSRF: Origin + mã CSRF trong trường form (form POST không đặt được header).
 */
const FRAME_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-same-origin allow-modals',
].join('; ');

const MAX_PAYLOAD = 64 * 1024;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function page(status: number, html: Uint8Array | string): NextResponse {
  return new NextResponse(typeof html === 'string' ? html : new Uint8Array(html), {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': FRAME_CSP,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

/** Trang lỗi nhỏ hiện TRONG khung (chữ đã thoát) */
const errorPage = (status: number, msg: string) =>
  page(
    status,
    `<!doctype html><html lang="vi"><meta charset="utf-8"><title>Lỗi</title><body style="font:14px system-ui;padding:16px"><p role="alert">${esc(msg)}</p></body></html>`,
  );

export async function POST(req: NextRequest) {
  const ct = (req.headers.get('content-type') ?? '').toLowerCase();
  if (!ct.startsWith('application/x-www-form-urlencoded')) return errorPage(400, 'Yêu cầu không hợp lệ');
  if (Number(req.headers.get('content-length') ?? '0') > MAX_PAYLOAD) return errorPage(413, 'Quá nhiều tem');
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_PAYLOAD) return errorPage(413, 'Quá nhiều tem');
  const form = new URLSearchParams(text);
  if (!csrfTokenOk(req, form.get('csrf'), true)) return errorPage(403, 'Yêu cầu bị chặn (CSRF/Origin) — tải lại trang');
  const payload = form.get('payload') ?? '';
  try {
    const p: unknown = JSON.parse(payload);
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('payload');
  } catch {
    return errorPage(400, 'Yêu cầu không hợp lệ');
  }
  // Idempotency-Key do BFF sinh: hợp đồng ghi tham số này cho mọi POST quản trị (API hiện chưa bắt buộc)
  const key = randomBytes(18).toString('base64url');
  const u = await upstream(req, '/admin/shelf-labels', 'POST', payload, key, true);
  if (u.loggedOut) return withSession(req, u, errorPage(401, 'Phiên đã hết — đăng nhập lại'));
  if (!u.raw || !u.raw.type.toLowerCase().startsWith('text/html')) {
    const b = (u.body && typeof u.body === 'object' ? u.body : {}) as { message?: unknown };
    const msg = typeof b.message === 'string' ? b.message : 'Không tạo được trang tem — thử lại';
    return withSession(req, u, errorPage(u.status >= 400 ? u.status : 502, msg));
  }
  const res = page(200, u.raw.bytes);
  return withSession(req, u, res);
}
