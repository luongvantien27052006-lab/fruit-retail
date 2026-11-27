import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { apiBase } from './config';
import { COOKIE, type TokenSet } from './session';

export interface Upstream {
  status: number;
  body: unknown;
  /** token mới nếu API cấp (refresh / step-up / 2fa confirm) — BFF ghi vào cookie, không trả cho trình duyệt */
  tokens: TokenSet;
  /** phiên chết (refresh bị từ chối / SESSION_REVOKED) ⇒ BFF xóa cookie */
  loggedOut: boolean;
}

interface CallInit {
  method: string;
  body?: string | undefined;
  bearer?: string | undefined;
  idempotencyKey?: string | undefined;
  /** X-Device-Id = định danh trình duyệt (chỉ khi tạo phiên: login / 2FA) */
  deviceId?: string | undefined;
}

const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Header chuyển tiếp — CHỈ danh sách trắng: request id (lần vết), User-Agent (danh sách phiên), X-Forwarded-For (Caddy
 * đặt; API tin chuỗi proxy nội bộ), Idempotency-Key. Không chuyển Cookie/Authorization của trình duyệt.
 */
function forwardHeaders(req: NextRequest, init: CallInit): Headers {
  const h = new Headers({ accept: 'application/json' });
  if (init.body !== undefined) h.set('content-type', 'application/json');
  if (init.bearer) h.set('authorization', `Bearer ${init.bearer}`);
  const ua = req.headers.get('user-agent');
  if (ua) h.set('user-agent', ua.slice(0, 512));
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) h.set('x-forwarded-for', fwd);
  const rid = req.headers.get('x-request-id');
  if (rid && REQUEST_ID_RE.test(rid)) h.set('x-request-id', rid);
  if (init.idempotencyKey && IDEMPOTENCY_RE.test(init.idempotencyKey)) h.set('idempotency-key', init.idempotencyKey);
  if (init.deviceId) h.set('x-device-id', init.deviceId);
  return h;
}

