import { NextResponse, type NextRequest } from 'next/server';
import { publicOrigin } from './lib/server/config';
import { COOKIE, clearAll, decodeHint, extendCsrf, setTokens } from './lib/server/session';
import { refreshOnce } from './lib/server/upstream';

/**
 * Proxy (Next 16, Node runtime) cho MỌI trang:
 * 1. CSP nonce mỗi request (thay 'unsafe-inline' của Caddy) — Next tự gắn nonce vào script của nó.
 * 2. Điều hướng đăng nhập: không có phiên ⇒ /login; access hết hạn mà còn refresh ⇒ làm mới ngay tại đây (trang server
 *    component không ghi được cookie) rồi chuyển token mới vào request đang xử lý.
 * 3. Phiên chưa có 2FA (amr thiếu otp/rcv) chỉ vào được /enroll.
 * Chỉ là lớp giao diện: quyền thật do API kiểm trên mỗi lần gọi.
 */
const PUBLIC = ['/login'];

function csp(nonce: string): string {
  const dev = process.env.NODE_ENV === 'development';
  const https = publicOrigin()?.startsWith('https://') ?? false;
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

const isPublic = (p: string) => PUBLIC.some((x) => p === x || p.startsWith(`${x}/`));

export async function proxy(req: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64');
  const policy = csp(nonce);
  const path = req.nextUrl.pathname;

  let fresh: { access_token?: string; refresh_token?: string } | null = null;
  const redirect = (to: string, clear = false) => {
    const url = req.nextUrl.clone();
    url.pathname = to;
    url.search = '';
    const r = NextResponse.redirect(url, 303);
    if (clear) clearAll(r);
    // review 8b: refresh cũ đã bị API tiêu ⇒ token mới PHẢI về trình duyệt cả khi điều hướng
    else if (fresh) {
      setTokens(r, fresh);
      extendCsrf(r, req);
    }
    r.headers.set('Content-Security-Policy', policy);
    return r;
  };

  let access = req.cookies.get(COOKIE.access)?.value;
  const refresh = req.cookies.get(COOKIE.refresh)?.value;

  if (!access && refresh) {
    const rf = await refreshOnce(req, refresh);
    if (rf.ok && rf.tokens.access_token) {
      fresh = rf.tokens;
      access = rf.tokens.access_token;
      req.cookies.set(COOKIE.access, access);
      if (rf.tokens.refresh_token) req.cookies.set(COOKIE.refresh, rf.tokens.refresh_token);
    } else if (rf.dead && !isPublic(path)) return redirect('/login', true);
    else if (!rf.ok && !isPublic(path)) {
      // lỗi tạm (429/5xx): phiên có thể vẫn sống — KHÔNG đá về /login (đăng nhập lại sẽ tạo phiên thừa)
      const r = new NextResponse(
        '<!doctype html><html lang="vi"><meta charset="utf-8"><title>Tạm thời gián đoạn</title><body><p>Máy chủ tạm thời không phản hồi. Tải lại trang sau vài giây.</p></body></html>',
        {
          status: 503,
          headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5', 'cache-control': 'no-store' },
        },
      );
      r.headers.set('Content-Security-Policy', policy);
      return r;
    }
  }

  const hint = decodeHint(access);
  if (!isPublic(path)) {
    if (!hint) return redirect('/login');
    const full = hint.amr.includes('otp') || hint.amr.includes('rcv');
    if (!full && path !== '/enroll') return redirect('/enroll');
    if (full && path === '/enroll') return redirect('/');
  } else if (hint && (hint.amr.includes('otp') || hint.amr.includes('rcv'))) {
    return redirect('/'); // đã đăng nhập đủ thì không cần trang login
  }

  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', policy);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('Content-Security-Policy', policy);
  res.headers.set('Cache-Control', 'no-store');
  if (fresh) {
    setTokens(res, fresh);
    extendCsrf(res, req);
  }
  return res;
}

export const config = {
  matcher: [
    {
      source: '/((?!bff/|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
