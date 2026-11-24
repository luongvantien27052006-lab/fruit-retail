import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { Principal } from '../common/access';
import type { Tx } from '../common/audit-outbox.service';
import { AppError } from '../common/errors';
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
        user: { select: { status: true, type: true } },
      },
    });
    // token hợp lệ nhưng phiên không khớp người dùng: coi như token giả
    if (!s || s.userId !== claims.sub || s.user.type !== s.userType)
      throw new AppError('AUTHENTICATION_REQUIRED', 'Cần đăng nhập');
    if (s.revokedAt || s.expiresAt.getTime() <= Date.now() || s.user.status !== 'ACTIVE')
      throw new AppError('SESSION_REVOKED', 'Phiên đã hết hạn hoặc bị thu hồi — đăng nhập lại');

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
