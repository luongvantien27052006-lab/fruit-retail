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

/** Route chỉ nhận token thử thách 2FA từ /auth/login (`x-permission: mfa:challenge`) — không có Principal. */
export const MFA_CHALLENGE_PERMISSION = 'mfa:challenge';
/** Route đi được khi phiên Master/Viewer CHƯA hoàn tất 2FA (đăng ký TOTP lần đầu, đăng xuất). Mặc định: chặn. */
export const ALLOW_WITHOUT_MFA_KEY = 'fruit:allow-without-mfa';
/** Route cần xác thực lại ≤ 5 phút (`x-step-up`, SEC2). */
export const STEP_UP_KEY = 'fruit:step-up';
/** Route tự quản transaction (vd đăng nhập: lần sai phải được ghi dù request trả lỗi) — MutationInterceptor bỏ qua. */
export const OWN_TX_KEY = 'fruit:own-tx';

export type Access =
  { kind: 'public' } | { kind: 'mfa' } | { kind: 'authenticated' } | { kind: 'permission'; code: string };

const PERMISSION_RE = /^[a-z_]+:[a-z_]+$/;

export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ACCESS_KEY, { kind: 'public' } satisfies Access);
export const Authenticated = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ACCESS_KEY, { kind: 'authenticated' } satisfies Access);
export const MfaChallenge = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ACCESS_KEY, { kind: 'mfa' } satisfies Access);
export function RequirePermission(code: string): MethodDecorator & ClassDecorator {
  if (!PERMISSION_RE.test(code)) throw new Error(`Mã quyền sai định dạng: ${code}`);
  return applyDecorators(SetMetadata(ACCESS_KEY, { kind: 'permission', code } satisfies Access));
}
export function NoAudit(reason: string): MethodDecorator {
  if (reason.trim().length < 10) throw new Error('@NoAudit cần lý do rõ ràng (≥ 10 ký tự)');
  return SetMetadata(NO_AUDIT_KEY, reason);
}

export const AllowWithoutMfa = (): MethodDecorator => SetMetadata(ALLOW_WITHOUT_MFA_KEY, true);
export const RequireStepUp = (): MethodDecorator => SetMetadata(STEP_UP_KEY, true);
/**
 * Handler tự mở transaction (`txHost.withTransaction`) và tự ghi nhật ký. Chỉ dùng cho luồng xác thực, nơi lần thử sai
 * phải được lưu (đếm sai, khóa tạm, thu hồi họ token) trong khi request vẫn trả lỗi.
 */
export function OwnTransaction(reason: string): MethodDecorator {
  if (reason.trim().length < 10) throw new Error('@OwnTransaction cần lý do rõ ràng (≥ 10 ký tự)');
  return SetMetadata(OWN_TX_KEY, reason);
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
  /** phương thức xác thực của phiên (đọc từ DB): pwd, otp, rcv */
  amr: readonly string[];
  /** Master/Viewer đã qua 2FA trong phiên này (amr có otp hoặc rcv); STAFF/CUSTOMER luôn true */
  mfaComplete: boolean;
  stepUpUntil?: Date;
}
