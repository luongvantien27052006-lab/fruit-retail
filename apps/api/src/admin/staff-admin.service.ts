import { Inject, Injectable } from '@nestjs/common';
import { clearAllLocks } from '../auth/auth-attempts';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import { v7 as uuidv7 } from 'uuid';
import type { Principal } from '../common/access';
import { AuditOutboxService, type Tx } from '../common/audit-outbox.service';
import { findSqlState } from '../common/db-errors';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { ScopeService } from '../common/scope.service';
import { ARGON_PROFILES, hashSecret, withArgonSlot } from '../auth/password';
import { normalizeStaffCode } from '../auth/staff-auth.service';

export type StaffRole = 'STORE_MANAGER' | 'CASHIER' | 'PICKER' | 'SHIPPER' | 'WAREHOUSE_STAFF';
export const STAFF_ROLES: readonly StaffRole[] = ['STORE_MANAGER', 'CASHIER', 'PICKER', 'SHIPPER', 'WAREHOUSE_STAFF'];
/** §2.2 / x-assignable-roles: cửa hàng trưởng chỉ gán CASHIER, PICKER ở cửa hàng mình; Master gán mọi vai trò nhân viên */
const SM_ASSIGNABLE: ReadonlySet<StaffRole> = new Set(['CASHIER', 'PICKER']);

export interface RoleSpec {
  role: StaffRole;
  store_id?: string | null;
  warehouse_id?: string | null;
}

/**
 * PIN yếu (ghi nhận lát 4): một chữ số lặp, dãy tăng/giảm liên tiếp, cặp/ba lặp (121212, 123123), và vài PIN phổ biến.
 * Không thay khóa SEC5 — chỉ bớt PIN dễ đoán khi dò rải nhiều nhân viên.
 */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1{5}$/.test(pin)) return true;
  const d = [...pin].map(Number);
  const step = d.slice(1).map((x, i) => (x - (d[i] ?? 0) + 10) % 10);
  if (step.every((x) => x === 1) || step.every((x) => x === 9)) return true;
  if (/^(\d\d)\1\1$/.test(pin) || /^(\d{3})\1$/.test(pin)) return true;
  return ['112233', '159753', '147258', '102030', '696969', '520520', '131313'].includes(pin);
}

const weakPin = () =>
  new AppError('INVALID_REQUEST', 'PIN quá dễ đoán (lặp, dãy liên tiếp hoặc phổ biến) — chọn PIN khác', {
    field: 'pin',
  });
const notFound = () => new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy nhân viên');

/**
 * Quản lý nhân viên + vai trò theo phạm vi (CP03 lát 6, ADR-024; §2.1, §2.2, §4.8). Không gồm tài khoản admin
 * (MASTER_ADMIN/VIEW_ONLY_ADMIN đi qua /admin/admin-accounts — lát 8).
 * - Master: mọi nhân viên, gán mọi vai trò nhân viên ở mọi cửa hàng/kho.
 * - Cửa hàng trưởng: chỉ nhân viên mà MỌI vai trò đang hiệu lực đều là CASHIER/PICKER ở cửa hàng trong phạm vi của mình;
 *   chỉ gán/gỡ CASHIER, PICKER ở cửa hàng mình. Ngoài phạm vi ⇒ 404 (không lộ nhân viên cửa hàng khác).
 * - Không ai tự sửa / tự gán / tự gỡ vai trò của chính mình qua các route này.
 */
@Injectable()
export class StaffAdminService {
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly ao: AuditOutboxService,
    private readonly scope: ScopeService,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  private get tx() {
    return this.txHost.tx;
  }

  private principal(): Principal {
    const p = this.cls.get('principal');
    if (!p) throw new AppError('AUTHENTICATION_REQUIRED', 'Cần đăng nhập');
    return p;
  }

  // ───────────────────────────── đọc ─────────────────────────────

  async list() {
    const s = await this.scope.stores('staff:write');
    if (s !== 'ALL' && s.size === 0) return { items: [] };
    const rows = await this.tx.staff.findMany({
      where:
        s === 'ALL'
          ? {}
          : {
              user: {
                permissionGrants: { none: { revokedAt: null } },
                roleAssignments: {
                  some: {
                    revokedAt: null,
                    scopeType: 'STORE',
                    scopeId: { in: [...s] },
                    role: { in: [...SM_ASSIGNABLE] },
                  },
                  none: {
                    revokedAt: null,
                    OR: [
                      { role: { notIn: [...SM_ASSIGNABLE] } },
                      { scopeType: { not: 'STORE' } },
                      { scopeId: { notIn: [...s] } },
                    ],
                  },
                },
              },
            },
      orderBy: { staffCode: 'asc' },
      take: 500,
      select: STAFF_SELECT,
    });
    return { items: rows.map(toWire) };
  }

