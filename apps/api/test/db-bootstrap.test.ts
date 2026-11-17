import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { copyFileSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySqlMigrations, ROLE_PASSWORD_ENV } from '../src/db/sql-migrations';

// Migration nền CP02 (ADR-011, ADR-017) chạy trên PostgreSQL + PostGIS THẬT.
const SQL_DIR = pathToFileURL(resolve(process.cwd(), '../../infra/sql') + '/');
const passwords = Object.fromEntries(Object.values(ROLE_PASSWORD_ENV).map((k) => [k, `test-${k.toLowerCase()}-pw`]));

describe('infra/sql bootstrap', () => {
  let pg: StartedPostgreSqlContainer;
  let ownerUrl: string;
  const q = async (sql: string, params: unknown[] = [], url = ownerUrl) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      return (await c.query(sql, params)).rows;
    } finally {
      await c.end();
    }
  };
  const roleUrl = (role: string) => {
    const u = new URL(ownerUrl);
    u.username = role;
    u.password = passwords[ROLE_PASSWORD_ENV[role as keyof typeof ROLE_PASSWORD_ENV]] ?? '';
    return u.toString();
  };

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgis/postgis:17-3.5').withUsername('owner').start();
    ownerUrl = pg.getConnectionUri();
    await applySqlMigrations({ url: ownerUrl, dir: SQL_DIR, env: passwords, log: () => undefined });
  });
  afterAll(async () => {
    await pg?.stop();
  });

  it('tạo đủ extension', async () => {
    const rows = await q(`SELECT extname FROM pg_extension WHERE extname = ANY($1) ORDER BY 1`, [
      ['pg_trgm', 'pgcrypto', 'postgis', 'unaccent'],
    ]);
    expect(rows.map((r) => r.extname)).toEqual(['pg_trgm', 'pgcrypto', 'postgis', 'unaccent']);
  });

  it('tạo đủ schema và 5 role đăng nhập, không role nào BYPASSRLS/SUPERUSER', async () => {
    const s = await q(`SELECT nspname FROM pg_namespace WHERE nspname = ANY($1) ORDER BY 1`, [
      ['audit', 'core', 'integration', 'reporting', 'reporting_private'],
    ]);
    expect(s).toHaveLength(5);
    const r = await q(
      `SELECT rolname, rolcanlogin, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = ANY($1) ORDER BY 1`,
      [Object.keys(ROLE_PASSWORD_ENV)],
    );
    expect(r.map((x) => x.rolname)).toEqual(Object.keys(ROLE_PASSWORD_ENV).sort());
    for (const x of r) expect([x.rolcanlogin, x.rolbypassrls, x.rolsuper]).toEqual([true, false, false]);
  });

  it('viewer_ro không có quyền vào core/audit/integration/reporting_private (FR-INV-11)', async () => {
    for (const schema of ['core', 'audit', 'integration', 'reporting_private', 'public']) {
      const [row] = await q(`SELECT has_schema_privilege('viewer_ro', $1, 'USAGE') AS u`, [schema]);
      expect({ schema, usage: row.u }).toEqual({ schema, usage: false });
    }
    const [r] = await q(`SELECT has_schema_privilege('viewer_ro', 'reporting', 'USAGE') AS u`);
    expect(r.u).toBe(true);
  });

  it('không role ứng dụng nào được tạo đối tượng trong schema (chỉ owner)', async () => {
    for (const role of Object.keys(ROLE_PASSWORD_ENV)) {
      for (const schema of ['core', 'reporting', 'reporting_private', 'audit', 'integration', 'public']) {
        const [row] = await q(`SELECT has_schema_privilege($1, $2, 'CREATE') AS c`, [role, schema]);
        expect({ role, schema, create: row.c }).toEqual({ role, schema, create: false });
      }
    }
  });

  it('function không mở EXECUTE cho PUBLIC; raise_immutable() chặn UPDATE/DELETE', async () => {
    const [p] = await q(`SELECT has_function_privilege('viewer_ro', 'core.raise_immutable()', 'EXECUTE') AS e`);
    expect(p.e).toBe(false);
    await q(`CREATE TABLE core._probe(id int); INSERT INTO core._probe VALUES (1);
             CREATE TRIGGER t BEFORE UPDATE OR DELETE ON core._probe FOR EACH ROW EXECUTE FUNCTION core.raise_immutable();`);
    await expect(q(`UPDATE core._probe SET id = 2`)).rejects.toThrow(/chỉ được thêm|append-only/i);
    await expect(q(`DELETE FROM core._probe`)).rejects.toThrow(/chỉ được thêm|append-only/i);
    await q(`DROP TABLE core._probe`);
  });

  it('bảng mới trong reporting KHÔNG tự mở SELECT cho viewer_ro (ADR-011)', async () => {
    await q(`CREATE TABLE reporting._probe(id int)`);
    const [r] = await q(`SELECT has_table_privilege('viewer_ro', 'reporting._probe', 'SELECT') AS s`);
    expect(r.s).toBe(false);
    await q(`DROP TABLE reporting._probe`);
  });

  it('role đăng nhập được bằng mật khẩu từ env; viewer_ro đọc core bị từ chối', async () => {
    await q(`CREATE TABLE core._secret(id int)`);
    await expect(q(`SELECT 1 AS ok`, [], roleUrl('app_rw'))).resolves.toEqual([{ ok: 1 }]);
    await expect(q(`SELECT * FROM core._secret`, [], roleUrl('viewer_ro'))).rejects.toThrow(/permission denied/i);
    await q(`DROP TABLE core._secret`);
  });

  it('chạy lại là idempotent; file đã áp mà bị sửa → từ chối', async () => {
    await expect(
      applySqlMigrations({ url: ownerUrl, dir: SQL_DIR, env: passwords, log: () => undefined }),
    ).resolves.toEqual({ applied: [] });
    const tmp = mkdtempSync(join(tmpdir(), 'sql-'));
    for (const f of readdirSync(SQL_DIR)) if (f.endsWith('.sql')) copyFileSync(new URL(f, SQL_DIR), join(tmp, f));
    writeFileSync(join(tmp, '000_bootstrap.sql'), '-- sửa ngầm\nSELECT 1;\n');
    await expect(
      applySqlMigrations({ url: ownerUrl, dir: pathToFileURL(tmp + '/'), env: passwords, log: () => undefined }),
    ).rejects.toThrow(/sha256/);
  });

  it('thiếu mật khẩu role → dừng, không đặt mật khẩu mặc định', async () => {
    const missing = Object.fromEntries(Object.entries(passwords).filter(([k]) => k !== 'PG_APP_RW_PASSWORD'));
    await expect(
      applySqlMigrations({ url: ownerUrl, dir: SQL_DIR, env: missing, log: () => undefined }),
    ).rejects.toThrow(/PG_APP_RW_PASSWORD/);
  });
});
