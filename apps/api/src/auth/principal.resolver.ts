import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import type { Principal } from '../common/access';
import type { Tx } from '../common/audit-outbox.service';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { AccessTokens } from './tokens';

/** Token DI để AccessGuard (common) không phụ thuộc trực tiếp module auth. */
export const PRINCIPAL_RESOLVER = Symbol('PRINCIPAL_RESOLVER');

export interface PrincipalResolverPort {
  /** `undefined` khi không có header Authorization. Token/phiên sai ⇒ ném AppError 401. */
  resolve(authorization: string | undefined): Promise<Principal | undefined>;
}

const BEARER_RE = /^Bearer ([A-Za-z0-9._-]{16,2048})$/;

/**
 * Bearer JWT → Principal. Chữ ký chỉ chứng minh token do server phát; trạng thái THẬT đọc lại từ DB mỗi request
 * (ADR-012): phiên chưa thu hồi/chưa hết hạn, người dùng ACTIVE, amr/step-up của phiên, quyền từ vai trò + cấp riêng
 * đang hiệu lực — thu hồi/khóa có hiệu lực ngay, không chờ access token hết hạn.
 */
@Injectable()
export class PrincipalResolver implements PrincipalResolverPort {
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly tokens: AccessTokens,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  async resolve(authorization: string | undefined): Promise<Principal | undefined> {
    if (authorization === undefined) return undefined;
    const m = BEARER_RE.exec(authorization);
    if (!m?.[1]) throw new AppError('AUTHENTICATION_REQUIRED', 'Cần đăng nhập');
    const claims = await this.tokens.verify(m[1]);
    if (!claims) throw new AppError('AUTHENTICATION_REQUIRED', 'Cần đăng nhập');
    const tx = this.txHost.tx;
    const s = await tx.session.findUnique({
      where: { id: claims.sid },
      select: {
        id: true,
        userId: true,
        userType: true,
        amr: true,
        stepUpUntil: true,
        expiresAt: true,
        revokedAt: true,
        posDeviceId: true,
        user: { select: { status: true, type: true, staff: { select: { leftAt: true } } } },
      },
    });
    // token hợp lệ nhưng phiên không khớp người dùng: coi như token giả
    if (!s || s.userId !== claims.sub || s.user.type !== s.userType)
      throw new AppError('AUTHENTICATION_REQUIRED', 'Cần đăng nhập');
    if (s.revokedAt || s.expiresAt.getTime() <= Date.now() || s.user.status !== 'ACTIVE')
      throw new AppError('SESSION_REVOKED', 'Phiên đã hết hạn hoặc bị thu hồi — đăng nhập lại');
    // SEC3: token nhân viên chỉ dùng được kèm X-Device-Id đúng thiết bị của phiên (thiết bị thu hồi ⇒ phiên đã bị
    // trigger thu hồi ở trên). Không thay chữ ký thiết bị — chỉ chặn token bị chép sang máy khác dùng ngây thơ.
    if (s.userType === 'STAFF' && (!s.posDeviceId || this.cls.get('deviceId')?.toLowerCase() !== s.posDeviceId))
      throw new AppError('AUTHENTICATION_REQUIRED', 'Cần đăng nhập trên đúng thiết bị');
    // L2: ngày nghỉ việc tới ⇒ phiên nhân viên hết hiệu lực ngay (quyền theo vai trò đã tính lại mỗi request bên dưới)
    const leftAt = s.user.staff?.leftAt;
    if (s.userType === 'STAFF' && leftAt && leftAt.getTime() <= Date.now())
      throw new AppError('SESSION_REVOKED', 'Nhân viên đã nghỉ việc — phiên hết hiệu lực');

    const [roles, grants] = await Promise.all([
      tx.userRoleAssignment.findMany({ where: { userId: s.userId, revokedAt: null }, select: { role: true } }),
      tx.userPermissionGrant.findMany({
        where: { userId: s.userId, revokedAt: null },
        select: { permissionCode: true },
      }),
    ]);
    const roleList = [...new Set(roles.map((r) => r.role))];
    const fromRoles = roleList.length
      ? await tx.rolePermission.findMany({ where: { role: { in: roleList } }, select: { permissionCode: true } })
      : [];
    const permissions = new Set([...fromRoles, ...grants].map((x) => x.permissionCode));
    const admin = s.userType === 'MASTER' || s.userType === 'VIEWER';
    return {
      userId: s.userId,
      userType: s.userType,
      sessionId: s.id,
      permissions,
      ...(roleList[0] ? { role: roleList[0] } : {}),
      ...(s.posDeviceId ? { posDeviceId: s.posDeviceId } : {}),
      amr: s.amr,
      mfaComplete: !admin || s.amr.includes('otp') || s.amr.includes('rcv'),
      ...(s.stepUpUntil ? { stepUpUntil: s.stepUpUntil } : {}),
    };
  }
}
