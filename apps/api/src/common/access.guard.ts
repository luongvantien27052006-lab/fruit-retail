import { type CanActivate, type ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { PRINCIPAL_RESOLVER, type PrincipalResolverPort } from '../auth/principal.resolver';
import { type Access, ACCESS_KEY, ALLOW_WITHOUT_MFA_KEY, STEP_UP_KEY } from './access';
import { AppError } from './errors';
import type { RequestStore } from './request-context';

/**
 * Guard toàn cục (deny-by-default):
 * - không khai báo quyền ⇒ 403;
 * - `@Public` / `@MfaChallenge` ⇒ cho qua, KHÔNG đọc Bearer (handler mfa tự kiểm token thử thách);
 * - còn lại: Bearer → Principal (đọc DB) — thiếu ⇒ 401;
 * - Master/Viewer chưa qua 2FA ⇒ chỉ route `@AllowWithoutMfa` (403 TWO_FACTOR_ENROLLMENT_REQUIRED — SEC1);
 * - `@RequireStepUp` cần `step_up_until` của phiên còn hạn (403 STEP_UP_REQUIRED — SEC2);
 * - `@RequirePermission` thiếu mã ⇒ 403.
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
    if (!principal.mfaComplete && !this.reflector.get<boolean>(ALLOW_WITHOUT_MFA_KEY, ctx.getHandler()))
      throw new AppError('TWO_FACTOR_ENROLLMENT_REQUIRED', 'Cần đăng ký xác thực 2 lớp trước khi dùng hệ thống');
    if (
      this.reflector.get<boolean>(STEP_UP_KEY, ctx.getHandler()) &&
      !(principal.stepUpUntil && principal.stepUpUntil.getTime() > Date.now())
    )
      throw new AppError('STEP_UP_REQUIRED', 'Cần xác thực lại mã 2FA cho thao tác này');
    if (access.kind === 'authenticated') return true;
    if (!principal.permissions.has(access.code))
      throw new AppError('ACTION_FORBIDDEN', 'Không có quyền thực hiện', { permission: access.code });
    return true;
  }
}
