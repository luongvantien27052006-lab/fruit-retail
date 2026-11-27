import { Inject, Injectable } from '@nestjs/common';
import { bumpTrust, clearAllLocks, hasTempLock } from '../auth/auth-attempts';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { normalizeEmail } from '../auth/auth.service';
import { ARGON_PROFILES, hashSecret, withArgonSlot } from '../auth/password';
import type { Principal } from '../common/access';
import { AuditOutboxService, type Tx } from '../common/audit-outbox.service';
import { findSqlState } from '../common/db-errors';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { ScopeService } from '../common/scope.service';

const notFound = () => new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy tài khoản');
const SM_MANAGEABLE = new Set(['CASHIER', 'PICKER']);

/**
 * Tài khoản admin + thao tác bảo mật trên tài khoản người khác (CP03 lát 8a, ADR-026; SEC2, SEC4, §2.4, §14).
 * - Tạo MASTER_ADMIN / VIEW_ONLY_ADMIN: chỉ Master + step-up; mật khẩu tạm 120 bit trả MỘT lần; 2FA bắt buộc lần đầu.
 * - Khóa: Master khóa mọi tài khoản (trừ mình, trừ Master ACTIVE cuối cùng ⇒ LAST_MASTER_REQUIRED); cửa hàng trưởng chỉ
 *   nhân viên CASHIER/PICKER của cửa hàng mình (như /admin/staff). Mở khóa: chỉ Master (không đảo quyết định khóa).
 * - Reset 2FA: chỉ Master, tài khoản Master/Viewer khác.
 * Mọi thao tác đổi trạng thái xác thực lấy `pg_advisory_xact_lock('auth:'||id)` (cùng khóa với lần thử đăng nhập — lát 6
 * L1/G4) rồi khóa phiên theo id ⇒ không sót phiên đăng nhập song song, không deadlock với thu hồi thiết bị.
 */
@Injectable()
export class AdminAccountsService {
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

  // ───────────────────────────── tạo tài khoản admin ─────────────────────────────

  /** Băm mật khẩu TRƯỚC transaction (@OwnTransaction ở controller). */
  async createAdmin(b: { email: string; role: 'MASTER_ADMIN' | 'VIEW_ONLY_ADMIN'; viewer_profile_id?: string | null }) {
    const p = this.principal();
    const email = normalizeEmail(b.email);
    if (!/^[^@\s]+@[^@\s]+$/.test(email) || email.length > 254)
      throw new AppError('INVALID_REQUEST', 'Email không hợp lệ', { field: 'email' });
    if (b.role === 'MASTER_ADMIN' && b.viewer_profile_id)
      throw new AppError('INVALID_REQUEST', 'Hồ sơ xem chỉ cho tài khoản xem', { field: 'viewer_profile_id' });
    if (b.role === 'VIEW_ONLY_ADMIN' && !b.viewer_profile_id)
      throw new AppError('INVALID_REQUEST', 'Tài khoản xem cần đúng một hồ sơ xem', { field: 'viewer_profile_id' });
    const password = randomBytes(15).toString('base64url'); // 20 ký tự, 120 bit
    const hash = await withArgonSlot(`admin:${p.userId}`, () => hashSecret(password, ARGON_PROFILES.PASSWORD));
    return this.txHost.withTransaction(async () => {
      if (b.viewer_profile_id) {
        const vp = await this.tx.viewerProfile.findUnique({
          where: { id: b.viewer_profile_id },
          select: { archivedAt: true },
        });
        if (!vp || vp.archivedAt)
          throw new AppError('INVALID_REQUEST', 'Hồ sơ xem không hợp lệ', { field: 'viewer_profile_id' });
      }
      const id = uuidv7();
      const type = b.role === 'MASTER_ADMIN' ? 'MASTER' : 'VIEWER';
      try {
        await this.tx.user.create({
          data: { id, type, email, passwordHash: hash, mustChangePassword: true },
          select: { id: true },
        });
      } catch (e) {
        if (findSqlState(e) === '23505' || (e as { code?: unknown }).code === 'P2002')
          throw new AppError('INVALID_STATE_TRANSITION', 'Email đã được dùng', { field: 'email' });
        throw e;
      }
      await this.tx.userRoleAssignment.create({
        data: { id: uuidv7(), userId: id, role: b.role, scopeType: 'ALL', createdBy: p.userId },
        select: { id: true },
      });
      if (b.viewer_profile_id)
        await this.tx.viewerProfileAssignment.create({
          data: { userId: id, viewerProfileId: b.viewer_profile_id },
          select: { userId: true },
        });
      await this.ao.recordAudit({
        action: 'admin_account.create',
        resourceType: 'user',
        resourceId: id,
        after: { type, role: b.role, viewer_profile_id: b.viewer_profile_id ?? null },
      });
      // mật khẩu tạm chỉ ở response này (no-store) — không vào DB rõ, không vào audit/log
      return { user_id: id, email, type, role: b.role, temporary_password: password, two_factor_required: true };
    });
  }

  // ───────────────────────────── khóa / mở khóa ─────────────────────────────

