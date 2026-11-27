import type { NextRequest } from 'next/server';
import { forbidden, json } from '../../../../lib/server/respond';
import { clearAll, originOk } from '../../../../lib/server/session';
import { revoke } from '../../../../lib/server/upstream';

export const dynamic = 'force-dynamic';

/**
 * Thu hồi phiên ở API rồi xóa mọi cookie (kể cả khi API lỗi — trình duyệt luôn sạch phiên). Chỉ kiểm Origin, KHÔNG đòi
 * double-submit: đăng xuất phải luôn chạy được (cookie CSRF hết hạn/mất không được giữ phiên sống trên máy dùng chung);
 * logout CSRF tối đa làm người dùng phải đăng nhập lại. Origin lạ ⇒ 403 nhưng vẫn xóa cookie phía trình duyệt.
 */
export async function POST(req: NextRequest) {
  if (!originOk(req)) {
    const res = forbidden();
    clearAll(res);
    return res;
  }
  await revoke(req).catch(() => undefined);
  const res = json(200, { ok: true });
  clearAll(res);
  return res;
}
