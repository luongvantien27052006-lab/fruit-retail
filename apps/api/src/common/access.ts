import { applyDecorators, SetMetadata } from '@nestjs/common';

/**
 * Khai báo quyền truy cập cho MỌI route (deny-by-default — kế hoạch CP03 cổng "route không khai báo permission → bị
 * chặn"). Đúng một trong: `@Public()`, `@Authenticated()` (mọi người đã đăng nhập — `auth:*`),
 * `@RequirePermission('mã')` (mã §19.6/§21.8, khớp `x-permission` của OpenAPI). Thiếu ⇒ app KHÔNG khởi động
 * (assertRoutesDeclareAccess) và guard trả 403 nếu lọt.
 */
export const ACCESS_KEY = 'fruit:access';
/** Mutation không ghi audit.logs phải nói rõ lý do (vd đăng nhập ghi audit.login_logs bằng audit_writer). */
export const NO_AUDIT_KEY = 'fruit:no-audit';

export type Access = { kind: 'public' } | { kind: 'authenticated' } | { kind: 'permission'; code: string };

const PERMISSION_RE = /^[a-z_]+:[a-z_]+$/;

export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ACCESS_KEY, { kind: 'public' } satisfies Access);
export const Authenticated = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ACCESS_KEY, { kind: 'authenticated' } satisfies Access);
export function RequirePermission(code: string): MethodDecorator & ClassDecorator {
  if (!PERMISSION_RE.test(code)) throw new Error(`Mã quyền sai định dạng: ${code}`);
  return applyDecorators(SetMetadata(ACCESS_KEY, { kind: 'permission', code } satisfies Access));
}
export function NoAudit(reason: string): MethodDecorator {
  if (reason.trim().length < 10) throw new Error('@NoAudit cần lý do rõ ràng (≥ 10 ký tự)');
  return SetMetadata(NO_AUDIT_KEY, reason);
}

/** Người gọi đã xác thực (đặt vào CLS bởi tầng xác thực — CP03 lát 3/4/5). */
export interface Principal {
  userId: string;
  userType: 'MASTER' | 'VIEWER' | 'STAFF' | 'CUSTOMER';
  sessionId: string;
  /** Mã quyền hiệu lực (vai trò + cấp riêng), tra từ DB mỗi request (ADR-012: không nhúng quyền vào token) */
  permissions: ReadonlySet<string>;
  /** Vai trò chính để ghi audit */
  role?: string;
  posDeviceId?: string;
}
