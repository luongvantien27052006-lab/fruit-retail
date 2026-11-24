import { AppError } from './errors';

/** Mã SQLSTATE của PostgreSQL nằm sâu trong lỗi Prisma (driver adapter) — tìm theo chuỗi cause/meta. */
export function findSqlState(err: unknown, depth = 0): string | undefined {
  if (!err || typeof err !== 'object' || depth > 5) return undefined;
  const e = err as Record<string, unknown>;
  // `code` của chính lỗi Prisma là mã P…(vd P2039) — không phải SQLSTATE (SQLSTATE thật nằm ở driverAdapterError.cause)
  const isPrismaError = typeof e['name'] === 'string' && e['name'].startsWith('PrismaClient');
  for (const k of isPrismaError ? ['originalCode', 'sqlState'] : ['originalCode', 'code', 'sqlState']) {
    const v = e[k];
    if (typeof v === 'string' && /^[0-9A-Z]{5}$/.test(v)) return v;
  }
  const meta = e['meta'] as Record<string, unknown> | undefined;
  return (
    findSqlState(meta?.['driverAdapterError'], depth + 1) ??
    findSqlState(e['cause'], depth + 1) ??
    findSqlState(meta, depth + 1)
  );
}

function prismaCode(err: unknown): string | undefined {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^P\d{4}$/.test(c) ? c : undefined;
}

/** Lỗi Prisma (có mã P…/SQLSTATE) — để log chỉ ghi mã/meta, không ghi message (message có thể chứa tham số/PII). */
export function isDbError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return (
    (typeof name === 'string' && name.startsWith('PrismaClient')) ||
    prismaCode(err) !== undefined ||
    findSqlState(err) !== undefined
  );
}

/**
 * Ánh xạ lỗi DB sang mã §13.1 (M3 kiểm thử lát 2). Không ánh xạ được ⇒ undefined (filter trả 500 INTERNAL_ERROR).
 * Ràng buộc/trigger nghiệp vụ muốn có mã riêng thì use case bắt và ném AppError tương ứng.
 */
export function mapDbError(err: unknown): AppError | undefined {
  const p = prismaCode(err);
  if (p === 'P2025' || p === 'P2001' || p === 'P2018') return new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy');
  if (p === 'P2002') return new AppError('VERSION_CONFLICT', 'Dữ liệu trùng với bản ghi đã có', { reason: 'UNIQUE' });
  if (p === 'P2034') return new AppError('VERSION_CONFLICT', 'Xung đột ghi đồng thời — thử lại', { reason: 'RETRY' });
  if (p === 'P2028' || p === 'P1001' || p === 'P1002' || p === 'P1008' || p === 'P1017' || p === 'P2024')
    return new AppError('DEPENDENCY_UNAVAILABLE', 'Cơ sở dữ liệu tạm thời không sẵn sàng');
  const s = findSqlState(err);
  if (!s) return undefined;
  if (s === '23505') return new AppError('VERSION_CONFLICT', 'Dữ liệu trùng với bản ghi đã có', { reason: 'UNIQUE' });
  if (s === '40001' || s === '40P01')
    return new AppError('VERSION_CONFLICT', 'Xung đột ghi đồng thời — thử lại', { reason: 'RETRY' });
  if (s === '23503' || s === '23514' || s === '23502' || s === '22P02' || s === '22001' || s === '22003')
    return new AppError('INVALID_REQUEST', 'Dữ liệu vi phạm ràng buộc', { reason: s });
  if (s === '57014' || s.startsWith('08') || s === '53300' || s === '57P01')
    return new AppError('DEPENDENCY_UNAVAILABLE', 'Cơ sở dữ liệu tạm thời không sẵn sàng');
  return undefined;
}