  async lock(id: string, reason: string) {
    const p = this.principal();
    if (id.toLowerCase() === p.userId) throw new AppError('ACTION_FORBIDDEN', 'Không tự khóa tài khoản của chính mình');
    // L2 (kiểm thử 8a): người không phải Master ⇒ kiểm phạm vi TRƯỚC khi lấy khóa đăng nhập của người khác (không cản
    // đăng nhập của tài khoản ngoài phạm vi bằng cách gửi liên tục), rồi kiểm lại sau khi khóa
    if (p.userType !== 'MASTER') await this.target(id, 'staff:write');
    await this.authLock(id);
    const u = await this.target(id, 'staff:write');
    // L1: chỉ khóa tài khoản đang ACTIVE — DISABLED/LOCKED giữ nguyên (khóa DISABLED rồi mở khóa sẽ hồi sinh tài khoản)
    if (u.status !== 'ACTIVE') throw new AppError('INVALID_STATE_TRANSITION', `Tài khoản đang ${u.status}`);
    if (u.type === 'MASTER') await this.assertNotLastMaster(id);
    await this.tx.user.update({ where: { id }, data: { status: 'LOCKED' }, select: { id: true } });
    const revoked = await this.revokeAll(id, 'USER_LOCKED');
    await bumpTrust(this.tx, id);
    await this.ao.recordAudit({
      action: 'user.lock',
      resourceType: 'user',
      resourceId: id,
      before: { status: u.status },
      after: { status: 'LOCKED', revoked_sessions: revoked },
      reason,
    });
    return { user_id: id, status: 'LOCKED' as const, revoked_sessions: revoked };
  }

  async unlock(id: string, reason: string) {
    const p = this.principal();
    // mở khóa chỉ phạm vi ALL (Master): cửa hàng trưởng không đảo quyết định khóa (lát 6 L1)
    if (p.userType !== 'MASTER') throw new AppError('ACTION_FORBIDDEN', 'Chỉ Master mở khóa tài khoản');
    await this.authLock(id);
    const u = await this.target(id, 'staff:write');
    // LOCKED (Master khóa) hoặc ACTIVE đang bị khóa TẠM do nhập sai (ADR-030: Master gỡ được khóa tạm của Master khác)
    const temp = u.status === 'ACTIVE' && (await hasTempLock(this.tx, id));
    if (u.status !== 'LOCKED' && !temp)
      throw new AppError('INVALID_STATE_TRANSITION', `Tài khoản đang ${u.status} và không bị khóa tạm`);
    if (u.status === 'LOCKED')
      await this.tx.user.update({ where: { id }, data: { status: 'ACTIVE' }, select: { id: true } });
    await clearAllLocks(this.tx, id);
    await this.ao.recordAudit({
      action: 'user.unlock',
      resourceType: 'user',
      resourceId: id,
      before: { status: u.status, temporary_lock: temp },
      after: { status: 'ACTIVE' },
      reason,
    });
    return { user_id: id, status: 'ACTIVE' as const };
  }

  // ───────────────────────────── 2FA / phiên ─────────────────────────────

