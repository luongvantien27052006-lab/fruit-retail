import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { applySqlMigrations } from './db/sql-migrations';

/** CLI: node dist/db-bootstrap.js — chạy infra/sql bằng role owner trước Prisma migrate (ADR-017). */
async function main(): Promise<void> {
  const url = process.env['DATABASE_URL_MIGRATE'];
  if (!url) throw new Error('Thiếu DATABASE_URL_MIGRATE');
  const dir = pathToFileURL(resolve(process.env['SQL_DIR'] ?? 'infra/sql') + '/');
  const { applied } = await applySqlMigrations({ url, dir, env: process.env });
  console.log(`[sql] xong — áp mới ${applied.length} file`);
}

main().catch((err: unknown) => {
  console.error('[sql] thất bại:', err instanceof Error ? err.message : err);
  process.exit(1);
});
