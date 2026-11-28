import { NextResponse, type NextRequest } from 'next/server';
import { forbidden, fromUpstream, notFound, withSession } from '../../../../lib/server/respond';
import { upstream } from '../../../../lib/server/upstream';

export const dynamic = 'force-dynamic';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** File mẫu nhập Excel (nhị phân — cổng JSON /bff/api không chuyển được). Tên file do BFF đặt, không lấy từ API. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ type: string }> }) {
  const { type } = await ctx.params;
  if (type !== 'CATALOG' && type !== 'SUPPLIER') return notFound();
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return forbidden();
  const u = await upstream(req, `/admin/imports/templates/${type}`, 'GET', undefined, undefined, true);
  if (!u.raw) return fromUpstream(req, u);
  if (!u.raw.type.startsWith(XLSX))
    return fromUpstream(req, {
      ...u,
      status: 502,
      body: { code: 'INTERNAL_ERROR', message: 'Phản hồi máy chủ không hợp lệ' },
    });
  const res = new NextResponse(new Uint8Array(u.raw.bytes), {
    status: 200,
    headers: {
      'content-type': XLSX,
      'content-disposition': `attachment; filename="mau-nhap-${type.toLowerCase()}.xlsx"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
  return withSession(req, u, res);
}
