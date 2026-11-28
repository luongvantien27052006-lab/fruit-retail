import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { MAX_BODY_BYTES } from './config';
import { clearAll, extendCsrf, setTokens } from './session';
import type { Upstream } from './upstream';

const NO_STORE = { 'cache-control': 'no-store' };

export function json(status: number, body: unknown): NextResponse {
  if (status === 204 || body === null) return new NextResponse(null, { status, headers: NO_STORE });
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export const forbidden = () => json(403, { code: 'ACTION_FORBIDDEN', message: 'Yêu cầu bị chặn (CSRF/Origin)' });
export const notFound = () => json(404, { code: 'RESOURCE_NOT_FOUND', message: 'Không có đường dẫn này' });
export const badRequest = (m: string) => json(400, { code: 'INVALID_REQUEST', message: m });

/** Đọc thân JSON có giới hạn kích thước; trả chuỗi (để chuyển tiếp nguyên văn) hoặc lỗi. */
export async function readBody(req: NextRequest): Promise<{ text: string } | { error: NextResponse }> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > MAX_BODY_BYTES) return { error: json(413, { code: 'INVALID_REQUEST', message: 'Dữ liệu quá lớn' }) };
  const ct = req.headers.get('content-type') ?? '';
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES)
    return { error: json(413, { code: 'INVALID_REQUEST', message: 'Dữ liệu quá lớn' }) };
  if (!text) return { text: '{}' };
  if (!ct.toLowerCase().startsWith('application/json')) return { error: badRequest('Cần application/json') };
  try {
    JSON.parse(text);
  } catch {
    return { error: badRequest('JSON không hợp lệ') };
  }
  return { text };
}

/** Chuyển kết quả upstream thành phản hồi: ghi token mới vào cookie, phiên chết ⇒ xóa cookie. */
export function fromUpstream(req: NextRequest, u: Upstream): NextResponse {
  return withSession(req, u, json(u.status, u.body));
}

/** Gắn kết quả phiên của upstream (token mới / phiên chết) vào một phản hồi bất kỳ. */
export function withSession(
  req: NextRequest,
  u: Pick<Upstream, 'tokens' | 'loggedOut'>,
  res: NextResponse,
): NextResponse {
  if (u.loggedOut) {
    clearAll(res);
    res.headers.set('x-session-ended', '1'); // client về /login (lỗi 401 khác — vd sai mã — không đá người dùng ra)
  } else {
    setTokens(res, u.tokens);
    if (u.tokens.refresh_token) extendCsrf(res, req);
  }
  return res;
}