  /** Xóa 2FA + mã khôi phục + thử thách MFA đang mở, thu hồi mọi phiên ⇒ lần đăng nhập sau phải đăng ký 2FA lại. */
  async resetTwoFactor(id: string, reason: string) {
    const p = this.principal();
    if (id.toLowerCase() === p.userId) throw new AppError('ACTION_FORBIDDEN', 'Không tự reset 2FA của chính mình');
    await this.authLock(id);
    const u = await this.tx.user.findUnique({ where: { id }, select: { type: true, totpEnabledAt: true } });
    if (!u || (u.type !== 'MASTER' && u.type !== 'VIEWER')) throw notFound();
    await this.tx.user.update({
      where: { id },
      data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null },
      select: { id: true },
    });
    const codes = await this.tx.recoveryCode.deleteMany({ where: { userId: id } });
    await this.tx.authChallenge.deleteMany({ where: { userId: id, kind: 'MFA' } });
    const revoked = await this.revokeAll(id, 'TWO_FACTOR_RESET');
    await bumpTrust(this.tx, id);
    await this.ao.recordAudit({
      action: 'user.two_factor_reset',
      resourceType: 'user',
      resourceId: id,
      before: { two_factor_on: u.totpEnabledAt !== null, recovery_codes: codes.count },
      after: { two_factor_on: false, revoked_sessions: revoked },
      reason,
    });
    return { user_id: id, two_factor_enabled: false, revoked_sessions: revoked };
  }

  async sessionsOf(id: string) {
    const u = await this.tx.user.findUnique({ where: { id }, select: { id: true } });
    if (!u) throw notFound();
    const rows = await this.tx.session.findMany({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        userType: true,
        amr: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        revokeReason: true,
        posDeviceId: true,
        userAgent: true,
      },
    });
    const now = Date.now();
    return {
      items: rows.map((r) => ({
        id: r.id,
        user_type: r.userType,
        amr: r.amr,
        created_at: r.createdAt.toISOString(),
        last_used_at: r.lastUsedAt.toISOString(),
        expires_at: r.expiresAt.toISOString(),
        revoked_at: r.revokedAt?.toISOString() ?? null,
        revoke_reason: r.revokeReason,
        pos_device_id: r.posDeviceId,
        user_agent: r.userAgent,
        active: !r.revokedAt && r.expiresAt.getTime() > now,
      })),
    };
  }

  async revokeSession(id: string, reason: string) {
    const p = this.principal();
    await this.tx.$queryRaw`SELECT id FROM core.sessions WHERE id = ${id}::uuid FOR UPDATE`;
    const s = await this.tx.session.findUnique({ where: { id }, select: { userId: true, revokedAt: true } });
    if (!s) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy phiên');
    if (s.revokedAt) throw new AppError('INVALID_STATE_TRANSITION', 'Phiên đã bị thu hồi');
    if (id.toLowerCase() === p.sessionId)
      throw new AppError('ACTION_FORBIDDEN', 'Dùng đăng xuất để kết thúc phiên hiện tại');
    await this.tx.session.update({
      where: { id },
      data: { revokedAt: new Date(), revokeReason: 'ADMIN_REVOKED' },
      select: { id: true },
    });
    await this.ao.recordAudit({
      action: 'session.revoke',
      resourceType: 'session',
      resourceId: id,
      after: { user_id: s.userId },
      reason,
    });
    return { session_id: id, revoked: true };
  }

  // ───────────────────────────── nhật ký ─────────────────────────────

  /** Tra cứu audit.logs (§14) — lọc theo hành động / đối tượng / người làm / thời gian, phân trang theo con trỏ id. */
  async auditLogs(q: {
    action?: string;
    resource_type?: string;
    resource_id?: string;
    actor_id?: string;
    from?: string;
    to?: string;
    cursor?: string;
    limit: number;
  }) {
    const rows = await this.tx.auditLog.findMany({
      where: {
        ...(q.action ? { action: q.action } : {}),
        ...(q.resource_type ? { resourceType: q.resource_type } : {}),
        ...(q.resource_id ? { resourceId: q.resource_id } : {}),
        ...(q.actor_id ? { actorId: q.actor_id } : {}),
        ...(q.from || q.to
          ? { at: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } }
          : {}),
        ...(q.cursor ? { id: { lt: q.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
    });
    const more = rows.length > q.limit;
    const items = rows.slice(0, q.limit);
    return {
      items: items.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        action: r.action,
        resource_type: r.resourceType,
        resource_id: r.resourceId,
        actor_id: r.actorId,
        actor_type: r.actorType,
        reason: r.reason,
        before: r.before,
        after: r.after,
        request_id: r.requestId,
      })),
      next_cursor: more ? (items.at(-1)?.id ?? null) : null,
    };
  }

  // ───────────────────────────── phụ trợ ─────────────────────────────

  private async authLock(id: string) {
    await this.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('auth:' || ${id}::uuid::text, 0))`;
    await this.tx.$queryRaw`SELECT id FROM core.users WHERE id = ${id}::uuid FOR UPDATE`;
  }

  /**
   * Tài khoản người gọi được thao tác: Master ⇒ mọi tài khoản; người khác (cửa hàng trưởng) ⇒ chỉ nhân viên mà mọi vai trò
   * đang hiệu lực là CASHIER/PICKER ở cửa hàng trong phạm vi, không có quyền cấp riêng (cùng quy tắc /admin/staff). Sai ⇒ 404.
   */
  private async target(id: string, permission: string) {
    const p = this.principal();
    const u = await this.tx.user.findUnique({
      where: { id },
      select: {
        type: true,
        status: true,
        roleAssignments: { where: { revokedAt: null }, select: { role: true, scopeType: true, scopeId: true } },
        permissionGrants: { where: { revokedAt: null }, select: { id: true }, take: 1 },
      },
    });
    if (!u) throw notFound();
    if (p.userType === 'MASTER') return u;
    const s = await this.scope.stores(permission);
    const ok =
      u.type === 'STAFF' &&
      s !== 'ALL' &&
      u.permissionGrants.length === 0 &&
      u.roleAssignments.length > 0 &&
      u.roleAssignments.every(
        (r) => SM_MANAGEABLE.has(r.role) && r.scopeType === 'STORE' && !!r.scopeId && s.has(r.scopeId),
      );
    if (!ok) throw notFound();
    return u;
  }

  /** Không khóa Master ACTIVE cuối cùng (§2.1: luôn còn ≥ 1 người quản trị được hệ thống). Khóa hàng đợi bằng advisory. */
  private async assertNotLastMaster(id: string) {
    await this.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('last-master', 0))`;
    const others = await this.tx.user.count({ where: { type: 'MASTER', status: 'ACTIVE', id: { not: id } } });
    if (others === 0) throw new AppError('LAST_MASTER_REQUIRED', 'Không khóa được Master hoạt động cuối cùng');
  }

  private async revokeAll(userId: string, reason: string): Promise<number> {
    await this.tx.$queryRaw`
      SELECT id FROM core.sessions WHERE user_id = ${userId}::uuid AND revoked_at IS NULL ORDER BY id FOR UPDATE`;
    const r = await this.tx.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    return r.count;
  }
}
