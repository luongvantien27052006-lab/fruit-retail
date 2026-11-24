import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAppendOnlyPrivileges } from '../src/db/privilege-checks';
import { applySqlMigrations, ROLE_PASSWORD_ENV, validateRolePasswords } from '../src/db/sql-migrations';

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

  it('extension ở public; app_rw gọi được PostGIS/unaccent; viewer_ro không có USAGE public', async () => {
    const ext = await q(
      `SELECT e.extname, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
                         WHERE e.extname = ANY($1) ORDER BY 1`,
      [['pg_trgm', 'pgcrypto', 'postgis', 'unaccent']],
    );
    expect(ext.map((r) => r.nspname)).toEqual(['public', 'public', 'public', 'public']);
    await expect(
      q(`SELECT unaccent('Hoa quả Đà Lạt') AS u, ST_AsText(ST_MakePoint(106.7, 10.8)) AS p`, [], roleUrl('app_rw')),
    ).resolves.toEqual([{ u: 'Hoa qua Da Lat', p: 'POINT(106.7 10.8)' }]);
    await expect(q(`SELECT public.unaccent('á')`, [], roleUrl('viewer_ro'))).rejects.toThrow(/permission denied/i);
  });

  it('PUBLIC không có CONNECT/TEMP trên DB; role ứng dụng không tạo được bảng tạm', async () => {
    const [r] = await q(`SELECT has_database_privilege('public', current_database(), 'TEMP') AS t,
                                has_database_privilege('viewer_ro', current_database(), 'TEMP') AS vt,
                                has_database_privilege('viewer_ro', current_database(), 'CONNECT') AS vc`);
    expect(r).toEqual({ t: false, vt: false, vc: true });
  });

  it('projector_rw/viewer không có quyền mặc định trên bảng mới ở core/reporting (ADR-011)', async () => {
    await q(`CREATE TABLE core._p1(id int); CREATE TABLE reporting._p2(id int)`);
    const rows =
      await q(`SELECT r, t, has_table_privilege(r, t, 'SELECT') AS s, has_table_privilege(r, t, 'UPDATE') AS u
                          FROM unnest(ARRAY['projector_rw','viewer_ro','viewer_act','audit_writer']) r,
                               unnest(ARRAY['core._p1','reporting._p2']) t`);
    expect(rows.filter((x) => x.s || x.u)).toEqual([]);
    await q(`DROP TABLE core._p1; DROP TABLE reporting._p2`);
  });

  it('function tạo mới cũng không mở EXECUTE cho PUBLIC (default privileges)', async () => {
    await q(`CREATE FUNCTION core._f() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
    const [r] = await q(`SELECT has_function_privilege('viewer_ro', 'core._f()', 'EXECUTE') AS v,
                                has_function_privilege('app_rw', 'core._f()', 'EXECUTE') AS a`);
    expect(r).toEqual({ v: false, a: false });
    await q(`DROP FUNCTION core._f()`);
  });

  it('mật khẩu role lưu dạng SCRAM-SHA-256 (bộ chạy chỉ gửi verifier)', async () => {
    const rows = await q(`SELECT rolname, left(rolpassword, 14) AS p FROM pg_authid WHERE rolname = ANY($1)`, [
      Object.keys(ROLE_PASSWORD_ENV),
    ]);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.p).toBe('SCRAM-SHA-256$');
  });

  it('nội dung 000_bootstrap.sql chạy lại trực tiếp không lỗi (idempotent thật)', async () => {
    const sql = readFileSync(new URL('000_bootstrap.sql', SQL_DIR), 'utf8');
    await q(sql); // ném lỗi → test đỏ
    await q(sql);
    const [r] = await q(`SELECT count(*)::int AS n FROM integration.sql_migrations`);
    expect(r.n).toBe(readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).length);
  });

  it('checkAppendOnlyPrivileges bắt bảng chỉ-thêm quên REVOKE, hết lỗi sau khi REVOKE', async () => {
    await q(`CREATE TABLE core._ledger(id int);
             CREATE TRIGGER t BEFORE UPDATE OR DELETE ON core._ledger FOR EACH ROW EXECUTE FUNCTION core.raise_immutable();`);
    const c = new Client({ connectionString: ownerUrl });
    await c.connect();
    try {
      const before = await checkAppendOnlyPrivileges(c);
      expect(before).toContainEqual({ table: 'core._ledger', role: 'app_rw', privilege: 'UPDATE' });
      await c.query(
        `REVOKE UPDATE, DELETE, TRUNCATE ON core._ledger FROM app_rw, projector_rw, viewer_ro, viewer_act, audit_writer`,
      );
      expect(await checkAppendOnlyPrivileges(c)).toEqual([]);
    } finally {
      await c.end();
    }
    await q(`DROP TABLE core._ledger`);
  });

  it('file đã áp mà bị xóa khỏi thư mục → từ chối', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sql-empty-'));
    await expect(
      applySqlMigrations({ url: ownerUrl, dir: pathToFileURL(tmp + '/'), env: passwords, log: () => undefined }),
    ).rejects.toThrow(/không còn trong thư mục/);
  });

  it('validateRolePasswords: từ chối change-me, trùng nhau, và < 24 ký tự ở staging/production', () => {
    expect(() => validateRolePasswords({ ...passwords, PG_APP_RW_PASSWORD: 'change-me-app-rw-password' })).toThrow(
      /change-me/,
    );
    expect(() =>
      validateRolePasswords({ ...passwords, PG_VIEWER_RO_PASSWORD: passwords['PG_APP_RW_PASSWORD'] }),
    ).toThrow(/trùng/);
    const short = Object.fromEntries(Object.keys(passwords).map((k, i) => [k, `short-pw-${i}-abcd`]));
    expect(() => validateRolePasswords(short)).not.toThrow();
    expect(() => validateRolePasswords({ ...short, NODE_ENV: 'production' })).toThrow(/< 24/);
    expect(() => validateRolePasswords({ ...passwords, PG_OWNER_PASSWORD: 'change-me-owner-password' })).toThrow(
      /PG_OWNER_PASSWORD/,
    );
    expect(() => validateRolePasswords(passwords)).not.toThrow();
  });

  it('thiếu mật khẩu role → dừng, không đặt mật khẩu mặc định', async () => {
    const missing = Object.fromEntries(Object.entries(passwords).filter(([k]) => k !== 'PG_APP_RW_PASSWORD'));
    await expect(
      applySqlMigrations({ url: ownerUrl, dir: SQL_DIR, env: missing, log: () => undefined }),
    ).rejects.toThrow(/PG_APP_RW_PASSWORD/);
  });
});
