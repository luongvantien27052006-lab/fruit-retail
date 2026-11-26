/**
 * Gọi BFF từ trình duyệt. Token KHÔNG có ở đây (cookie HttpOnly); chỉ đọc cookie CSRF để gửi double-submit.
 * 401 ⇒ về /login. 403 STEP_UP_REQUIRED ⇒ hỏi mã 2FA (StepUpProvider) rồi gọi lại MỘT lần cùng Idempotency-Key.
 */
export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

export class ApiFailure extends Error {
  constructor(readonly error: ApiError) {
    super(error.message);
  }
}

type StepUpPrompt = () => Promise<boolean>;
let stepUpPrompt: StepUpPrompt | null = null;
export function registerStepUp(fn: StepUpPrompt | null): void {
  stepUpPrompt = fn;
}

function csrf(): string {
  const m = document.cookie.split('; ').find((c) => c.startsWith('__Host-fa_csrf='));
  return m ? decodeURIComponent(m.slice('__Host-fa_csrf='.length)) : '';
}

function newKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function raw(url: string, method: string, body: unknown, key: string | undefined): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers['x-csrf-token'] = csrf();
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers['idempotency-key'] = key;
  return fetch(url, {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function parse(r: Response): Promise<unknown> {
  if (r.status === 204) return null;
  const t = await r.text();
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
}

function toError(status: number, b: unknown): ApiError {
  const o = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
  return {
    status,
    code: typeof o['code'] === 'string' ? o['code'] : 'INTERNAL_ERROR',
    message: typeof o['message'] === 'string' ? o['message'] : 'Có lỗi xảy ra — thử lại',
    details: o['details'],
  };
}

/** Gọi /bff/<url>. `path` dạng "/api/admin/staff" hoặc "/auth/login". */
export async function bff<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const url = `/bff${path}`;
  const key = method === 'POST' || method === 'DELETE' || method === 'PATCH' || method === 'PUT' ? newKey() : undefined;
  let r = await raw(url, method, method === 'GET' || method === 'DELETE' ? undefined : (body ?? {}), key);
  let b = await parse(r);
  if (r.status === 403 && toError(r.status, b).code === 'STEP_UP_REQUIRED' && stepUpPrompt) {
    if (await stepUpPrompt()) {
      r = await raw(url, method, method === 'GET' || method === 'DELETE' ? undefined : (body ?? {}), key);
      b = await parse(r);
    }
  }
  if (r.status === 401 && path.startsWith('/api/')) {
    window.location.assign('/login');
    throw new ApiFailure(toError(401, b));
  }
  if (!r.ok) throw new ApiFailure(toError(r.status, b));
  return b as T;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiFailure) return e.error.message;
  return 'Không kết nối được — thử lại';
}
