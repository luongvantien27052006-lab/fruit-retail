import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { MasterOnly, OwnTransaction, RequirePermission, RequireStepUp } from '../common/access';
import { ZodPipe } from '../common/zod.pipe';
import { AdminAccountsService } from './admin-accounts.service';

const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const CreateAdmin = z
  .object({
    email: z.string().min(3).max(254),
    role: z.enum(['MASTER_ADMIN', 'VIEW_ONLY_ADMIN']),
    viewer_profile_id: z.string().uuid().nullable().optional(),
  })
  .strict();
const iso = z.string().datetime({ offset: true });
const AuditQuery = z
  .object({
    action: z
      .string()
      .regex(/^[a-z_]+(\.[a-z_]+)+$/)
      .optional(),
    resource_type: z
      .string()
      .regex(/^[a-z_]{1,64}$/)
      .optional(),
    resource_id: z.string().max(128).optional(),
    actor_id: z.string().uuid().optional(),
    from: iso.optional(),
    to: iso.optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

/** Tài khoản admin, khóa/mở khóa, reset 2FA, phiên người khác, nhật ký (CP03 lát 8a — ADR-026). */
@Controller('admin')
export class AdminAccountsController {
  constructor(private readonly svc: AdminAccountsService) {}

  @RequirePermission('staff:write')
  @MasterOnly()
  @RequireStepUp()
  @OwnTransaction('băm mật khẩu tạm (Argon2) trước khi mở transaction — không giữ kết nối DB khi chờ suất băm')
  @Post('admin-accounts')
  @HttpCode(201)
  createAdmin(@Body(new ZodPipe(CreateAdmin)) b: z.infer<typeof CreateAdmin>) {
    return this.svc.createAdmin(b);
  }

  /** Master khóa mọi tài khoản; cửa hàng trưởng khóa nhân viên thu ngân/soạn hàng của cửa hàng mình (không có 2FA). */
  @RequirePermission('staff:write', { scope: 'store' })
  @RequireStepUp({
    staffExempt:
      'cửa hàng trưởng đăng nhập PIN trên máy POS, không có 2FA; chỉ KHÓA nhân viên của cửa hàng máy (mở khóa chỉ Master)',
  })
  @Post('users/:id/lock')
  @HttpCode(200)
  lock(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>) {
    return this.svc.lock(id, b.reason);
  }

  @RequirePermission('staff:write')
  @MasterOnly()
  @RequireStepUp()
  @Post('users/:id/unlock')
  @HttpCode(200)
  unlock(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>) {
    return this.svc.unlock(id, b.reason);
  }

  @RequirePermission('staff:write')
  @MasterOnly()
  @RequireStepUp()
  @Post('users/:id/2fa/reset')
  @HttpCode(200)
  resetTwoFactor(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>,
  ) {
    return this.svc.resetTwoFactor(id, b.reason);
  }

  @RequirePermission('staff:write')
  @MasterOnly()
  @Get('users/:id/sessions')
  sessions(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.sessionsOf(id);
  }

  @RequirePermission('staff:write')
  @MasterOnly()
  @Post('sessions/:id/revoke')
  @HttpCode(200)
  revokeSession(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>,
  ) {
    return this.svc.revokeSession(id, b.reason);
  }

  /** chỉ Master (G-d): nhật ký toàn chuỗi — không lọc phạm vi nên không cho quyền cấp riêng `audit:read` dùng */
  @RequirePermission('audit:read')
  @MasterOnly()
  @Get('audit-logs')
  auditLogs(@Query(new ZodPipe(AuditQuery)) q: z.infer<typeof AuditQuery>) {
    return this.svc.auditLogs(q);
  }
}
