import type { Tx } from './audit-outbox.service';

/**
 * Phạm vi cửa hàng của một mã quyền (`x-scope: store`): `'ALL'` nếu có vai trò/cấp riêng phạm vi ALL mang quyền đó,
 * ngược lại tập store_id từ các dòng phạm vi STORE còn hiệu lực. Bản tối thiểu cho lát 4 (thiết bị POS); lát 6 (RBAC)
 * dựng bộ kiểm phạm vi chung trên cùng dữ liệu này. Chỉ dùng API đọc của Prisma (route GET không có transaction).
 */
export async function storeScope(tx: Tx['tx'], userId: string, permission: string): Promise<'ALL' | Set<string>> {
  const [assignments, grants] = await Promise.all([
    tx.userRoleAssignment.findMany({
      where: { userId, revokedAt: null },
      select: { role: true, scopeType: true, scopeId: true },
    }),
    tx.userPermissionGrant.findMany({
      where: { userId, revokedAt: null, permissionCode: permission },
      select: { scopeType: true, scopeId: true },
    }),
  ]);
  const roles = [...new Set(assignments.map((a) => a.role))];
  const withPerm = roles.length
    ? new Set(
        (
          await tx.rolePermission.findMany({
            where: { role: { in: roles }, permissionCode: permission },
            select: { role: true },
          })
        ).map((r) => r.role),
      )
    : new Set<string>();
  const scopes = [...assignments.filter((a) => withPerm.has(a.role)), ...grants];
  if (scopes.some((s) => s.scopeType === 'ALL')) return 'ALL';
  return new Set(scopes.filter((s) => s.scopeType === 'STORE' && s.scopeId).map((s) => s.scopeId as string));
}
