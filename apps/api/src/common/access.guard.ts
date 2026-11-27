import { type CanActivate, type ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { PRINCIPAL_RESOLVER, type PrincipalResolverPort } from '../auth/principal.resolver';
import { type Access, ACCESS_KEY, ALLOW_WITHOUT_MFA_KEY, MASTER_ONLY_KEY, STEP_UP_KEY } from './access';
import { AppError } from './errors';
import type { RequestStore } from './request-context';

/**
 * Guard toàn cục (deny-by-default):
 * - không khai báo quyền ⇒ 403;
 * - `@Public` / `@MfaChallenge` ⇒ cho qua, KHÔNG đọc Bearer (handler mfa tự kiểm token thử thách);
 * - còn lại: Bearer → Principal (đọc DB) — thiếu ⇒ 401;
 * - Master/Viewer chưa qua 2FA ⇒ chỉ route `@AllowWithoutMfa` (403 TWO_FACTOR_ENROLLMENT_REQUIRED — SEC1);
 * - `@RequireStepUp` cần `step_up_until` của phiên còn hạn (403 STEP_UP_REQUIRED — SEC2);
 * - `@RequirePermission` thiếu mã ⇒ 403;
 * - `@MasterOnly` (x-master-only): chỉ tài khoản MASTER;
 * - cô lập Viewer (§2.5, ADR-024, T16): tài khoản VIEWER chỉ gọi được /v1/viewer/* và /v1/auth/*; /v1/viewer/* chỉ cho
 *   VIEWER đã gán đúng MỘT hồ sơ, và trong route đó mọi truy vấn qua pool app_rw bị chặn (chỉ ViewerDb / viewer_ro).
 */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly log = new Logger('AccessGuard');

  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService<RequestStore>,
    @Inject(PRINCIPAL_RESOLVER) private readonly resolver: PrincipalResolverPort,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<Access | undefined>(ACCESS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!access) {
      // Không thể xảy ra nếu assertRoutesDeclareAccess chạy lúc khởi động — vẫn chặn để an toàn
      this.log.error(`route không khai báo quyền: ${ctx.getClass().name}.${ctx.getHandler().name}`);
      throw new AppError('ACTION_FORBIDDEN', 'Route chưa khai báo quyền');
    }
    if (access.kind === 'public' || access.kind === 'mfa') return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const principal = await this.resolver.resolve(req.headers.authorization);
    if (!principal) throw new AppError('AUTHENTICATION_REQUIRED', 'Cần đăng nhập');
    this.cls.set('principal', principal);
    const routePath = String((req.route as { path?: unknown } | undefined)?.path ?? req.path);
    const under = (base: string) => routePath === base || routePath.startsWith(`${base}/`);
    const viewerRoute = under('/v1/viewer');
    if (principal.userType === 'VIEWER' && !viewerRoute && !under('/v1/auth'))
      throw new AppError('ACTION_FORBIDDEN', 'Tài khoản xem chỉ dùng được màn hình báo cáo');
    if (viewerRoute) {
      if (principal.userType !== 'VIEWER')
        throw new AppError('ACTION_FORBIDDEN', 'Route báo cáo chỉ dành cho tài khoản xem');
      if (!principal.viewerProfileId)
        throw new AppError('ACTION_FORBIDDEN', 'Tài khoản xem chưa được gán đúng một hồ sơ xem');
      this.cls.set('appDbBlocked', true);
    }
    if (!principal.mfaComplete && !this.reflector.get<boolean>(ALLOW_WITHOUT_MFA_KEY, ctx.getHandler()))
      throw new AppError('TWO_FACTOR_ENROLLMENT_REQUIRED', 'Cần đăng ký xác thực 2 lớp trước khi dùng hệ thống');
    // step-up (SEC2) = nhập lại mã 2FA ⇒ chỉ áp cho tài khoản có 2FA (Master/Viewer). Nhân viên (PIN trên máy POS đã kích
    // hoạt) không có 2FA nên không có step-up; route nhân viên được gọi đều có phạm vi cửa hàng + vai trò hẹp (ADR-024).
    const stepUp = this.reflector.get<{ staffExempt?: string } | undefined>(STEP_UP_KEY, ctx.getHandler());
    const has2fa = principal.userType === 'MASTER' || principal.userType === 'VIEWER';
    if (stepUp && !has2fa && !stepUp.staffExempt)
      throw new AppError('STEP_UP_REQUIRED', 'Thao tác này cần tài khoản có xác thực 2 lớp');
    if (stepUp && has2fa && !(principal.stepUpUntil && principal.stepUpUntil.getTime() > Date.now()))
      throw new AppError('STEP_UP_REQUIRED', 'Cần xác thực lại mã 2FA cho thao tác này');
    if (this.reflector.get<boolean>(MASTER_ONLY_KEY, ctx.getHandler()) && principal.userType !== 'MASTER')
      throw new AppError('ACTION_FORBIDDEN', 'Chỉ Master được thực hiện');
    if (access.kind === 'authenticated') return true;
    if (!principal.permissions.has(access.code))
      throw new AppError('ACTION_FORBIDDEN', 'Không có quyền thực hiện', { permission: access.code });
    return true;
  }
}
