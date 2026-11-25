import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { MasterOnly, OwnTransaction, type Principal, RequirePermission, RequireStepUp } from '../common/access';
import { AuditOutboxService, type Tx } from '../common/audit-outbox.service';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { STAFF_CODE_RE } from '../auth/auth.controller';
import { STAFF_ROLES, StaffAdminService, type StaffRole } from './staff-admin.service';

// ngày lịch thật (không nhận 2026-13-01, 2026-02-30)
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'ngày YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'ngày không tồn tại');
const RoleSpec = z
  .object({
    role: z.enum(STAFF_ROLES as [StaffRole, ...StaffRole[]]),
    store_id: z.string().uuid().nullable().optional(),
    warehouse_id: z.string().uuid().nullable().optional(),
  })
  .strict();
const CreateStaff = z
  .object({
    staff_code: z.string().regex(STAFF_CODE_RE, 'mã nhân viên'),
    full_name: z.string().trim().min(1).max(100),
    pin: z.string().regex(/^\d{6}$/, 'PIN 6 chữ số'),
    hired_at: date.nullable().optional(),
    role: RoleSpec,
  })
  .strict();
const UpdateStaff = z
  .object({
    full_name: z.string().trim().min(1).max(100).optional(),
    hired_at: date.nullable().optional(),
    left_at: date.nullable().optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    pin: z
      .string()
      .regex(/^\d{6}$/, 'PIN 6 chữ số')
      .optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'cần ít nhất một trường');
const AssignRole = RoleSpec.extend({ user_id: z.string().uuid() }).strict();

const LIMIT_ROLES = ['MASTER_ADMIN', 'STORE_MANAGER', 'CASHIER', 'PICKER', 'WAREHOUSE_STAFF', 'SHIPPER'] as const;
const LIMIT_ACTIONS = [
  'LINE_DELETE',
  'SALE_VOID',
  'REFUND',
  'SPOILAGE_APPROVE',
  'STOCKTAKE_ADJUST',
  'MANUAL_WEIGHT',
  'NO_SALE_OPEN',
  'MARKDOWN',
] as const;
const LimitItem = z
  .object({
    role: z.enum(LIMIT_ROLES),
    action: z.enum(LIMIT_ACTIONS),
    allowed: z.boolean(),
    max_amount: z.number().int().min(0).max(1_000_000_000_000).nullable(),
    max_pct_bp: z.number().int().min(0).max(10_000).nullable(),
    limit_mode: z.enum(['ANY', 'ALL']).default('ANY'),
    same_day_only: z.boolean().default(false),
    requires_pin: z.boolean().default(false),
    requires_note: z.boolean().default(false),
  })
  .strict();
const PutLimits = z.object({ items: z.array(LimitItem).min(1).max(50) }).strict();

const OWN_TX_PIN = 'băm PIN (Argon2) trước khi mở transaction — không giữ kết nối DB khi chờ suất băm';

/** /v1/admin/staff, /v1/admin/role-assignments, /v1/admin/approval-limits — RBAC theo phạm vi (CP03 lát 6, ADR-024). */
@Controller('admin')
export class AdminController {
  constructor(
    private readonly staff: StaffAdminService,
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly ao: AuditOutboxService,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  private principal(): Principal {
    const p = this.cls.get('principal');
    if (!p) throw new AppError('AUTHENTICATION_REQUIRED', 'Cần đăng nhập');
    return p;
  }

  @RequirePermission('staff:write', { scope: 'store' })
  @Get('staff')
  listStaff() {
    return this.staff.list();
  }

  /** gán vai trò kèm khi tạo ⇒ cùng rào với /admin/role-assignments: role:assign + step-up (kiểm thử lát 6 L3) */
  @RequirePermission('staff:write', { scope: 'store' })
  @RequireStepUp({
    staffExempt:
      'cửa hàng trưởng đăng nhập PIN trên máy POS đã kích hoạt, không có 2FA; chỉ gán CASHIER/PICKER ở cửa hàng của máy',
  })
  @OwnTransaction(OWN_TX_PIN)
  @Post('staff')
  @HttpCode(201)
  createStaff(@Body(new ZodPipe(CreateStaff)) b: z.infer<typeof CreateStaff>) {
    return this.staff.create(b);
  }

  @RequirePermission('staff:write', { scope: 'store' })
  @Get('staff/:id')
  getStaff(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.staff.get(id);
  }

  @RequirePermission('staff:write', { scope: 'store' })
  @OwnTransaction(OWN_TX_PIN)
  @Patch('staff/:id')
  updateStaff(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(UpdateStaff)) b: z.infer<typeof UpdateStaff>,
  ) {
    return this.staff.update(id, b);
  }

  /** x-step-up: áp cho tài khoản có 2FA (Master); nhân viên (cửa hàng trưởng, PIN trên máy POS) không có step-up — ADR-024 */
  @RequirePermission('role:assign', { scope: 'store' })
  @RequireStepUp({
    staffExempt:
      'cửa hàng trưởng đăng nhập PIN trên máy POS đã kích hoạt, không có 2FA; chỉ gán CASHIER/PICKER ở cửa hàng của máy',
  })
  @Post('role-assignments')
  @HttpCode(201)
  assignRole(@Body(new ZodPipe(AssignRole)) b: z.infer<typeof AssignRole>) {
    return this.staff.assignRole(b);
  }

  @RequirePermission('role:assign', { scope: 'store' })
  @RequireStepUp({
    staffExempt:
      'cửa hàng trưởng đăng nhập PIN trên máy POS đã kích hoạt, không có 2FA; chỉ gán CASHIER/PICKER ở cửa hàng của máy',
  })
  @Delete('role-assignments/:id')
  @HttpCode(204)
  async revokeRole(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.staff.revokeRole(id);
  }

  /** Hạn mức duyệt §2.3 — chỉ Master, cần step-up. CHECK DB chặn cấu hình đã bỏ (NC-19(d), NC-21). */
  @RequirePermission('settings:write')
  @MasterOnly()
  @RequireStepUp()
  @Put('approval-limits')
  async putLimits(@Body(new ZodPipe(PutLimits)) b: z.infer<typeof PutLimits>) {
    const p = this.principal();
    const tx = this.txHost.tx;
    const keys = new Set<string>();
    for (const i of b.items) {
      const k = `${i.role}:${i.action}`;
      if (keys.has(k)) throw new AppError('INVALID_REQUEST', `Trùng dòng ${k}`);
      keys.add(k);
      if (!i.allowed && (i.max_amount !== null || i.max_pct_bp !== null))
        throw new AppError('INVALID_REQUEST', 'Dòng không cho phép thì không có ngưỡng', { item: k });
    }
    // khóa theo thứ tự cố định role:action ⇒ hai PUT song song không khóa chéo nhau (40P01)
    const items = [...b.items].sort((x, y) => `${x.role}:${x.action}`.localeCompare(`${y.role}:${y.action}`));
    const out = [];
    for (const i of items) {
      const where = { role_action: { role: i.role, action: i.action } };
      // khóa dòng (nếu có) để audit "before" đúng khi hai PUT song song
      await tx.$queryRaw`SELECT 1 FROM core.approval_limits WHERE role = ${i.role}::core."Role" AND action = ${i.action}::core."ApprovalAction" FOR UPDATE`;
      const before = await tx.approvalLimit.findUnique({ where });
      const data = {
        allowed: i.allowed,
        maxAmount: i.max_amount === null ? null : BigInt(i.max_amount),
        maxPctBp: i.max_pct_bp,
        limitMode: i.limit_mode,
        sameDayOnly: i.same_day_only,
        requiresPin: i.requires_pin,
        requiresNote: i.requires_note,
        updatedBy: p.userId,
      };
      const row = await tx.approvalLimit.upsert({
        where,
        create: { role: i.role, action: i.action, ...data },
        update: data,
      });
      await this.ao.recordAudit({
        action: 'approval_limit.put',
        resourceType: 'approval_limit',
        resourceId: `${i.role}:${i.action}`,
        before: before ? limitWire(before) : null,
        after: limitWire(row),
      });
      out.push(limitWire(row));
    }
    return { items: out };
  }
}

function limitWire(r: {
  role: string;
  action: string;
  allowed: boolean;
  maxAmount: bigint | null;
  maxPctBp: number | null;
  limitMode: string;
  sameDayOnly: boolean;
  requiresPin: boolean;
  requiresNote: boolean;
}) {
  return {
    role: r.role,
    action: r.action,
    allowed: r.allowed,
    max_amount: r.maxAmount === null ? null : Number(r.maxAmount),
    max_pct_bp: r.maxPctBp,
    limit_mode: r.limitMode,
    same_day_only: r.sameDayOnly,
    requires_pin: r.requiresPin,
    requires_note: r.requiresNote,
  };
}