  async get(id: string) {
    const row = await this.managed(id, 'staff:write');
    return toWire(row);
  }

  // ───────────────────────────── ghi ─────────────────────────────

  /** PIN băm TRƯỚC khi mở transaction (không giữ kết nối khi chờ Argon2) — @OwnTransaction ở controller. */
  async create(b: { staff_code: string; full_name: string; pin: string; hired_at?: string | null; role: RoleSpec }) {
    const p = this.principal();
    if (!p.permissions.has('role:assign'))
      throw new AppError('ACTION_FORBIDDEN', 'Tạo nhân viên kèm vai trò cần quyền gán vai trò', {
        permission: 'role:assign',
      });
    if (isWeakPin(b.pin)) throw weakPin();
    const code = normalizeStaffCode(b.staff_code);
    const pinHash = await withArgonSlot(`admin:${p.userId}`, () => hashSecret(b.pin, ARGON_PROFILES.PASSWORD));
    return this.txHost.withTransaction(async () => {
      const scope = await this.assertAssignable(b.role, 'role:assign');
      const id = uuidv7();
      try {
        await this.tx.user.create({ data: { id, type: 'STAFF', pinHash }, select: { id: true } });
        await this.tx.staff.create({
          data: {
            userId: id,
            staffCode: code,
            fullName: b.full_name,
            hiredAt: b.hired_at ? new Date(b.hired_at) : null,
          },
          select: { userId: true },
        });
      } catch (e) {
        if (findSqlState(e) === '23505' || (e as { code?: unknown }).code === 'P2002')
          throw new AppError('INVALID_STATE_TRANSITION', 'Mã nhân viên đã tồn tại', { field: 'staff_code' });
        throw e;
      }
      const ra = await this.tx.userRoleAssignment.create({
        data: { id: uuidv7(), userId: id, role: b.role.role, ...scope, createdBy: p.userId },
        select: { id: true },
      });
      await this.ao.recordAudit({
        action: 'staff.create',
        resourceType: 'user',
        resourceId: id,
        after: {
          staff_code: code,
          full_name: b.full_name,
          role: b.role.role,
          ...wireScope(scope),
          role_assignment_id: ra.id,
        },
      });
      return toWire(await this.tx.staff.findUniqueOrThrow({ where: { userId: id }, select: STAFF_SELECT }));
    });
  }

