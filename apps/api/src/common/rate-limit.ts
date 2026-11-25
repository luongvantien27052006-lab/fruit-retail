import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { ipBucket, type Limit, RateLimiter } from '../infra/rate-limiter.service';
import type { RequestStore } from './request-context';

export const RATE_LIMIT_KEY = 'fruit:rate-limit';

/** Một dòng chính sách: theo IP (IPv6 gộp /64) hoặc theo X-Device-Id. */
export interface PolicyRule {
  by: 'ip' | 'device';
  max: number;
  windowS: number;
}
export type RatePolicies = Readonly<Record<string, readonly PolicyRule[]>>;
export const RATE_POLICIES = Symbol('RATE_POLICIES');

/**
 * Giới hạn theo nguồn cho route xác thực công khai (CP03 lát 5, ADR-023). Ngưỡng theo IP rộng vì cả cửa hàng (POS) và
 * thuê bao di động (CGNAT) có thể chung một IP — lớp chặn chính vẫn là khóa theo tài khoản (SEC5) và giới hạn theo SĐT.
 * Chặn ở guard (trước transaction, trước nhật ký) ⇒ request vượt ngưỡng không ghi DB / login_logs (L6 lát 4).
 */
export const DEFAULT_RATE_POLICIES: RatePolicies = {
  'auth.login': [
    { by: 'ip', max: 30, windowS: 60 },
    { by: 'ip', max: 300, windowS: 3600 },
  ],
  'auth.mfa': [{ by: 'ip', max: 30, windowS: 60 }],
  'auth.step_up': [{ by: 'ip', max: 30, windowS: 60 }],
  'auth.pin': [
    { by: 'ip', max: 120, windowS: 60 },
    { by: 'device', max: 30, windowS: 60 },
  ],
  'auth.device_register': [
    { by: 'ip', max: 10, windowS: 3600 },
    { by: 'device', max: 5, windowS: 3600 },
  ],
  'auth.refresh': [{ by: 'ip', max: 300, windowS: 60 }],
  'auth.otp_request': [{ by: 'ip', max: 30, windowS: 60 }],
  'auth.otp_verify': [{ by: 'ip', max: 60, windowS: 60 }],
};

export const RateLimit = (policy: keyof typeof DEFAULT_RATE_POLICIES & string): MethodDecorator =>
  SetMetadata(RATE_LIMIT_KEY, policy);

/** Guard toàn cục: route có `@RateLimit(tên)` bị giới hạn theo chính sách; Redis lỗi ⇒ cho qua (có khóa DB phía sau). */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
    private readonly cls: ClsService<RequestStore>,
    @Inject(RATE_POLICIES) private readonly policies: RatePolicies,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const name = this.reflector.get<string | undefined>(RATE_LIMIT_KEY, ctx.getHandler());
    if (!name) return true;
    const rules = this.policies[name];
    if (!rules) throw new Error(`Thiếu chính sách giới hạn ${name}`);
    const ip = ipBucket(this.cls.get('ip'));
    const device = this.cls.get('deviceId');
    const limits: Limit[] = [];
    for (const r of rules) {
      if (r.by === 'device' && !device) continue; // thiếu X-Device-Id: route tự trả 400
      limits.push({ name, id: r.by === 'ip' ? ip : `dev:${device ?? ''}`, max: r.max, windowS: r.windowS });
    }
    await this.limiter.apply(limits, { failOpen: true });
    return true;
  }
}
