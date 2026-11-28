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

/**
 * Lỗi đến từ DB thật: lỗi Prisma (PrismaClient*), lỗi driver adapter, hoặc có `meta.driverAdapterError`. Lỗi Node có
 * `code` 5 ký tự (EPIPE, EPERM…) KHÔNG phải lỗi DB — giữ nguyên message/stack khi log (kiểm thử lát 2 lần 2, T2).
 */
export function isDbError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; meta?: { driverAdapterError?: unknown } };
  const name = typeof e.name === 'string' ? e.name : '';
  return name.startsWith('PrismaClient') || name === 'DriverAdapterError' || e.meta?.driverAdapterError !== undefined;
}

/** Chi tiết an toàn để log lỗi DB: mã, SQLSTATE, ràng buộc/bảng/cột; message chỉ với RAISE do mình viết (P0001). */
export function dbErrorDetails(err: unknown): Record<string, unknown> {
  const e = err as { name?: string; code?: string; meta?: Record<string, unknown> };
  const cause = ((e.meta?.['driverAdapterError'] as { cause?: Record<string, unknown> } | undefined)?.cause ??
    {}) as Record<string, unknown>;
  const sqlstate = findSqlState(err);
  const constraint = cause['constraint'];
  return {
    db_error: e.name,
    prisma_code: e.code,
    sqlstate,
    ...(typeof constraint === 'object' && constraint
      ? { constraint }
      : typeof constraint === 'string'
        ? { constraint }
        : {}),
    ...(typeof cause['table'] === 'string' ? { table: cause['table'] } : {}),
    ...(typeof cause['column'] === 'string' ? { column: cause['column'] } : {}),
    ...(typeof e.meta?.['modelName'] === 'string' ? { model: e.meta['modelName'] } : {}),
    // P0001 = RAISE EXCEPTION trong trigger/hàm của dự án: message do mình viết, không chứa giá trị tham số
    ...(sqlstate === 'P0001' && typeof cause['originalMessage'] === 'string'
      ? { db_message: cause['originalMessage'] }
      : {}),
  };
}

/**
 * Ánh xạ lỗi DB sang mã §13.1 (M3 kiểm thử lát 2). Không ánh xạ được ⇒ undefined (filter trả 500 INTERNAL_ERROR).
 * Ràng buộc/trigger nghiệp vụ muốn có mã riêng thì use case bắt và ném AppError tương ứng.
 */
export function mapDbError(err: unknown): AppError | undefined {
  if (!isDbError(err)) return undefined;
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
  if (
    s === '23503' ||
    s === '23514' ||
    s === '23502' ||
    s === '22P02' ||
    s === '22001' ||
    s === '22003' ||
    s === '22021'
  )
    return new AppError('INVALID_REQUEST', 'Dữ liệu vi phạm ràng buộc', { reason: s });
  if (s === '57014' || s.startsWith('08') || s === '53300' || s === '57P01')
    return new AppError('DEPENDENCY_UNAVAILABLE', 'Cơ sở dữ liệu tạm thời không sẵn sàng');
  return undefined;
}

const CONN_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN']);
const CONN_MESSAGES = [
  /Connection terminated unexpectedly/i,
  /timeout exceeded when trying to connect/i,
  /Connection terminated due to connection timeout/i,
  /Client has encountered a connection error/i,
];

/**
 * Lỗi mất kết nối DB/Redis đi thẳng từ driver (pg, pg-pool, ioredis) — KHÔNG được Prisma bọc thành P1001/08xxx (kiểm thử
 * lát 2 lần 3, T3). Nhận diện theo `code` mạng (kể cả trong AggregateError) hoặc message chuẩn của pg/pg-pool.
 */
export function isConnectionError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 5) return false;
  const e = err as { code?: unknown; message?: unknown; errors?: unknown; cause?: unknown };
  if (typeof e.code === 'string' && CONN_CODES.has(e.code)) return true;
  if (typeof e.message === 'string' && CONN_MESSAGES.some((r) => r.test(e.message as string))) return true;
  if (Array.isArray(e.errors) && e.errors.some((x) => isConnectionError(x, depth + 1))) return true;
  return isConnectionError(e.cause, depth + 1);
}
