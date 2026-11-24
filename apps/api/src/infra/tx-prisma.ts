import type { TransactionHost } from '@nestjs-cls/transactional';
import type { PrismaService } from './prisma.service';

/** Token DI của client Prisma dùng cho nghiệp vụ (qua TransactionHost) — đã gắn chốt chặn ghi ngoài transaction. */
export const TX_PRISMA = Symbol('TX_PRISMA');

const WRITE_OPS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  '$executeRaw',
  '$executeRawUnsafe',
  // SQL thô có thể là INSERT/UPDATE … RETURNING — không phân biệt được đọc/ghi ⇒ cũng bắt buộc transaction
  '$queryRaw',
  '$queryRawUnsafe',
]);

/**
 * Mọi thao tác GHI qua client nghiệp vụ phải nằm trong transaction đang mở (ADR-016, kiểm thử lát 2 M6): không có
 * transaction (GET ghi dữ liệu, ghi "fire-and-forget" sau khi response đã trả) ⇒ ném lỗi thay vì ghi lẻ không audit.
 * `host` trả TransactionHost CỦA CHÍNH APP (không dùng TransactionHost.getInstance() tĩnh — nhiều app trong một process
 * sẽ đọc nhầm nhau). Đọc bằng Prisma ngoài transaction vẫn được; SQL thô ($queryRaw/$executeRaw) luôn cần transaction
 * (đọc thô thì đặt trong @Transactional).
 */
export function guardedPrisma(base: PrismaService, host: () => TransactionHost) {
  return base.$extends({
    name: 'write-requires-transaction',
    query: {
      $allOperations({ operation, model, args, query }) {
        if (WRITE_OPS.has(operation) && !host().isTransactionActive())
          throw new Error(
            `Ghi DB ngoài transaction bị chặn: ${model ?? 'raw'}.${operation} (mutation phải chạy trong MutationInterceptor/@Transactional)`,
          );
        return query(args);
      },
    },
  });
}

export type TxPrisma = ReturnType<typeof guardedPrisma>;
