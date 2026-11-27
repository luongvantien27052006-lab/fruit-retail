import type { NextRequest } from 'next/server';
import { forbidden, fromUpstream, notFound, readBody } from '../../../../lib/server/respond';
import { csrfOk } from '../../../../lib/server/session';
import { upstream } from '../../../../lib/server/upstream';

export const dynamic = 'force-dynamic';

/**
 * Cổng API của trình duyệt: /bff/api/<đường dẫn API không có /v1>. CHỈ danh sách trắng dưới đây — BFF không phải proxy
 * mở (route công khai của app khách, webhook, POS… không đi qua đây). Mọi request ghi: Origin + double-submit CSRF.
 */
const SEG = '[A-Za-z0-9_~-][A-Za-z0-9._~-]*';
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const RULES: { methods: ReadonlySet<string>; re: RegExp }[] = [
  { methods: new Set(['POST']), re: /^\/auth\/(2fa\/setup|2fa\/confirm|2fa\/recovery-codes|step-up|password)$/ },
  { methods: new Set(['GET']), re: /^\/auth\/sessions$/ },
  { methods: new Set(['DELETE']), re: new RegExp(`^/auth/sessions/${UUID}$`) },
  { methods: new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']), re: new RegExp(`^/admin(/${SEG})+$`) },
  { methods: new Set(['GET']), re: new RegExp(`^/viewer(/${SEG})+$`) },
  { methods: new Set(['POST']), re: new RegExp(`^/viewer/notifications/${UUID}/read$`) },
];

const MAX_QUERY = 2048;

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  // segment đã được Next giải mã: chặn '/', '..', ký tự lạ ở từng đoạn rồi mới ghép
  if (!path.length || path.some((s) => !new RegExp(`^${SEG}$`).test(s))) return notFound();
  const p = `/${path.join('/')}`;
  const method = req.method.toUpperCase();
  if (!RULES.some((r) => r.methods.has(method) && r.re.test(p))) return notFound();
  if (method === 'GET') {
    const site = req.headers.get('sec-fetch-site');
    if (site && site !== 'same-origin') return forbidden();
  } else if (!csrfOk(req)) return forbidden();

  const search = req.nextUrl.search;
  if (search.length > MAX_QUERY) return notFound();
  let body: string | undefined;
  if (method !== 'GET' && method !== 'DELETE') {
    const b = await readBody(req);
    if ('error' in b) return b.error;
    body = b.text;
  }
  const key = req.headers.get('idempotency-key') ?? undefined;
  return fromUpstream(req, await upstream(req, `${p}${search}`, method, body, key));
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
