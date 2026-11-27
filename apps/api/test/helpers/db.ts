import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { applySqlMigrations, ROLE_PASSWORD_ENV } from '../../src/db/sql-migrations';

export const SQL_DIR = pathToFileURL(resolve(process.cwd(), '../../infra/sql') + '/');
export const PRISMA_DIR = pathToFileURL(resolve(process.cwd(), 'prisma/migrations') + '/');
export const TEST_PASSWORDS: Record<string, string> = Object.fromEntries(
  Object.values(ROLE_PASSWORD_ENV).map((k) => [k, `test-${k.toLowerCase()}-pw`]),
);

export interface MigratedDb {
  pg: StartedPostgreSqlContainer;
  ownerUrl: string;
  roleUrl(role: keyof typeof ROLE_PASSWORD_ENV): string;
  q(sql: string, params?: unknown[], url?: string): Promise<Record<string, unknown>[]>;
}

/** PostGIS thật + toàn bộ migration (infra/sql + prisma/migrations) — dùng chung cho test DB/API. */
export async function startMigratedDb(): Promise<MigratedDb> {
  const pg = await new PostgreSqlContainer('postgis/postgis:17-3.5').withUsername('owner').start();
  const ownerUrl = pg.getConnectionUri();
  await applySqlMigrations({
    url: ownerUrl,
    dir: SQL_DIR,
    prismaDir: PRISMA_DIR,
    env: TEST_PASSWORDS,
    log: () => undefined,
  });
  const roleUrl = (role: keyof typeof ROLE_PASSWORD_ENV) => {
    const u = new URL(ownerUrl);
    u.username = role;
    u.password = TEST_PASSWORDS[ROLE_PASSWORD_ENV[role]] ?? '';
    return u.toString();
  };
  const q = async (sql: string, params: unknown[] = [], url = ownerUrl) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      return (await c.query(sql, params)).rows as Record<string, unknown>[];
    } finally {
      await c.end();
    }
  };
  return { pg, ownerUrl, roleUrl, q };
}
