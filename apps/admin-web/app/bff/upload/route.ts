import { createHash, randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { json, forbidden, fromUpstream, withSession } from '../../../lib/server/respond';
import { COOKIE, csrfOk, type TokenSet } from '../../../lib/server/session';
import { upstream } from '../../../lib/server/upstream';

export const dynamic = 'force-dynamic';

/**
 * Tải file lên kho S3 THAY trình duyệt (CP04 lát 7): trình duyệt gửi nguyên byte tới đây; BFF tính sha256, gọi
 * /files/presign, PUT lên URL ký sẵn, rồi /files/{id}/complete (server API tự tải lại + kiểm định dạng theo byte đầu).
 * Lý do: CSP của trang giữ `connect-src 'self'` (không mở ra origin của kho S3, không cần CORS ở kho).
 * Chỉ các loại file trang quản lý dùng; giới hạn kích thước TRƯỚC khi đọc hết thân.
 */
const KINDS: Record<string, { mimes: readonly string[]; maxBytes: number }> = {
  IMPORT_XLSX: {
    mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    maxBytes: 5 * 1024 * 1024,
  },
  BRAND_LOGO: { mimes: ['image/png', 'image/jpeg'], maxBytes: 1024 * 1024 },
};

const tooBig = (max: number) =>
  json(413, { code: 'INVALID_REQUEST', message: `File tối đa ${max / (1024 * 1024)} MB`, details: { field: 'bytes' } });

/** Đọc thân theo luồng, dừng ngay khi vượt trần (không tin Content-Length). */
async function readLimited(req: NextRequest, max: number): Promise<Buffer | null> {
  const reader = req.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

export async function POST(req: NextRequest) {
  if (!csrfOk(req)) return forbidden();
  const kind = req.nextUrl.searchParams.get('kind') ?? '';
  const rule = Object.hasOwn(KINDS, kind) ? KINDS[kind] : undefined;
  if (!rule)
    return json(400, { code: 'INVALID_REQUEST', message: 'Loại file không hợp lệ', details: { field: 'kind' } });
  const mime = (req.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!rule.mimes.includes(mime))
    return json(400, {
      code: 'INVALID_REQUEST',
      message: `Loại file này chỉ nhận ${rule.mimes.join(', ')}`,
      details: { field: 'mime' },
    });
  if (Number(req.headers.get('content-length') ?? '0') > rule.maxBytes) return tooBig(rule.maxBytes);
  const bytes = await readLimited(req, rule.maxBytes);
  if (!bytes) return tooBig(rule.maxBytes);
  if (!bytes.length) return json(400, { code: 'INVALID_REQUEST', message: 'File rỗng', details: { field: 'bytes' } });

  // token mới (nếu lượt đầu phải làm mới) dùng cho các lượt sau — refresh token chỉ dùng MỘT lần
  let tokens: TokenSet = {};
  const step = async (path: string, body: unknown) => {
    // Idempotency-Key mỗi bước (hợp đồng ghi bắt buộc cho presign / complete — review react cổng CP04 T4)
    const u = await upstream(req, path, 'POST', JSON.stringify(body), randomBytes(18).toString('base64url'));
    if (u.tokens.access_token) req.cookies.set(COOKIE.access, u.tokens.access_token);
    if (u.tokens.refresh_token) req.cookies.set(COOKIE.refresh, u.tokens.refresh_token);
    tokens = { ...tokens, ...u.tokens };
    return { ...u, tokens };
  };

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const pre = await step('/files/presign', { kind, mime, bytes: bytes.length, sha256, capture_source: 'GALLERY' });
  if (pre.status !== 200) return fromUpstream(req, pre);
  const p = pre.body as { id?: unknown; upload_url?: unknown };
  const url = typeof p.upload_url === 'string' ? p.upload_url : '';
  if (typeof p.id !== 'string' || !/^https?:\/\//.test(url))
    return withSession(req, pre, json(502, { code: 'INTERNAL_ERROR', message: 'Phản hồi máy chủ không hợp lệ' }));

  let put: Response | null;
  try {
    put = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': mime },
      body: new Uint8Array(bytes),
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    put = null;
  }
  if (!put?.ok)
    return withSession(
      req,
      pre,
      json(503, { code: 'DEPENDENCY_UNAVAILABLE', message: 'Không tải được file lên kho lưu trữ — thử lại sau' }),
    );

  return fromUpstream(req, await step(`/files/${p.id}/complete`, {}));
}