  async update(
    id: string,
    b: {
      full_name?: string;
      hired_at?: string | null;
      left_at?: string | null;
      status?: 'ACTIVE' | 'DISABLED';
      pin?: string;
    },
  ) {
    const p = this.principal();
    if (id.toLowerCase() === p.userId)
      throw new AppError('ACTION_FORBIDDEN', 'Không tự sửa tài khoản của chính mình ở đây');
    if (b.pin !== undefined && isWeakPin(b.pin)) throw weakPin();
    const pinHash =
      b.pin !== undefined
        ? await withArgonSlot(`admin:${p.userId}`, () => hashSecret(b.pin ?? '', ARGON_PROFILES.PASSWORD))
        : undefined;
    return this.txHost.withTransaction(async () => {
      // L1 (kiểm thử DB lát 6): CÙNG khóa với lần thử đăng nhập (AuthAttempts `auth:<id>`) và lấy TRƯỚC khóa dòng users
      // (cùng thứ tự với đăng nhập ⇒ không deadlock). Đăng nhập PIN đang chạy commit xong mới tới đây ⇒ phiên nó vừa tạo
      // nằm trong tập bị thu hồi; đăng nhập bắt đầu sau ⇒ nhánh "bận" (401 chung), xong thì gặp PIN mới.
      // L2' (kiểm thử 8a lần 2): người không có phạm vi ALL ⇒ kiểm quản lý được TRƯỚC khi lấy khóa đăng nhập của tài
      // khoản đích (gửi liên tục vào id Master không cản được Master đăng nhập); kiểm lại dưới khóa ở dưới
      if (!(await this.scope.isAll('staff:write'))) await this.managed(id, 'staff:write');
      if (pinHash !== undefined || b.status !== undefined)
        await this.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('auth:' || ${id}::uuid::text, 0))`;
      const before = await this.managed(id, 'staff:write', true);
      if (!(await this.scope.isAll('staff:write'))) {
        // L1 (kiểm thử lát 6): không có phạm vi ALL ⇒ chỉ được KHÓA / ghi ngày nghỉ lần đầu / đổi tên / đổi PIN của nhân
        // viên đang hoạt động — không mở lại tài khoản bị khóa, không xóa/lùi ngày nghỉ đã đặt (quyết định của Master)
        // trạng thái khác ACTIVE (Master khóa LOCKED / đã DISABLED) ⇒ không đổi status nữa (giữ dấu quyết định của Master)
        const reopen = b.status !== undefined && before.user.status !== 'ACTIVE';
        const leftChanged = b.left_at !== undefined && before.leftAt !== null && b.left_at !== day(before.leftAt);
        const pinOnInactive = b.pin !== undefined && (before.user.status !== 'ACTIVE' || before.leftAt !== null);
        if (reopen || leftChanged || pinOnInactive)
          throw new AppError('ACTION_FORBIDDEN', 'Chỉ Master mở lại tài khoản đã khóa / đổi ngày nghỉ đã đặt');
      }
      // Review cổng CP03 TB3: đổi trạng thái qua PATCH không được rẻ hơn route chuyên dụng
      //  - LOCKED ⇒ ACTIVE phải đi POST /admin/users/{id}/unlock (Master + step-up + lý do + audit user.unlock)
      //  - đổi status bởi tài khoản 2FA (Master) cần step-up còn hạn, như /lock
      // Master (2FA) đặt lại PIN cũng cần step-up — cùng quy tắc đổi status (review cổng lần 2)
      if (b.pin !== undefined) {
        const p = this.principal();
        const has2fa = p.userType === 'MASTER' || p.userType === 'VIEWER';
        if (has2fa && !(p.stepUpUntil && p.stepUpUntil.getTime() > Date.now()))
          throw new AppError('STEP_UP_REQUIRED', 'Đặt lại PIN nhân viên cần xác thực lại 2FA');
      }
      if (b.status !== undefined && b.status !== before.user.status) {
        if (before.user.status === 'LOCKED')
          throw new AppError(
            'INVALID_STATE_TRANSITION',
            'Tài khoản đang LOCKED — mở khóa qua /admin/users/{id}/unlock',
          );
        const p = this.principal();
        const has2fa = p.userType === 'MASTER' || p.userType === 'VIEWER';
        if (has2fa && !(p.stepUpUntil && p.stepUpUntil.getTime() > Date.now()))
          throw new AppError('STEP_UP_REQUIRED', 'Đổi trạng thái nhân viên cần xác thực lại 2FA');
      }
      const staffData = {
        ...(b.full_name !== undefined ? { fullName: b.full_name } : {}),
        ...(b.hired_at !== undefined ? { hiredAt: b.hired_at ? new Date(b.hired_at) : null } : {}),
        ...(b.left_at !== undefined ? { leftAt: b.left_at ? new Date(b.left_at) : null } : {}),
      };
      if (Object.keys(staffData).length)
        await this.tx.staff.update({ where: { userId: id }, data: staffData, select: { userId: true } });
      if (b.status !== undefined || pinHash !== undefined)
        await this.tx.user.update({
          where: { id },
          data: {
            ...(b.status !== undefined ? { status: b.status } : {}),
            ...(pinHash !== undefined ? { pinHash } : {}),
          },
          select: { id: true },
        });
      // PIN mới ⇒ khóa tạm do PIN cũ nhập sai không còn ý nghĩa
      if (pinHash !== undefined) await clearAllLocks(this.tx, id);
      // đổi PIN / khóa ⇒ thu hồi mọi phiên của nhân viên (PIN cũ có thể đã lộ)
      let revoked = 0;
      if (pinHash !== undefined || b.status === 'DISABLED') {
        // L2: khóa các dòng phiên theo id TRƯỚC (cùng thứ tự với thu hồi thiết bị) ⇒ không deadlock 40P01
        await this.tx.$queryRaw`
          SELECT id FROM core.sessions WHERE user_id = ${id}::uuid AND revoked_at IS NULL ORDER BY id FOR UPDATE`;
        const r = await this.tx.session.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date(), revokeReason: pinHash !== undefined ? 'PIN_RESET' : 'USER_DISABLED' },
        });
        revoked = r.count;
      }
      const after = await this.tx.staff.findUniqueOrThrow({ where: { userId: id }, select: STAFF_SELECT });
      await this.ao.recordAudit({
        action: 'staff.update',
        resourceType: 'user',
        resourceId: id,
        before: {
          full_name: before.fullName,
          hired_at: day(before.hiredAt),
          left_at: day(before.leftAt),
          status: before.user.status,
        },
        after: {
          full_name: after.fullName,
          hired_at: day(after.hiredAt),
          left_at: day(after.leftAt),
          status: after.user.status,
          credential_reset: pinHash !== undefined, // tên không chứa token nhạy cảm ("pin") ⇒ audit không che
          revoked_sessions: revoked,
        },
      });
      return toWire(after);
    });
  }

  async assignRole(b: { user_id: string } & RoleSpec) {
    const p = this.principal();
    if (b.user_id.toLowerCase() === p.userId)
      throw new AppError('ACTION_FORBIDDEN', 'Không tự gán vai trò cho chính mình');
    const scope = await this.assertAssignable(b, 'role:assign');
    // người nhận phải là nhân viên người gọi được quản lý (cửa hàng trưởng: nhân viên chỉ có vai trò trong phạm vi mình)
    await this.managed(b.user_id, 'role:assign', true);
    try {
      const ra = await this.tx.userRoleAssignment.create({
        data: { id: uuidv7(), userId: b.user_id, role: b.role, ...scope, createdBy: p.userId },
        select: { id: true, createdAt: true },
      });
      await this.ao.recordAudit({
        action: 'role.assign',
        resourceType: 'user_role_assignment',
        resourceId: ra.id,
        after: { user_id: b.user_id, role: b.role, ...wireScope(scope) },
      });
      return {
        id: ra.id,
        user_id: b.user_id,
        role: b.role,
        ...wireScope(scope),
        created_at: ra.createdAt.toISOString(),
      };
    } catch (e) {
      if (findSqlState(e) === '23505' || (e as { code?: unknown }).code === 'P2002')
        throw new AppError('INVALID_STATE_TRANSITION', 'Nhân viên đã có vai trò ở phạm vi này');
      throw e;
    }
  }

  async revokeRole(id: string) {
    const p = this.principal();
    await this.tx.$queryRaw`SELECT id FROM core.user_role_assignments WHERE id = ${id}::uuid FOR UPDATE`;
    const ra = await this.tx.userRoleAssignment.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        role: true,
        scopeType: true,
        scopeId: true,
        revokedAt: true,
        user: { select: { type: true } },
      },
    });
    if (!ra || ra.revokedAt || ra.user.type !== 'STAFF')
      throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy vai trò');
    if (ra.userId === p.userId) throw new AppError('ACTION_FORBIDDEN', 'Không tự gỡ vai trò của chính mình');
    if (!STAFF_ROLES.includes(ra.role as StaffRole)) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy vai trò');
    const all = await this.scope.isAll('role:assign');
    if (!all) {
      if (!SM_ASSIGNABLE.has(ra.role as StaffRole) || ra.scopeType !== 'STORE' || !ra.scopeId)
        throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy vai trò');
      await this.scope.assertStore(
        'role:assign',
        ra.scopeId,
        () => new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy vai trò'),
      );
      // người bị gỡ phải là nhân viên cửa hàng trưởng quản lý được (cùng quy tắc managed())
      await this.managed(ra.userId, 'role:assign');
    }
    await this.tx.userRoleAssignment.update({
      where: { id },
      data: { revokedAt: new Date(), revokedBy: p.userId },
      select: { id: true },
    });
    await this.ao.recordAudit({
      action: 'role.revoke',
      resourceType: 'user_role_assignment',
      resourceId: id,
      before: { user_id: ra.userId, role: ra.role, scope_type: ra.scopeType, scope_id: ra.scopeId },
    });
  }

  // ───────────────────────────── phạm vi ─────────────────────────────

  /** Vai trò + phạm vi người gọi được gán; trả cột scope cho bảng. Cửa hàng/kho phải tồn tại và đang hoạt động. */
  private async assertAssignable(r: RoleSpec, permission: string) {
    const all = await this.scope.isAll(permission);
    if (!STAFF_ROLES.includes(r.role))
      throw new AppError('INVALID_REQUEST', 'Vai trò không gán được ở đây', { field: 'role' });
    if (!all && !SM_ASSIGNABLE.has(r.role))
      throw new AppError('ACTION_FORBIDDEN', 'Cửa hàng trưởng chỉ gán được thu ngân, nhân viên soạn hàng');
    if (r.role === 'WAREHOUSE_STAFF') {
      if (!r.warehouse_id || r.store_id)
        throw new AppError('INVALID_REQUEST', 'Nhân viên kho cần warehouse_id', { field: 'warehouse_id' });
      const w = await this.tx.warehouse.findUnique({ where: { id: r.warehouse_id }, select: { archivedAt: true } });
      if (!w || w.archivedAt) throw new AppError('INVALID_REQUEST', 'Kho không hợp lệ', { field: 'warehouse_id' });
      return { scopeType: 'WAREHOUSE' as const, scopeId: r.warehouse_id };
    }
    if (!r.store_id || r.warehouse_id)
      throw new AppError('INVALID_REQUEST', 'Vai trò cửa hàng cần store_id', { field: 'store_id' });
    await this.scope.assertStore(
      permission,
      r.store_id,
      () => new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy cửa hàng'),
    );
    const st = await this.tx.store.findUnique({
      where: { id: r.store_id },
      select: { status: true, archivedAt: true },
    });
    if (!st || st.status !== 'ACTIVE' || st.archivedAt)
      throw new AppError('INVALID_STATE_TRANSITION', 'Cửa hàng không hoạt động', { field: 'store_id' });
    return { scopeType: 'STORE' as const, scopeId: r.store_id };
  }

  /**
   * Nhân viên người gọi được quản lý theo mã quyền: Master (ALL) mọi nhân viên; cửa hàng trưởng chỉ nhân viên có ít nhất
   * một vai trò CASHIER/PICKER ở cửa hàng trong phạm vi và KHÔNG có vai trò nào khác/ngoài phạm vi. Sai ⇒ 404.
   */
  private async managed(id: string, permission: string, lock = false) {
    if (lock) await this.tx.$queryRaw`SELECT id FROM core.users WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await this.tx.staff.findUnique({ where: { userId: id }, select: STAFF_SELECT });
    if (!row || row.user.type !== 'STAFF') throw notFound();
    const s = await this.scope.stores(permission);
    if (s === 'ALL') return row;
    const live = row.user.roleAssignments;
    // L2: có quyền cấp riêng đang hiệu lực ⇒ chỉ phạm vi ALL quản lý (tránh đặt lại PIN để mượn quyền rộng hơn mình)
    const ok =
      row.user.permissionGrants.length === 0 &&
      live.length > 0 &&
      live.every(
        (r) => SM_ASSIGNABLE.has(r.role as StaffRole) && r.scopeType === 'STORE' && !!r.scopeId && s.has(r.scopeId),
      );
    if (!ok) throw notFound();
    return row;
  }
}

const STAFF_SELECT = {
  userId: true,
  staffCode: true,
  fullName: true,
  hiredAt: true,
  leftAt: true,
  user: {
    select: {
      type: true,
      status: true,
      roleAssignments: {
        where: { revokedAt: null },
        select: { id: true, role: true, scopeType: true, scopeId: true },
        orderBy: { createdAt: 'asc' as const },
      },
      permissionGrants: { where: { revokedAt: null }, select: { id: true }, take: 1 },
    },
  },
} as const;

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const wireScope = (s: { scopeType: 'STORE' | 'WAREHOUSE'; scopeId: string }) =>
  s.scopeType === 'STORE' ? { store_id: s.scopeId, warehouse_id: null } : { store_id: null, warehouse_id: s.scopeId };

function toWire(r: {
  userId: string;
  staffCode: string;
  fullName: string;
  hiredAt: Date | null;
  leftAt: Date | null;
  user: { status: string; roleAssignments: { id: string; role: string; scopeType: string; scopeId: string | null }[] };
}) {
  return {
    user_id: r.userId,
    staff_code: r.staffCode,
    full_name: r.fullName,
    hired_at: day(r.hiredAt),
    left_at: day(r.leftAt),
    status: r.user.status,
    roles: r.user.roleAssignments.map((a) => ({
      id: a.id,
      role: a.role,
      scope_type: a.scopeType,
      store_id: a.scopeType === 'STORE' ? a.scopeId : null,
      warehouse_id: a.scopeType === 'WAREHOUSE' ? a.scopeId : null,
    })),
  };
}
