import type { NextRequest } from 'next/server';
import { forbidden, json } from '../../../../lib/server/respond';
import { clearAll, csrfOk } from '../../../../lib/server/session';
import { revoke } from '../../../../lib/server/upstream';

export const dynamic = 'force-dynamic';

/** Thu hồi phiên ở API rồi xóa mọi cookie (kể cả khi API lỗi — trình duyệt luôn sạch phiên). */
export async function POST(req: NextRequest) {
  if (!csrfOk(req)) return forbidden();
  await revoke(req).catch(() => undefined);
  const res = json(200, { ok: true });
  clearAll(res);
  return res;
}
