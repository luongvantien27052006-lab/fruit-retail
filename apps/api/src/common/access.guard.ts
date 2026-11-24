import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { type Access, ACCESS_KEY } from './access';
import { AppError } from './errors';
import type { RequestStore } from './request-context';

/** Guard toàn cục: không khai báo quyền ⇒ chặn (403); thiếu đăng nhập ⇒ 401; thiếu mã quyền ⇒ 403. */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly log = new Logger('AccessGuard');

  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const access = this.reflector.getAllAndOverride<Access | undefined>(ACCESS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!access) {
      // Không thể xảy ra nếu assertRoutesDeclareAccess chạy lúc khởi động — vẫn chặn để an toàn
      this.log.error(`route không khai báo quyền: ${ctx.getClass().name}.${ctx.getHandler().name}`);
      throw new AppError('ACTION_FORBIDDEN', 'Route chưa khai báo quyền');
    }
    if (access.kind === 'public') return true;
    const principal = this.cls.get('principal');
    if (!principal) throw new AppError('AUTHENTICATION_REQUIRED', 'Cần đăng nhập');
    if (access.kind === 'authenticated') return true;
    if (!principal.permissions.has(access.code))
      throw new AppError('ACTION_FORBIDDEN', 'Không có quyền thực hiện', { permission: access.code });
    return true;
  }
}
