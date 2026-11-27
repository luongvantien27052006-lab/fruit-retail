import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { publicOrigin } from './config';

/**
 * Cookie phiên của BFF (ADR-012, ADR-027). Trình duyệt KHÔNG BAO GIỜ thấy token: access/refresh/mfa_challenge nằm trong
 * cookie `__Host-` (Secure, Path=/, không Domain) HttpOnly + SameSite=Strict. CSRF: double-submit — cookie đọc được bởi
 * JS (không HttpOnly) phải trùng header `X-CSRF-Token` ở mọi request ghi, cộng kiểm Origin = ADMIN_ORIGIN.
 */
export const COOKIE = {
  access: '__Host-fa_at',
  refresh: '__Host-fa_rt',
  mfa: '__Host-fa_mfa',
  csrf: '__Host-fa_csrf',
} as const;

/** refresh admin: 12 giờ trượt (ADR-012) — cookie sống 12 giờ, API là nơi quyết định hạn thật */
const REFRESH_MAX_AGE_S = 12 * 3600;
/** access 15 phút; cookie hết sớm hơn token 30 s ⇒ BFF làm mới trước khi API trả 401 */
const ACCESS_MAX_AGE_S = 15 * 60 - 30;
const MFA_MAX_AGE_S = 5 * 60;

const base = { httpOnly: true, secure: true, sameSite: 'strict' as const, path: '/' };

/**
 * Định danh trình duyệt (review cổng CP03 TB4): gửi làm X-Device-Id khi tạo phiên ⇒ API nhận ra "cùng thiết bị" (sự kiện
 * auth.new_device_login chỉ phát khi trình duyệt THẬT SỰ mới; danh sách phiên có client_device). Ngẫu nhiên, HttpOnly,
 * sống lâu, KHÔNG xóa khi đăng xuất (không phải bí mật phiên — chỉ là nhãn thiết bị).
 */
export const DEVICE_COOKIE = '__Host-fa_dev';
const DEVICE_MAX_AGE_S = 400 * 24 * 3600;
const DEVICE_RE = /^[A-Za-z0-9_-]{32}$/;

/** Lấy định danh trình duyệt; chưa có / sai dạng ⇒ sinh mới (người gọi ghi cookie bằng `setDevice`). */
export function deviceOf(req: NextRequest): { id: string; fresh: boolean } {
  const v = req.cookies.get(DEVICE_COOKIE)?.value;
  if (v && DEVICE_RE.test(v)) return { id: v, fresh: false };
  return { id: randomBytes(24).toString('base64url'), fresh: true };
}

export function setDevice(res: NextResponse, d: { id: string; fresh: boolean }): void {
  if (d.fresh) res.cookies.set(DEVICE_COOKIE, d.id, { ...base, maxAge: DEVICE_MAX_AGE_S });
}

export interface TokenSet {
  access_token?: string;
  refresh_token?: string;
}

export function setTokens(res: NextResponse, t: TokenSet): void {
  if (t.access_token) res.cookies.set(COOKIE.access, t.access_token, { ...base, maxAge: ACCESS_MAX_AGE_S });
  if (t.refresh_token) res.cookies.set(COOKIE.refresh, t.refresh_token, { ...base, maxAge: REFRESH_MAX_AGE_S });
}

export function setMfa(res: NextResponse, challenge: string): void {
  res.cookies.set(COOKIE.mfa, challenge, { ...base, maxAge: MFA_MAX_AGE_S });
}

export function clearMfa(res: NextResponse): void {
  res.cookies.set(COOKIE.mfa, '', { ...base, maxAge: 0 });
}

/** CSRF mới mỗi lần có phiên — đọc được bởi JS (double-submit), vẫn Secure + SameSite=Strict */
export function issueCsrf(res: NextResponse, value = randomBytes(32).toString('base64url')): void {
  res.cookies.set(COOKIE.csrf, value, { ...base, httpOnly: false, maxAge: REFRESH_MAX_AGE_S });
}

/**
 * Review 8b lần 1 (TB): refresh trượt tới 7 ngày ⇒ cookie CSRF phải được gia hạn CÙNG cookie refresh, nếu không sau 12
 * giờ mọi thao tác ghi (kể cả đăng xuất) bị 403. Giữ NGUYÊN giá trị (request song song đã đọc giá trị cũ); thiếu ⇒ cấp mới.
 */
export function extendCsrf(res: NextResponse, req: NextRequest): void {
  issueCsrf(res, req.cookies.get(COOKIE.csrf)?.value || undefined);
}

export function clearAll(res: NextResponse): void {
  for (const name of Object.values(COOKIE))
    res.cookies.set(name, '', { ...base, httpOnly: name !== COOKIE.csrf, maxAge: 0 });
}

/**
 * Origin cùng nguồn: header Origin phải đúng ADMIN_ORIGIN; trình duyệt không gửi Origin thì Sec-Fetch-Site phải là
 * same-origin; không có cả hai (client không phải trình duyệt) ⇒ từ chối.
 */
export function originOk(req: NextRequest): boolean {
  const expected = publicOrigin();
  if (!expected) return false;
  const origin = req.headers.get('origin');
  if (origin) return origin === expected;
  return req.headers.get('sec-fetch-site') === 'same-origin';
}

/** Request ghi có phiên: Origin + header X-CSRF-Token trùng cookie CSRF (so hằng thời gian). */
export function csrfOk(req: NextRequest): boolean {
  if (!originOk(req)) return false;
  const header = Buffer.from(req.headers.get('x-csrf-token') ?? '', 'utf8');
  const cookie = Buffer.from(req.cookies.get(COOKIE.csrf)?.value ?? '', 'utf8');
  // so độ dài theo BYTE (ký tự nhiều byte làm timingSafeEqual ném RangeError ⇒ 500)
  if (!header.length || !cookie.length || header.length !== cookie.length) return false;
  return timingSafeEqual(header, cookie);
}

export interface SessionHint {
  sub: string;
  typ: string;
  amr: string[];
  stepUpUntil: number | null;
}

/**
 * Đọc payload access token (KHÔNG kiểm chữ ký) — CHỈ để giao diện chọn menu/điều hướng; mọi quyết định quyền nằm ở API
 * (token giả chỉ làm vỡ giao diện của chính người giả, API vẫn từ chối).
 */
export function decodeHint(token: string | undefined): SessionHint | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const p = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof p['sub'] !== 'string' || typeof p['typ'] !== 'string') return null;
    const su = p['step_up_until'];
    return {
      sub: p['sub'],
      typ: p['typ'],
      amr: Array.isArray(p['amr']) ? p['amr'].filter((x): x is string => typeof x === 'string') : [],
      stepUpUntil: typeof su === 'number' ? su : null,
    };
  } catch {
    return null;
  }
}
