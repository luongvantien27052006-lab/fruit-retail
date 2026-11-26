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

/** Tách token khỏi body (không bao giờ đưa token cho trình duyệt). */
export function stripTokens(body: unknown): { body: unknown; tokens: TokenSet } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { body, tokens: {} };
  const rest = { ...(body as Record<string, unknown>) };
  const access = rest['access_token'];
  const refresh = rest['refresh_token'];
  delete rest['access_token'];
  delete rest['refresh_token'];
  delete rest['mfa_challenge'];
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
 * vừa hết hạn ⇒ tất cả mang CÙNG refresh cookie. Gộp (single-flight) theo token: lần đầu gọi API, các lần sau (kể cả
 * tới muộn ≤ 60 s, trước khi trình duyệt kịp nhận cookie mới) dùng lại kết quả. Bộ nhớ trong tiến trình — admin-web chạy
 * MỘT bản (ADR-027); nhân bản ⇒ phải chuyển sang Redis.
 */
const REFRESH_REUSE_MS = 60_000;
/** dead = API từ chối hẳn (401) ⇒ đăng xuất; lỗi tạm (429/5xx) KHÔNG giữ trong bộ đệm và không đăng xuất */
type Refreshed = { ok: boolean; dead: boolean; status: number; body: unknown; tokens: TokenSet };
// globalThis: proxy.ts và route handler là hai bundle khác nhau trong CÙNG tiến trình — phải dùng chung một bản đồ
const g = globalThis as typeof globalThis & { __faRefresh?: Map<string, { at: number; p: Promise<Refreshed> }> };
const inflight = (g.__faRefresh ??= new Map());

export function refreshOnce(req: NextRequest, token: string): Promise<Refreshed> {
  const now = Date.now();
  for (const [k, v] of inflight) if (now - v.at > REFRESH_REUSE_MS) inflight.delete(k);
  const hit = inflight.get(token);
  if (hit) return hit.p;
  const p = call(req, '/auth/refresh', { method: 'POST', body: JSON.stringify({ refresh_token: token }) }).then(
    (rf): Refreshed => {
      const ok = rf.status === 200;
      const dead = rf.status === 400 || rf.status === 401 || rf.status === 403;
      if (!ok && !dead) inflight.delete(token);
      return { ok, dead, status: rf.status, body: rf.body, tokens: ok ? stripTokens(rf.body).tokens : {} };
    },
  );
  inflight.set(token, { at: now, p });
  return p;
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
  const s = stripTokens(r.body);
  const loggedOut = r.status === 401 && codeOf(r.body) === 'SESSION_REVOKED';
  return { status: r.status, body: s.body, tokens: { ...tokens, ...s.tokens }, loggedOut };
}

/** Gọi route xác thực công khai (login, 2fa verify/recover) — Bearer chỉ là mfa_challenge nếu có. */
export async function publicCall(req: NextRequest, path: string, body: unknown, bearer?: string) {
  return call(req, path, { method: 'POST', body: JSON.stringify(body), bearer });
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