async function call(req: NextRequest, path: string, init: CallInit): Promise<{ status: number; body: unknown }> {
  let r: Response;
  try {
    r = await fetch(`${apiBase()}/v1${path}`, {
      method: init.method,
      headers: forwardHeaders(req, init),
      ...(init.body !== undefined ? { body: init.body } : {}),
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return {
      status: 503,
      body: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Không kết nối được máy chủ — thử lại sau' },
    };
  }
  if (r.status === 204) return { status: 204, body: null };
  const text = await r.text();
  try {
    return { status: r.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: 502, body: { code: 'INTERNAL_ERROR', message: 'Phản hồi máy chủ không hợp lệ' } };
  }
}

const SECRET_KEYS = new Set(['access_token', 'refresh_token', 'mfa_challenge']);

/** Bỏ khóa token ở MỌI cấp (kể cả lồng trong mảng/đối tượng) — không bao giờ đưa token cho trình duyệt. */
function scrub(v: unknown, depth = 0): unknown {
  if (!v || typeof v !== 'object') return v;
  if (depth > 32) return undefined; // lồng quá sâu ⇒ bỏ cả nhánh (không trả nguyên — có thể chứa token)
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  // không prototype: khóa "__proto__" là thuộc tính thường, không đổi prototype của out
  const out = Object.create(null) as Record<string, unknown>;
  for (const [k, x] of Object.entries(v as Record<string, unknown>))
    if (!SECRET_KEYS.has(k)) out[k] = scrub(x, depth + 1);
  return out;
}

/**
 * Tách token khỏi body. CHỈ các route xác thực đã biết mới được đặt token phiên (review 8b: một endpoint admin vô tình trả
 * trường `access_token` không được thay phiên của trình duyệt); route khác ⇒ token bị bỏ, không dùng.
 */
export const TOKEN_ISSUERS = new Set(['/auth/refresh', '/auth/step-up', '/auth/2fa/confirm']);

export function stripTokens(body: unknown, accept = true): { body: unknown; tokens: TokenSet } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { body: scrub(body), tokens: {} };
  const top = body as Record<string, unknown>;
  const access = accept ? top['access_token'] : undefined;
  const refresh = accept ? top['refresh_token'] : undefined;
  const rest = scrub(top);
  return {
    body: rest,
    tokens: {
      ...(typeof access === 'string' ? { access_token: access } : {}),
      ...(typeof refresh === 'string' ? { refresh_token: refresh } : {}),
    },
  };
}

/**
 * Refresh token dùng MỘT lần; dùng lại ⇒ API thu hồi cả phiên (SEC4). Trình duyệt bắn song song nhiều request khi access
 * vừa hết hạn ⇒ tất cả mang CÙNG refresh cookie. Gộp (single-flight) theo SHA-256 của token: lần đầu gọi API, các lần sau
 * trong 15 s (đủ cho loạt request song song, ngắn để không làm yếu phát hiện dùng lại) dùng lại kết quả THÀNH CÔNG; lỗi
 * xóa ngay khi xong. Mục tự xóa bằng timer; trần 2000 mục, đầy ⇒ đẩy mục cũ nhất (không bao giờ bỏ gộp). Bộ nhớ trong tiến trình — admin-web chạy MỘT bản (ADR-027).
 */
const REFRESH_REUSE_MS = 15_000;
const MAX_ENTRIES = 2000;
/** dead = API từ chối hẳn (401) ⇒ đăng xuất; lỗi tạm (429/5xx) KHÔNG giữ trong bộ đệm và không đăng xuất */
type Refreshed = { ok: boolean; dead: boolean; status: number; body: unknown; tokens: TokenSet };
// globalThis: proxy.ts và route handler là hai bundle khác nhau trong CÙNG tiến trình — phải dùng chung một bản đồ
const g = globalThis as typeof globalThis & { __faRefresh?: Map<string, { at: number; p: Promise<Refreshed> }> };
const inflight = (g.__faRefresh ??= new Map());

export function refreshOnce(req: NextRequest, refreshToken: string): Promise<Refreshed> {
  const token = createHash('sha256').update(refreshToken).digest('base64url');
  const now = Date.now();
  const hit = inflight.get(token);
  if (hit && now - hit.at <= REFRESH_REUSE_MS) return hit.p;
  if (hit) inflight.delete(token);
  // review 8b lần 2: KHÔNG bao giờ bỏ qua bước gộp khi đầy (token rác làm đầy ⇒ refresh thật bị gọi trùng ⇒ API thu
  // hồi phiên). Map giữ thứ tự chèn ⇒ đẩy mục cũ nhất ra.
  while (inflight.size >= MAX_ENTRIES) {
    const oldest = inflight.keys().next().value;
    if (oldest === undefined) break;
    inflight.delete(oldest);
  }
  const p = doRefresh(req, refreshToken).then((r) => {
    // chỉ giữ kết quả THÀNH CÔNG (để request song song tới muộn dùng lại); lỗi/token rác xóa ngay khi xong
    if (!r.ok && inflight.get(token)?.p === p) inflight.delete(token);
    return r;
  });
  inflight.set(token, { at: now, p });
  setTimeout(() => {
    if (inflight.get(token)?.p === p) inflight.delete(token);
  }, REFRESH_REUSE_MS).unref();
  return p;
}

function doRefresh(req: NextRequest, refreshToken: string): Promise<Refreshed> {
  return call(req, '/auth/refresh', { method: 'POST', body: JSON.stringify({ refresh_token: refreshToken }) }).then(
    (rf): Refreshed => {
      const ok = rf.status === 200;
      const dead = rf.status === 400 || rf.status === 401 || rf.status === 403;
      return { ok, dead, status: rf.status, body: scrub(rf.body), tokens: ok ? stripTokens(rf.body).tokens : {} };
    },
  );
}

const codeOf = (b: unknown) => (b && typeof b === 'object' ? (b as { code?: unknown }).code : undefined);

/**
 * Gọi API bằng access token trong cookie; access hết hạn/thiếu (401 AUTHENTICATION_REQUIRED) mà còn refresh ⇒ làm mới
 * MỘT lần rồi gọi lại. Refresh bị từ chối ⇒ `loggedOut`.
 */
export async function upstream(
  req: NextRequest,
  path: string,
  method: string,
  body?: string,
  idempotencyKey?: string,
): Promise<Upstream> {
  const access = req.cookies.get(COOKIE.access)?.value;
  const refresh = req.cookies.get(COOKIE.refresh)?.value;
  const base = { method, body, idempotencyKey };
  let tokens: TokenSet = {};
  let r = access ? await call(req, path, { ...base, bearer: access }) : null;
  const expired = !r || (r.status === 401 && codeOf(r.body) === 'AUTHENTICATION_REQUIRED');
  if (expired) {
    if (!refresh)
      return {
        status: 401,
        body: { code: 'AUTHENTICATION_REQUIRED', message: 'Cần đăng nhập' },
        tokens: {},
        loggedOut: true,
      };
    const rf = await refreshOnce(req, refresh);
    if (!rf.ok) return { status: rf.dead ? 401 : rf.status, body: rf.body, tokens: {}, loggedOut: rf.dead };
    tokens = rf.tokens;
    r = await call(req, path, { ...base, bearer: tokens.access_token });
  }
  if (!r) throw new Error('unreachable');
  const s = stripTokens(r.body, TOKEN_ISSUERS.has(path.split('?')[0] ?? ''));
  // SESSION_REVOKED, hoặc 401 AUTHENTICATION_REQUIRED NGAY SAU khi đã refresh thành công (access mới vẫn bị từ chối) ⇒
  // phiên chết thật — xóa cookie, client về /login (review cổng CP03)
  const loggedOut =
    r.status === 401 &&
    (codeOf(r.body) === 'SESSION_REVOKED' || (codeOf(r.body) === 'AUTHENTICATION_REQUIRED' && expired));
  return { status: r.status, body: s.body, tokens: { ...tokens, ...s.tokens }, loggedOut };
}

/** Gọi route xác thực công khai (login, 2fa verify/recover) — Bearer chỉ là mfa_challenge nếu có. */
export async function publicCall(req: NextRequest, path: string, body: unknown, bearer?: string, deviceId?: string) {
  return call(req, path, { method: 'POST', body: JSON.stringify(body), bearer, deviceId });
}

/** Thu hồi phiên ở API khi đăng xuất (bỏ qua lỗi — cookie vẫn bị xóa). */
export async function revoke(req: NextRequest): Promise<void> {
  const access = req.cookies.get(COOKIE.access)?.value;
  if (access) {
    const r = await call(req, '/auth/logout', { method: 'POST', body: '{}', bearer: access });
    if (r.status !== 401) return;
  }
  // access hết hạn: làm mới để lấy access rồi thu hồi
  const refresh = req.cookies.get(COOKIE.refresh)?.value;
  if (!refresh) return;
  const rf = await refreshOnce(req, refresh);
  if (rf.ok && rf.tokens.access_token)
    await call(req, '/auth/logout', { method: 'POST', body: '{}', bearer: rf.tokens.access_token });
}
