import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAppendOnlyPrivileges, checkNoKeyUpdate, checkViewerRls } from '../src/db/privilege-checks';
import {
  applyOneMigration,
  applySqlMigrations,
  assertNoTransactionControl,
  listMigrations,
  ROLE_PASSWORD_ENV,
} from '../src/db/sql-migrations';

// CP03 lát 1 — schema nền (M02 + M03 tối thiểu) trên PostgreSQL + PostGIS THẬT (ADR-011, ADR-020).
const SQL_DIR = pathToFileURL(resolve(process.cwd(), '../../infra/sql') + '/');
const PRISMA_DIR = pathToFileURL(resolve(process.cwd(), 'prisma/migrations') + '/');
const passwords = Object.fromEntries(Object.values(ROLE_PASSWORD_ENV).map((k) => [k, `test-${k.toLowerCase()}-pw`]));
const id = () => randomUUID();
const h32 = () => randomBytes(32);

describe('0001_foundation', () => {
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
  const priv = async (role: string, table: string, p: string) =>
    (await q(`SELECT has_table_privilege($1, $2, $3) AS ok`, [role, table, p]))[0].ok as boolean;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgis/postgis:17-3.5').withUsername('owner').start();
    ownerUrl = pg.getConnectionUri();
    await applySqlMigrations({
      url: ownerUrl,
      dir: SQL_DIR,
      prismaDir: PRISMA_DIR,
      env: passwords,
      log: () => undefined,
    });
  });
  afterAll(async () => {
    await pg?.stop();
  });

  it('áp đúng thứ tự: infra/sql (000, 001) rồi prisma/0001…; chạy lại không áp gì', async () => {
    const rows = await q(`SELECT file FROM integration.sql_migrations ORDER BY applied_at, file`);
    expect(rows.map((r) => r.file)).toEqual([
      '000_bootstrap.sql',
      '001_extension_privileges.sql',
      'prisma/0001_foundation',
      'prisma/0002_auth_totp_replay',
      'prisma/0003_pos_enrollment_codes',
      'prisma/0004_nc19_permissions',
      'prisma/0005_nc21_grant_guard',
      'prisma/0006_files_final_key',
      'prisma/0007_password_change',
      'prisma/0008_auth_lockouts',
      'prisma/0009_catalog',
    ]);
    await expect(
      applySqlMigrations({ url: ownerUrl, dir: SQL_DIR, prismaDir: PRISMA_DIR, env: passwords, log: () => undefined }),
    ).resolves.toEqual({ applied: [] });
  });

  it('Prisma schema khớp DB sau migration (không lệch — ADR-003/020)', () => {
    const run = () =>
      execFileSync(
        process.execPath,
        [
          resolve(process.cwd(), 'node_modules/prisma/build/index.js'),
          'migrate',
          'diff',
          '--from-config-datasource',
          '--to-schema=prisma/schema.prisma',
          '--exit-code',
        ],
        { env: { ...process.env, DATABASE_URL_MIGRATE: ownerUrl }, encoding: 'utf8', stdio: 'pipe' },
      );
    // --exit-code: 0 = không lệch; 2 = lệch → execFileSync ném lỗi, in chi tiết bảng/cột lệch
    let out: string;
    try {
      out = run();
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      throw new Error(`prisma migrate diff exit ${err.status}:\n${err.stdout ?? ''}\n${err.stderr ?? ''}`, {
        cause: e,
      });
    }
    expect(out).not.toMatch(/\[[+*-]\]/);
  });

  it('app_rw: S/I trên core, UPDATE chỉ theo cột, không DELETE (trừ bảng tạm đã liệt kê); không sửa bảng mã quyền', async () => {
    for (const t of ['core.users', 'core.staff', 'core.sessions', 'core.pos_devices', 'core.files', 'core.stores']) {
      expect({
        t,
        s: await priv('app_rw', t, 'SELECT'),
        i: await priv('app_rw', t, 'INSERT'),
        u: await priv('app_rw', t, 'UPDATE'), // cả bảng — false; chỉ có GRANT UPDATE (cột)
        d: await priv('app_rw', t, 'DELETE'),
      }).toEqual({ t, s: true, i: true, u: false, d: false });
    }
    const [c] = await q(`SELECT has_column_privilege('app_rw', 'core.users', 'status', 'UPDATE') AS st,
                                has_column_privilege('app_rw', 'core.users', 'type', 'UPDATE') AS ty`);
    expect(c).toEqual({ st: true, ty: false });
    for (const t of [
      'core.otp_challenges',
      'core.auth_challenges',
      'core.recovery_codes',
      'core.viewer_profile_assignments',
    ])
      expect({ t, d: await priv('app_rw', t, 'DELETE') }).toEqual({ t, d: true });
    for (const t of ['core.permissions', 'core.role_permissions'])
      expect({
        t,
        s: await priv('app_rw', t, 'SELECT'),
        i: await priv('app_rw', t, 'INSERT'),
        u: await priv('app_rw', t, 'UPDATE'),
      }).toEqual({ t, s: true, i: false, u: false });
  });

  it('audit.* chỉ-thêm: không role ứng dụng nào UPDATE/DELETE/TRUNCATE; trigger chặn cả owner khi chạy thường', async () => {
    expect(await checkAppendOnlyPrivileges(await connected())).toEqual([]);
    expect(await priv('app_rw', 'audit.logs', 'INSERT')).toBe(true);
    expect(await priv('app_rw', 'audit.login_logs', 'INSERT')).toBe(false);
    expect(await priv('audit_writer', 'audit.login_logs', 'INSERT')).toBe(true);
    expect(await priv('audit_writer', 'audit.logs', 'INSERT')).toBe(false);
    expect(await priv('viewer_act', 'audit.viewer_access', 'INSERT')).toBe(true);
    expect(await priv('viewer_act', 'audit.viewer_access', 'SELECT')).toBe(false);
    const logId = id();
    await q(
      `INSERT INTO audit.logs (id, action, resource_type) VALUES ($1, 'test.create', 'probe')`,
      [logId],
      roleUrl('app_rw'),
    );
    await expect(q(`UPDATE audit.logs SET reason = 'x' WHERE id = $1`, [logId], roleUrl('app_rw'))).rejects.toThrow(
      /permission denied/,
    );
    await expect(q(`UPDATE audit.logs SET reason = 'x' WHERE id = $1`, [logId])).rejects.toThrow(/append-only/);
    await expect(q(`DELETE FROM audit.logs WHERE id = $1`, [logId])).rejects.toThrow(/append-only/);
    await expect(q(`TRUNCATE audit.logs`)).rejects.toThrow(/append-only/);
  });

  it('outbox: app_rw cập nhật được trạng thái phát nhưng không sửa payload/event_type', async () => {
    const eid = id();
    await q(
      `INSERT INTO integration.outbox (id, event_type, schema_version, aggregate_type, aggregate_id, payload, occurred_at)
       VALUES ($1, 'user.created', 1, 'user', 'u1', '{}'::jsonb, now())`,
      [eid],
      roleUrl('app_rw'),
    );
    await q(
      `UPDATE integration.outbox SET published_at = now(), attempts = attempts + 1 WHERE id = $1`,
      [eid],
      roleUrl('app_rw'),
    );
    await expect(
      q(`UPDATE integration.outbox SET payload = '{"x":1}' WHERE id = $1`, [eid], roleUrl('app_rw')),
    ).rejects.toThrow(/permission denied/);
    await expect(
      q(`UPDATE integration.outbox SET event_type = 'a.b' WHERE id = $1`, [eid], roleUrl('app_rw')),
    ).rejects.toThrow(/permission denied/);
    await expect(q(`DELETE FROM integration.outbox WHERE id = $1`, [eid], roleUrl('app_rw'))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      q(
        `INSERT INTO integration.outbox (id, event_type, schema_version, aggregate_type, aggregate_id, payload, occurred_at)
         VALUES ($1, 'Sai Dinh Dang', 1, 'x', 'x', '{}', now())`,
        [id()],
      ),
    ).rejects.toThrow(/outbox_values/);
  });

  it('processed_events idempotent theo (consumer, event_id); projector_rw ghi được', async () => {
    const ev = id();
    await q(
      `INSERT INTO integration.processed_events (consumer, event_id) VALUES ('proj', $1)`,
      [ev],
      roleUrl('projector_rw'),
    );
    await expect(
      q(
        `INSERT INTO integration.processed_events (consumer, event_id) VALUES ('proj', $1)`,
        [ev],
        roleUrl('projector_rw'),
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('T17 — viewer_ro không có quyền nào ngoài reporting; đọc core.users → permission denied', async () => {
    const leaks = await q(
      `SELECT format('%I.%I', n.nspname, c.relname) AS t
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p','v','m') AND n.nspname IN ('core','audit','integration','reporting_private','public')
         AND (has_table_privilege('viewer_ro', c.oid, 'SELECT') OR has_table_privilege('viewer_ro', c.oid, 'INSERT')
              OR has_table_privilege('viewer_ro', c.oid, 'UPDATE') OR has_table_privilege('viewer_ro', c.oid, 'DELETE'))`,
    );
    expect(leaks).toEqual([]);
    await expect(q(`SELECT * FROM core.users`, [], roleUrl('viewer_ro'))).rejects.toThrow(/permission denied/);
    await expect(q(`SELECT * FROM audit.logs`, [], roleUrl('viewer_ro'))).rejects.toThrow(/permission denied/);
    await expect(q(`SELECT * FROM reporting_private.viewer_profile_scopes`, [], roleUrl('viewer_ro'))).rejects.toThrow(
      /permission denied/,
    );
    expect(await checkViewerRls(await connected())).toEqual([]);
  });

  it('viewer_ro chỉ EXECUTE được current_profile() và allowed_stores()', async () => {
    const rows = await q(
      `SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS f
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('core','reporting','reporting_private','audit','integration')
         AND has_function_privilege('viewer_ro', p.oid, 'EXECUTE') ORDER BY 1`,
    );
    expect(rows.map((r) => r.f)).toEqual(['reporting.allowed_stores()', 'reporting.current_profile()']);
  });

  it('RLS khung: bảng reporting theo mẫu ADR-011 lọc đúng cửa hàng của hồ sơ; thiếu hồ sơ → 0 dòng', async () => {
    const [a, b] = [id(), id()];
    const profile = id();
    await q(`INSERT INTO core.stores (id, code, name) VALUES ($1, 'RLS-A', 'A'), ($2, 'RLS-B', 'B')`, [a, b]);
    await q(
      `INSERT INTO core.viewer_profiles (id, code, name, modules, customer_visibility, cost_visibility, supplier_visibility, pos_control_visibility)
       VALUES ($1, 'ONLY_A', 'Chỉ A', '{}', 'AGGREGATE', 'SNAPSHOT_ACTUAL', 'HIDDEN', 'HIDDEN')`,
      [profile],
    );
    await q(
      `INSERT INTO reporting_private.viewer_profile_scopes (profile_id, store_id) VALUES ($1, $2)`,
      [profile, a],
      roleUrl('app_rw'),
    );
    await q(`CREATE TABLE reporting._rls_probe (store_id uuid NOT NULL, v int);
             ALTER TABLE reporting._rls_probe ENABLE ROW LEVEL SECURITY;
             ALTER TABLE reporting._rls_probe FORCE ROW LEVEL SECURITY;
             CREATE POLICY viewer ON reporting._rls_probe FOR SELECT TO viewer_ro
               USING (store_id = ANY (reporting.allowed_stores()));
             GRANT SELECT ON reporting._rls_probe TO viewer_ro;`);
    await q(`INSERT INTO reporting._rls_probe VALUES ($1, 1), ($2, 2)`, [a, b]);
    expect(await checkViewerRls(await connected())).toEqual([]);
    const asViewer = async (p: string | null) => {
      const c = new Client({ connectionString: roleUrl('viewer_ro') });
      await c.connect();
      try {
        await c.query('BEGIN');
        if (p) await c.query(`SELECT set_config('app.viewer_profile_id', $1, true)`, [p]);
        return (await c.query(`SELECT v FROM reporting._rls_probe ORDER BY v`)).rows.map((r) => r.v);
      } finally {
        await c.query('ROLLBACK');
        await c.end();
      }
    };
    expect(await asViewer(null)).toEqual([]);
    expect(await asViewer(profile)).toEqual([1]);
    expect(await asViewer(id())).toEqual([]); // hồ sơ không tồn tại
    // Hồ sơ toàn chuỗi (seed SHAREHOLDER) thấy mọi cửa hàng chưa lưu trữ
    const [sh] = await q(`SELECT id FROM core.viewer_profiles WHERE code = 'SHAREHOLDER'`);
    expect(await asViewer(sh.id)).toEqual([1, 2]);
    // Hồ sơ đã lưu trữ → 0 dòng
    await q(`UPDATE core.viewer_profiles SET archived_at = now() WHERE id = $1`, [profile]);
    expect(await asViewer(profile)).toEqual([]);
    // Quên FORCE/policy → bộ kiểm bắt được
    await q(`ALTER TABLE reporting._rls_probe NO FORCE ROW LEVEL SECURITY`);
    expect(await checkViewerRls(await connected())).toEqual([
      { table: 'reporting._rls_probe', problem: 'RLS_NOT_FORCED' },
    ]);
    await q(`DROP TABLE reporting._rls_probe`);
  });

  it('seed mã quyền phủ mọi x-permission trong openapi.yaml (trừ mã giả); vai trò đúng ma trận §2.2', async () => {
    const yaml = readFileSync(resolve(process.cwd(), '../../packages/contracts/openapi.yaml'), 'utf8');
    const used = new Set<string>();
    for (const m of yaml.matchAll(/x-permission:\s*['"]?([a-z_]+:[a-z_*-]+)/g)) if (m[1]) used.add(m[1]);
    // x-permission-map ('SPOILAGE': 'spoilage:approve', …)
    for (const m of yaml.matchAll(/^\s+'[A-Z_]+':\s*'([a-z_]+:[a-z_]+)'/gm)) if (m[1]) used.add(m[1]);
    const pseudo = new Set(['auth:*', 'mfa:challenge', 'approval:by-type', 'webhook:sepay', 'webhook:courier']);
    const codes = new Set((await q(`SELECT code FROM core.permissions`)).map((r) => r.code as string));
    const missing = [...used].filter((c) => !pseudo.has(c) && !codes.has(c)).sort();
    expect(missing).toEqual([]);
    const rp = async (role: string) =>
      (await q(`SELECT permission_code FROM core.role_permissions WHERE role = $1 ORDER BY 1`, [role])).map(
        (r) => r.permission_code,
      );
    expect(await rp('VIEW_ONLY_ADMIN')).toEqual(['viewer:read']);
    expect(await rp('CUSTOMER')).toEqual(['customer:self']);
    expect(await rp('SHIPPER')).toEqual(['cod:remit', 'shipper:deliver']);
    const master = await rp('MASTER_ADMIN');
    expect(master).not.toContain('viewer:read');
    expect(master).toContain('purchase_price:write');
    expect(master.length).toBe(codes.size - 3);
    expect(await rp('WAREHOUSE_STAFF')).not.toContain('purchase_price:write'); // chỉ cấp riêng (§2.1)
    for (const r of ['STORE_MANAGER', 'CASHIER', 'PICKER']) expect(await rp(r)).not.toContain('purchase_price:read');
    // Mỗi vai trò có ít nhất một quyền; số dòng khớp danh sách trong migration (mã gõ sai sẽ làm thiếu dòng)
    const counts = Object.fromEntries(
      (await q(`SELECT role::text, count(*)::int AS n FROM core.role_permissions GROUP BY 1`)).map((r) => [
        r.role,
        r.n,
      ]),
    );
    expect(counts).toMatchObject({ STORE_MANAGER: 36, CASHIER: 14, PICKER: 9, WAREHOUSE_STAFF: 15 });
  });

  it('hạn mức duyệt §2.3 đúng giá trị', async () => {
    const rows = await q(
      `SELECT role::text, action::text, max_amount::text AS amt, max_pct_bp AS pct, same_day_only AS day
       FROM core.approval_limits WHERE role = 'STORE_MANAGER' ORDER BY action`,
    );
    const byAction = Object.fromEntries(rows.map((r) => [r.action, { amt: r.amt, pct: r.pct, day: r.day }]));
    expect(byAction).toMatchObject({
      SALE_VOID: { amt: '500000', pct: null, day: true },
      REFUND: { amt: '200000', pct: null },
      SPOILAGE_APPROVE: { amt: '1000000', pct: null },
      STOCKTAKE_ADJUST: { amt: '1000000', pct: 200 },
    });
    // NC-21: không còn giảm giá tay; giảm giá cận hạn chỉ Master duyệt
    expect(Object.keys(byAction)).not.toContain('LINE_DISCOUNT');
    expect(Object.keys(byAction)).not.toContain('MARKDOWN');
    // NC-19(a): cửa hàng trưởng không bán / xóa dòng / xử lý đơn app (đọc chặt §2.2)
    const sm = (await q(`SELECT permission_code FROM core.role_permissions WHERE role = 'STORE_MANAGER'`)).map(
      (x) => x.permission_code,
    );
    for (const c of ['pos:sell', 'pos:void_line', 'app_order:manage', 'markdown:approve', 'pos:discount'])
      expect(sm).not.toContain(c);
    // NC-19(d): Master không có hạn mức xóa dòng / mở két không bán, và không thêm vào được
    for (const action of ['LINE_DELETE', 'NO_SALE_OPEN'])
      await expect(
        q(
          `INSERT INTO core.approval_limits (role, action, allowed) VALUES ('MASTER_ADMIN', $1, true)`,
          [action],
          roleUrl('app_rw'),
        ),
      ).rejects.toThrow(/approval_limits_master_forbidden/);
    expect(await q(`SELECT 1 FROM core.approval_limits WHERE action = 'LINE_DISCOUNT'`)).toEqual([]);
    expect(await q(`SELECT role::text FROM core.approval_limits WHERE action = 'MARKDOWN'`)).toEqual([
      { role: 'MASTER_ADMIN' },
    ]);
    await expect(
      q(
        `INSERT INTO core.approval_limits (role, action, allowed) VALUES ('STORE_MANAGER', 'MARKDOWN', true)`,
        [],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/approval_limits_markdown_master_only/);
    await expect(
      q(
        `INSERT INTO core.approval_limits (role, action, allowed) VALUES ('CASHIER', 'LINE_DISCOUNT', true)`,
        [],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/approval_limits_no_line_discount/);
    expect(await q(`SELECT 1 FROM core.permissions WHERE code = 'pos:discount'`)).toEqual([]);
    for (const r of ['MASTER_ADMIN', 'STORE_MANAGER']) {
      const codes = (await q(`SELECT permission_code FROM core.role_permissions WHERE role = $1`, [r])).map(
        (x) => x.permission_code,
      );
      expect(codes).toEqual(expect.arrayContaining(['zone:read', 'pos_log:read']));
      if (r === 'STORE_MANAGER') expect(codes).not.toContain('markdown:approve');
      if (r === 'MASTER_ADMIN') expect(codes).toContain('markdown:approve');
    }
    const cashier = await q(`SELECT action::text FROM core.approval_limits WHERE role = 'CASHIER'`);
    expect(cashier.map((r) => r.action)).toEqual(['LINE_DELETE']);
  });

  it('vai trò phải hợp loại người dùng + phạm vi tồn tại; một gán đang hiệu lực mỗi phạm vi', async () => {
    const store = id();
    await q(`INSERT INTO core.stores (id, code, name) VALUES ($1, 'CH-T1', 'Cửa hàng thử')`, [store]);
    const staff = id();
    const master = id();
    await q(`INSERT INTO core.users (id, type) VALUES ($1, 'STAFF')`, [staff], roleUrl('app_rw'));
    await q(
      `INSERT INTO core.users (id, type, email, password_hash) VALUES ($1, 'MASTER', $2, 'x')`,
      [master, `m${Date.now()}@example.test`],
      roleUrl('app_rw'),
    );
    const ins = (u: string, role: string, st: string, sid: string | null) =>
      q(
        `INSERT INTO core.user_role_assignments (id, user_id, role, scope_type, scope_id) VALUES ($1, $2, $3, $4, $5)`,
        [id(), u, role, st, sid],
        roleUrl('app_rw'),
      );
    await ins(staff, 'CASHIER', 'STORE', store);
    await expect(ins(staff, 'CASHIER', 'STORE', store)).rejects.toThrow(/ura_active_unique/);
    await expect(ins(staff, 'MASTER_ADMIN', 'ALL', null)).rejects.toThrow(/không hợp/);
    await expect(ins(master, 'CASHIER', 'STORE', store)).rejects.toThrow(/không hợp/);
    await expect(ins(staff, 'PICKER', 'STORE', id())).rejects.toThrow(/không phải cửa hàng/);
    await expect(ins(staff, 'PICKER', 'ALL', null)).rejects.toThrow(/không hợp/);
    await expect(ins(staff, 'PICKER', 'STORE', null)).rejects.toThrow(/ura_scope_shape/);
    await ins(master, 'MASTER_ADMIN', 'ALL', null);
  });

  it('ràng buộc người dùng: admin cần email+mật khẩu, email chữ thường, PIN chỉ cho nhân viên, SĐT mã hóa đi cặp', async () => {
    const ins = (cols: string, vals: unknown[]) =>
      q(
        `INSERT INTO core.users (id, ${cols}) VALUES ($1, ${vals.map((_, i) => `$${i + 2}`).join(', ')})`,
        [id(), ...vals],
        roleUrl('app_rw'),
      );
    await expect(ins('type', ['MASTER'])).rejects.toThrow(/users_admin_credentials/);
    await expect(ins('type, email, password_hash', ['VIEWER', 'Upper@Example.test', 'x'])).rejects.toThrow(
      /users_email_lower/,
    );
    await expect(ins('type, pin_hash', ['CUSTOMER', 'x'])).rejects.toThrow(/users_customer_phone|users_pin_staff_only/);
    await expect(ins('type, phone_hash', ['CUSTOMER', h32()])).rejects.toThrow(/users_phone_pair/);
    await ins('type, phone_hash, phone_enc', ['CUSTOMER', h32(), randomBytes(40)]);
    const cols = await q(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'core' AND column_name ~ '(phone|address)' AND data_type <> 'bytea'
         AND table_name NOT IN ('stores', 'warehouses', 'brand_settings')`, // địa chỉ cửa hàng/kho/thương hiệu: công khai
    );
    expect(cols).toEqual([]); // không có cột SĐT/địa chỉ dạng rõ (ADR-015)
  });

  it('thiết bị POS: trạng thái chỉ đi tới, khóa bất biến; phiên nhân viên bắt buộc gắn thiết bị', async () => {
    const store = id();
    await q(`INSERT INTO core.stores (id, code, name) VALUES ($1, 'CH-T2', 'Thử 2')`, [store]);
    const dev = id();
    const approver = id();
    await q(
      `INSERT INTO core.pos_devices (id, store_id, name, platform, public_key, fingerprint) VALUES ($1, $2, 'Quầy 1', 'windows', $3, $4)`,
      [dev, store, h32(), h32()],
      roleUrl('app_rw'),
    );
    await expect(
      q(`UPDATE core.pos_devices SET status = 'ACTIVE' WHERE id = $1`, [dev], roleUrl('app_rw')),
    ).rejects.toThrow(/pos_devices_state/);
    await q(
      `UPDATE core.pos_devices SET status = 'ACTIVE', activated_at = now(), activated_by = $2 WHERE id = $1`,
      [dev, approver],
      roleUrl('app_rw'),
    );
    await expect(
      q(`UPDATE core.pos_devices SET public_key = $2 WHERE id = $1`, [dev, h32()], roleUrl('app_rw')),
    ).rejects.toThrow(/permission denied/); // app_rw không có UPDATE(public_key); owner bị trigger chặn
    await q(
      `UPDATE core.pos_devices SET status = 'REVOKED', revoked_at = now(), revoked_by = $2 WHERE id = $1`,
      [dev, approver],
      roleUrl('app_rw'),
    );
    await expect(
      q(
        `UPDATE core.pos_devices SET status = 'ACTIVE', revoked_at = NULL, revoked_by = NULL WHERE id = $1`,
        [dev],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/đã thu hồi không sửa được/);
    const staff = id();
    await q(`INSERT INTO core.users (id, type) VALUES ($1, 'STAFF')`, [staff], roleUrl('app_rw'));
    await expect(
      q(
        `INSERT INTO core.sessions (id, user_id, user_type, expires_at) VALUES ($1, $2, 'STAFF', now() + interval '1 day')`,
        [id(), staff],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/sessions_staff_device/);
  });

  it('thử thách 2FA/OTP: tối đa 5 lần thử, hạn ≤ 10 phút', async () => {
    const u = id();
    await q(`INSERT INTO core.users (id, type, email, password_hash) VALUES ($1, 'MASTER', $2, 'x')`, [
      u,
      `c${Date.now()}@example.test`,
    ]);
    await expect(
      q(
        `INSERT INTO core.auth_challenges (id, kind, user_id, secret_hash, expires_at) VALUES ($1, 'MFA', $2, $3, now() + interval '1 hour')`,
        [id(), u, h32()],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/auth_challenges_ttl/);
    await expect(
      q(
        `INSERT INTO core.otp_challenges (id, phone_hash, code_hash, attempts, expires_at) VALUES ($1, $2, 'x', 6, now() + interval '5 minutes')`,
        [id(), h32()],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/otp_attempts/);
  });

  // ───── Sửa theo kiểm thử agent lần 1 (C1, T1–T6, L1–L8) ─────

  const newStore = async (code: string) => {
    const s = id();
    await q(`INSERT INTO core.stores (id, code, name) VALUES ($1, $2, $2)`, [s, code]);
    return s;
  };
  const newUser = async (type: string) => {
    const u = id();
    if (type === 'MASTER' || type === 'VIEWER')
      await q(`INSERT INTO core.users (id, type, email, password_hash) VALUES ($1, $2, $3, 'x')`, [
        u,
        type,
        `${u}@example.test`,
      ]);
    else if (type === 'CUSTOMER')
      await q(`INSERT INTO core.users (id, type, phone_hash, phone_enc) VALUES ($1, 'CUSTOMER', $2, $3)`, [
        u,
        h32(),
        randomBytes(40),
      ]);
    else await q(`INSERT INTO core.users (id, type) VALUES ($1, $2)`, [u, type]);
    return u;
  };
  const newDevice = async (store: string, register: string | null = null) => {
    const d = id();
    await q(
      `INSERT INTO core.pos_devices (id, store_id, register_id, name, platform, public_key, fingerprint) VALUES ($1, $2, $3, 'Q', 'windows', $4, $5)`,
      [d, store, register, h32(), h32()],
      roleUrl('app_rw'),
    );
    return d;
  };

  it('C1 — users.type bất biến; thu hồi vai trò được và là kết thúc; không đổi vai trò tại chỗ', async () => {
    const store = await newStore('C1-S');
    const staff = await newUser('STAFF');
    const master = await newUser('MASTER');
    const ura = id();
    await q(
      `INSERT INTO core.user_role_assignments (id, user_id, role, scope_type, scope_id) VALUES ($1, $2, 'STORE_MANAGER', 'STORE', $3)`,
      [ura, staff, store],
      roleUrl('app_rw'),
    );
    await expect(q(`UPDATE core.users SET type = 'MASTER' WHERE id = $1`, [staff], roleUrl('app_rw'))).rejects.toThrow(
      /permission denied/,
    );
    await expect(q(`UPDATE core.users SET type = 'MASTER' WHERE id = $1`, [staff])).rejects.toThrow(
      /không đổi được id\/type/,
    );
    await expect(
      q(`UPDATE core.user_role_assignments SET role = 'CASHIER' WHERE id = $1`, [ura], roleUrl('app_rw')),
    ).rejects.toThrow(/permission denied/);
    await expect(q(`UPDATE core.user_role_assignments SET role = 'CASHIER' WHERE id = $1`, [ura])).rejects.toThrow(
      /chỉ được thu hồi/,
    );
    await q(
      `UPDATE core.user_role_assignments SET revoked_at = now(), revoked_by = $2 WHERE id = $1`,
      [ura, master],
      roleUrl('app_rw'),
    );
    await expect(
      q(
        `UPDATE core.user_role_assignments SET revoked_at = NULL, revoked_by = NULL WHERE id = $1`,
        [ura],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/đã thu hồi không sửa được/);
    await expect(
      q(
        `INSERT INTO core.user_role_assignments (id, user_id, role, scope_type, revoked_at, revoked_by) VALUES ($1, $2, 'MASTER_ADMIN', 'ALL', now(), $2)`,
        [id(), master],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/không tạo dòng đã thu hồi/);
    // cửa hàng đã lưu trữ không nhận làm phạm vi
    await q(`UPDATE core.stores SET archived_at = now() WHERE id = $1`, [store]);
    await expect(
      q(
        `INSERT INTO core.user_role_assignments (id, user_id, role, scope_type, scope_id) VALUES ($1, $2, 'CASHIER', 'STORE', $3)`,
        [id(), staff, store],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/không phải cửa hàng đang hoạt động/);
  });

  it('L1 — không role ứng dụng nào UPDATE được cột khóa chính (mọi bảng)', async () => {
    expect(await checkNoKeyUpdate(await connected())).toEqual([]);
  });

  it('T1 — phiên: user_type phải đúng loại; phiên nhân viên chỉ trên thiết bị ACTIVE; thu hồi là kết thúc; trần 60 ngày', async () => {
    const store = await newStore('T1-S');
    const staff = await newUser('STAFF');
    const master = await newUser('MASTER');
    const ins = (sid: string, u: string, ut: string, dev: string | null, exp = `now() + interval '1 day'`) =>
      q(
        `INSERT INTO core.sessions (id, user_id, user_type, pos_device_id, expires_at) VALUES ($1, $2, $3, $4, ${exp})`,
        [sid, u, ut, dev],
        roleUrl('app_rw'),
      );
    await expect(ins(id(), staff, 'MASTER', null)).rejects.toThrow(/khác loại người dùng/);
    const dev = await newDevice(store);
    await expect(ins(id(), staff, 'STAFF', dev)).rejects.toThrow(/phải ACTIVE/); // PENDING
    await q(
      `UPDATE core.pos_devices SET status = 'ACTIVE', activated_at = now(), activated_by = $2 WHERE id = $1`,
      [dev, master],
      roleUrl('app_rw'),
    );
    await expect(ins(id(), master, 'MASTER', dev)).rejects.toThrow(/chỉ cho phiên nhân viên/);
    await expect(ins(id(), master, 'MASTER', null, `now() + interval '61 days'`)).rejects.toThrow(/sessions_times/);
    const sid = id();
    await ins(sid, staff, 'STAFF', dev);
    await q(
      `UPDATE core.sessions SET revoked_at = now(), revoke_reason = 'test' WHERE id = $1`,
      [sid],
      roleUrl('app_rw'),
    );
    await expect(
      q(`UPDATE core.sessions SET revoked_at = NULL WHERE id = $1`, [sid], roleUrl('app_rw')),
    ).rejects.toThrow(/đã thu hồi/);
    await q(
      `UPDATE core.pos_devices SET status = 'REVOKED', revoked_at = now(), revoked_by = $2 WHERE id = $1`,
      [dev, master],
      roleUrl('app_rw'),
    );
    await expect(ins(id(), staff, 'STAFF', dev)).rejects.toThrow(/phải ACTIVE/);
  });

  it('L1 — refresh token đã xoay không "hồi sinh", không chuyển phiên, không trỏ chính nó', async () => {
    const master = await newUser('MASTER');
    const s1 = id();
    const s2 = id();
    for (const s of [s1, s2])
      await q(
        `INSERT INTO core.sessions (id, user_id, user_type, expires_at) VALUES ($1, $2, 'MASTER', now() + interval '12 hours')`,
        [s, master],
        roleUrl('app_rw'),
      );
    const [t1, t2] = [id(), id()];
    await q(
      `INSERT INTO core.refresh_tokens (id, session_id, token_hash) VALUES ($1, $2, $3), ($4, $2, $5)`,
      [t1, s1, h32(), t2, h32()],
      roleUrl('app_rw'),
    );
    await expect(
      q(`UPDATE core.refresh_tokens SET session_id = $2 WHERE id = $1`, [t1, s2], roleUrl('app_rw')),
    ).rejects.toThrow(/permission denied/);
    await expect(
      q(`UPDATE core.refresh_tokens SET used_at = now(), replaced_by_id = id WHERE id = $1`, [t1], roleUrl('app_rw')),
    ).rejects.toThrow(/refresh_tokens_not_self/);
    await q(
      `UPDATE core.refresh_tokens SET used_at = now(), replaced_by_id = $2 WHERE id = $1`,
      [t1, t2],
      roleUrl('app_rw'),
    );
    await expect(
      q(`UPDATE core.refresh_tokens SET used_at = NULL WHERE id = $1`, [t1], roleUrl('app_rw')),
    ).rejects.toThrow(/đã xoay/);
    await expect(
      q(
        `INSERT INTO core.refresh_tokens (id, session_id, token_hash, used_at) VALUES ($1, $2, $3, now())`,
        [id(), s1, h32()],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/phải chưa dùng/);
    await expect(
      q(
        `INSERT INTO core.refresh_tokens (id, session_id, token_hash, used_at, replaced_by_id) VALUES ($1, $2, $3, now(), $4)`,
        [id(), s1, h32(), id()],
      ),
    ).rejects.toThrow(/phải chưa dùng|foreign key/);
  });

  it('T2 — quầy phải cùng cửa hàng với thiết bị; thiết bị thu hồi đóng băng; mốc kích hoạt bất biến', async () => {
    const [a, b] = [await newStore('T2-A'), await newStore('T2-B')];
    const regB = id();
    await q(`INSERT INTO core.registers (id, store_id, code) VALUES ($1, $2, 'Q1')`, [regB, b]);
    await expect(newDevice(a, regB)).rejects.toThrow(/pos_devices_register_id_store_id_fkey/);
    const master = await newUser('MASTER');
    const dev = await newDevice(b, regB);
    await expect(
      q(
        `INSERT INTO core.pos_devices (id, store_id, name, platform, public_key, fingerprint, status, activated_at, activated_by) VALUES ($1, $2, 'x', 'w', $3, $4, 'ACTIVE', now(), $5)`,
        [id(), b, h32(), h32(), master],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/phải PENDING/);
    await q(
      `UPDATE core.pos_devices SET status = 'ACTIVE', activated_at = now(), activated_by = $2 WHERE id = $1`,
      [dev, master],
      roleUrl('app_rw'),
    );
    await expect(
      q(`UPDATE core.pos_devices SET activated_at = now() - interval '1 day' WHERE id = $1`, [dev], roleUrl('app_rw')),
    ).rejects.toThrow(/mốc đăng ký\/kích hoạt/);
    await q(
      `UPDATE core.pos_devices SET status = 'REVOKED', revoked_at = now(), revoked_by = $2 WHERE id = $1`,
      [dev, master],
      roleUrl('app_rw'),
    );
    await expect(
      q(`UPDATE core.pos_devices SET register_id = NULL WHERE id = $1`, [dev], roleUrl('app_rw')),
    ).rejects.toThrow(/đã thu hồi không sửa được/);
  });

  it('T3 — quyền riêng chỉ cho STAFF; hồ sơ viewer chỉ cho VIEWER; staff chỉ cho STAFF; mã khôi phục chỉ cho admin', async () => {
    const viewer = await newUser('VIEWER');
    const master = await newUser('MASTER');
    const staff = await newUser('STAFF');
    const grant = (u: string) =>
      q(
        `INSERT INTO core.user_permission_grants (id, user_id, permission_code, scope_type, granted_by) VALUES ($1, $2, 'price:write', 'ALL', $3)`,
        [id(), u, master],
        roleUrl('app_rw'),
      );
    await expect(grant(viewer)).rejects.toThrow(/chỉ cho người dùng STAFF/);
    // NC-21: duyệt giảm giá cận hạn chỉ Master — không cấp riêng được cho nhân viên
    await expect(
      q(
        `INSERT INTO core.user_permission_grants (id, user_id, permission_code, scope_type, granted_by) VALUES ($1, $2, 'markdown:approve', 'ALL', $3)`,
        [id(), staff, master],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/upg_no_markdown_approve/);
    await expect(grant(master)).rejects.toThrow(/chỉ cho người dùng STAFF/);
    await grant(staff);
    const [sh] = await q(`SELECT id FROM core.viewer_profiles WHERE code = 'SHAREHOLDER'`);
    await expect(
      q(
        `INSERT INTO core.viewer_profile_assignments (user_id, viewer_profile_id) VALUES ($1, $2)`,
        [master, sh.id],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/viewer_profile_assignments/);
    await q(
      `INSERT INTO core.viewer_profile_assignments (user_id, viewer_profile_id) VALUES ($1, $2)`,
      [viewer, sh.id],
      roleUrl('app_rw'),
    );
    await expect(
      q(
        `INSERT INTO core.staff (user_id, staff_code, full_name) VALUES ($1, 'NV9001', 'X')`,
        [viewer],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/staff: người dùng loại VIEWER/);
    await q(
      `INSERT INTO core.staff (user_id, staff_code, full_name) VALUES ($1, 'NV9002', 'Y')`,
      [staff],
      roleUrl('app_rw'),
    );
    await expect(
      q(
        `INSERT INTO core.recovery_codes (id, user_id, code_hash) VALUES ($1, $2, 'x')`,
        [id(), staff],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/recovery_codes/);
  });

  it('T4/L6 — bộ chạy: chặn migration chen trước bản đã áp, mục lạ, trùng số, lệnh điều khiển transaction', async () => {
    const base = { url: ownerUrl, env: passwords, log: () => undefined };
    // a) thư mục Prisma có 0000_early chen trước 0001 đã áp
    const pDir = mkdtempSync(join(tmpdir(), 'pm-'));
    cpSync(new URL('.', PRISMA_DIR), pDir, { recursive: true });
    mkdirSync(join(pDir, '0000_early'));
    writeFileSync(join(pDir, '0000_early', 'migration.sql'), 'SELECT 1;\n');
    await expect(applySqlMigrations({ ...base, dir: SQL_DIR, prismaDir: pathToFileURL(pDir + '/') })).rejects.toThrow(
      /đứng trước migration đã áp/,
    );
    // b) file infra/sql mới khi đã có migration Prisma
    const sDir = mkdtempSync(join(tmpdir(), 'sq-'));
    for (const f of readdirSync(SQL_DIR)) copyFileSync(new URL(f, SQL_DIR), join(sDir, f));
    writeFileSync(join(sDir, '002_late.sql'), 'SELECT 1;\n');
    await expect(
      applySqlMigrations({ ...base, dir: pathToFileURL(sDir + '/'), prismaDir: PRISMA_DIR }),
    ).rejects.toThrow(/đứng trước migration đã áp/);
    // c) mục lạ và trùng số
    writeFileSync(join(sDir, '003_x.SQL'), 'SELECT 1;\n');
    expect(() => listMigrations(pathToFileURL(sDir + '/'))).toThrow(/Mục lạ/);
    const dDir = mkdtempSync(join(tmpdir(), 'dup-'));
    writeFileSync(join(dDir, '000_a.sql'), 'SELECT 1;\n');
    writeFileSync(join(dDir, '000_b.sql'), 'SELECT 1;\n');
    expect(() => listMigrations(pathToFileURL(dDir + '/'))).toThrow(/Trùng số/);
    // d) COMMIT giữa file bị chặn; thân hàm plpgsql (BEGIN … END;) không bị bắt nhầm
    expect(() => assertNoTransactionControl('x', 'CREATE TABLE t(); COMMIT;\nSELECT 1;')).toThrow(/COMMIT/);
    expect(() => assertNoTransactionControl('x', 'SELECT 1;\nBEGIN;\n')).toThrow(/BEGIN/);
    // cách lách / báo nhầm từ kiểm thử agent lần 2
    expect(() => assertNoTransactionControl('x', '/* x */ COMMIT;')).toThrow(/COMMIT/);
    expect(() => assertNoTransactionControl('x', "select '--'; COMMIT;")).toThrow(/COMMIT/);
    expect(() => assertNoTransactionControl('x', 'ROLLBACK TO SAVEPOINT a;')).toThrow(/ROLLBACK/);
    expect(() =>
      assertNoTransactionControl('x', 'CREATE TABLE t (\n  commit_sha text,\n  release_at timestamptz\n);'),
    ).not.toThrow();
    expect(() => assertNoTransactionControl('x', "COMMENT ON TABLE t IS 'a;\nRelease notes';")).not.toThrow();
    expect(() => assertNoTransactionControl('x', 'DO $f$ BEGIN PERFORM 1; END; $f$;')).not.toThrow();
    for (const m of listMigrations(SQL_DIR, PRISMA_DIR))
      expect(() => assertNoTransactionControl(m.key, readFileSync(m.url, 'utf8'))).not.toThrow();
  });

  it('T-3 — chuỗi thường có \\ không che được COMMIT; chốt lúc chạy dừng file tự COMMIT và không ghi sổ', async () => {
    // standard_conforming_strings: '\' là chuỗi một ký tự ⇒ COMMIT phía sau là câu lệnh thật
    expect(() => assertNoTransactionControl('x', "SELECT '\\'; COMMIT; -- '")).toThrow(/COMMIT/);
    expect(() => assertNoTransactionControl('x', "SELECT E'\\'; COMMIT; --';")).not.toThrow(); // trong chuỗi E''
    // gọi thẳng bước áp (bỏ qua lọc tĩnh) để thử chốt lúc chạy
    const c = new Client({ connectionString: ownerUrl });
    await c.connect();
    try {
      await expect(
        applyOneMigration(c, 'zz_probe', 'CREATE TABLE core._tx_probe(id int); COMMIT; SELECT 1;', 'a'.repeat(64)),
      ).rejects.toThrow(/tự kết thúc transaction/);
    } finally {
      await c.end();
    }
    const rows = await q(`SELECT 1 FROM integration.sql_migrations WHERE file = 'zz_probe'`);
    expect(rows).toEqual([]);
    await q(`DROP TABLE IF EXISTS core._tx_probe`); // phần trước COMMIT đã commit — đúng như cảnh báo
  });

  it('T-1/T-2 — thu hồi thiết bị đóng mọi phiên trên nó; không gia hạn phiên/không phát nonce cho thiết bị đã thu hồi; mốc thu hồi do server đặt', async () => {
    const store = await newStore('TL-S');
    const staff = await newUser('STAFF');
    const master = await newUser('MASTER');
    const dev = await newDevice(store);
    await q(
      `UPDATE core.pos_devices SET status = 'ACTIVE', activated_at = '2000-01-01', activated_by = $2 WHERE id = $1`,
      [dev, master],
      roleUrl('app_rw'),
    );
    const [d] = await q(
      `SELECT activated_at > now() - interval '1 minute' AS fresh FROM core.pos_devices WHERE id = $1`,
      [dev],
    );
    expect(d.fresh).toBe(true);
    const sid = id();
    await q(
      `INSERT INTO core.sessions (id, user_id, user_type, pos_device_id, expires_at) VALUES ($1, $2, 'STAFF', $3, now() + interval '1 day')`,
      [sid, staff, dev],
      roleUrl('app_rw'),
    );
    await q(
      `INSERT INTO core.auth_challenges (id, kind, pos_device_id, secret_hash, expires_at) VALUES ($1, 'DEVICE_NONCE', $2, $3, now() + interval '2 minutes')`,
      [id(), dev, h32()],
      roleUrl('app_rw'),
    );
    await q(
      `UPDATE core.pos_devices SET status = 'REVOKED', revoked_at = '2099-01-01', revoked_by = $2 WHERE id = $1`,
      [dev, master],
      roleUrl('app_rw'),
    );
    const [s] = await q(`SELECT revoked_at IS NOT NULL AS rev, revoke_reason FROM core.sessions WHERE id = $1`, [sid]);
    expect(s).toEqual({ rev: true, revoke_reason: 'DEVICE_REVOKED' });
    const [dv] = await q(`SELECT revoked_at < now() + interval '1 minute' AS ok FROM core.pos_devices WHERE id = $1`, [
      dev,
    ]);
    expect(dv.ok).toBe(true);
    await expect(
      q(
        `INSERT INTO core.auth_challenges (id, kind, pos_device_id, secret_hash, expires_at) VALUES ($1, 'DEVICE_NONCE', $2, $3, now() + interval '2 minutes')`,
        [id(), dev, h32()],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/phải ACTIVE/);
    await expect(
      q(
        `INSERT INTO core.refresh_tokens (id, session_id, token_hash) VALUES ($1, $2, $3)`,
        [id(), sid, h32()],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/phiên đã thu hồi/);
    // thu hồi vai trò: mốc do server đặt
    const ura = id();
    await q(
      `INSERT INTO core.user_role_assignments (id, user_id, role, scope_type) VALUES ($1, $2, 'MASTER_ADMIN', 'ALL')`,
      [ura, master],
      roleUrl('app_rw'),
    );
    await q(
      `UPDATE core.user_role_assignments SET revoked_at = '2099-01-01', revoked_by = $2 WHERE id = $1`,
      [ura, master],
      roleUrl('app_rw'),
    );
    const [r] = await q(
      `SELECT revoked_at < now() + interval '1 minute' AS ok FROM core.user_role_assignments WHERE id = $1`,
      [ura],
    );
    expect(r.ok).toBe(true);
  });

  it('R-1 — tạo phiên và thu hồi thiết bị chạy đồng thời: thu hồi phải chờ, rồi đóng cả phiên vừa tạo', async () => {
    const store = await newStore('R1-S');
    const staff = await newUser('STAFF');
    const master = await newUser('MASTER');
    const dev = await newDevice(store);
    await q(
      `UPDATE core.pos_devices SET status = 'ACTIVE', activated_at = now(), activated_by = $2 WHERE id = $1`,
      [dev, master],
      roleUrl('app_rw'),
    );
    const a = new Client({ connectionString: roleUrl('app_rw') });
    const b = new Client({ connectionString: roleUrl('app_rw') });
    await Promise.all([a.connect(), b.connect()]);
    try {
      const sid = id();
      await a.query('BEGIN');
      await a.query(
        `INSERT INTO core.sessions (id, user_id, user_type, pos_device_id, expires_at) VALUES ($1, $2, 'STAFF', $3, now() + interval '1 day')`,
        [sid, staff, dev],
      );
      let bDone = false;
      const revoke = b
        .query(`UPDATE core.pos_devices SET status = 'REVOKED', revoked_at = now(), revoked_by = $2 WHERE id = $1`, [
          dev,
          master,
        ])
        .then(() => {
          bDone = true;
        });
      await new Promise((r) => setTimeout(r, 500));
      expect(bDone).toBe(false); // bị khóa FOR SHARE của A giữ
      await a.query('COMMIT');
      await revoke;
      const [s] = await q(`SELECT revoked_at IS NOT NULL AS rev, revoke_reason FROM core.sessions WHERE id = $1`, [
        sid,
      ]);
      expect(s).toEqual({ rev: true, revoke_reason: 'DEVICE_REVOKED' });
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });

  it('SET cấp phiên trong một migration không rò sang migration sau', async () => {
    const c = new Client({ connectionString: ownerUrl });
    await c.connect();
    try {
      await applyOneMigration(
        c,
        'zz_set_probe',
        `SET standard_conforming_strings = off; SET search_path = audit;`,
        'b'.repeat(64),
      );
      const [r] = (
        await c.query(
          `SELECT current_setting('standard_conforming_strings') AS scs, current_setting('search_path') AS sp`,
        )
      ).rows;
      expect(r.scs).toBe('on');
      expect(r.sp).not.toBe('audit');
    } finally {
      await c.end();
    }
    await q(`DELETE FROM integration.sql_migrations WHERE file = 'zz_set_probe'`);
  });

  it('T-2 — token thay thế phải cùng phiên', async () => {
    const master = await newUser('MASTER');
    const [s1, s2] = [id(), id()];
    for (const s of [s1, s2])
      await q(
        `INSERT INTO core.sessions (id, user_id, user_type, expires_at) VALUES ($1, $2, 'MASTER', now() + interval '12 hours')`,
        [s, master],
        roleUrl('app_rw'),
      );
    const [a, b] = [id(), id()];
    await q(
      `INSERT INTO core.refresh_tokens (id, session_id, token_hash) VALUES ($1, $2, $3), ($4, $5, $6)`,
      [a, s1, h32(), b, s2, h32()],
      roleUrl('app_rw'),
    );
    await expect(
      q(`UPDATE core.refresh_tokens SET used_at = now(), replaced_by_id = $2 WHERE id = $1`, [a, b], roleUrl('app_rw')),
    ).rejects.toThrow(/cùng phiên/);
  });

  it('T5 — role ứng dụng không vào được database khác trong cluster', async () => {
    const other = new URL(roleUrl('viewer_ro'));
    other.pathname = '/postgres';
    await expect(q(`SELECT 1`, [], other.toString())).rejects.toThrow(/permission denied/);
    other.pathname = '/template_postgis';
    await expect(q(`SELECT 1`, [], other.toString())).rejects.toThrow(/permission denied|does not exist/);
  });

  it('T6 — audit_writer/viewer_act: INSERT được, INSERT … RETURNING bị từ chối (dùng createMany/$executeRaw)', async () => {
    await q(`INSERT INTO audit.login_logs (id, result) VALUES ($1, 'OK')`, [id()], roleUrl('audit_writer'));
    await expect(
      q(`INSERT INTO audit.login_logs (id, result) VALUES ($1, 'OK') RETURNING *`, [id()], roleUrl('audit_writer')),
    ).rejects.toThrow(/permission denied/);
  });

  it('L5 — thời điểm audit/thử thách do server đặt (không ghi lùi được)', async () => {
    const lid = id();
    await q(
      `INSERT INTO audit.logs (id, at, action, resource_type) VALUES ($1, '1999-01-01', 'test.backdate', 'probe')`,
      [lid],
      roleUrl('app_rw'),
    );
    const [r] = await q(`SELECT at > now() - interval '1 minute' AS fresh FROM audit.logs WHERE id = $1`, [lid]);
    expect(r.fresh).toBe(true);
    const u = await newUser('MASTER');
    await expect(
      q(
        `INSERT INTO core.auth_challenges (id, kind, user_id, secret_hash, created_at, expires_at) VALUES ($1, 'MFA', $2, $3, now() + interval '1 hour', now() + interval '1 hour 5 minutes')`,
        [id(), u, h32()],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/auth_challenges_ttl/);
    await expect(
      q(
        `INSERT INTO core.auth_challenges (id, kind, user_id, secret_hash, expires_at) VALUES ($1, 'MFA', $2, $3, now() + interval '5 minutes')`,
        [id(), id(), h32()],
        roleUrl('app_rw'),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('L4 — viewer_ro không gọi được hàm large object; allowed_stores() không nhận tham số', async () => {
    await expect(q(`SELECT lo_create(0)`, [], roleUrl('viewer_ro'))).rejects.toThrow(/permission denied/);
    await expect(q(`SELECT lo_from_bytea(0, 'x'::bytea)`, [], roleUrl('viewer_ro'))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      q(`SELECT reporting.allowed_stores('019a9b00-0000-7000-8000-000000000001'::uuid)`, [], roleUrl('viewer_ro')),
    ).rejects.toThrow(/does not exist/);
  });

  // Dùng chung một kết nối owner cho các bộ kiểm pg_catalog
  let shared: Client | undefined;
  async function connected(): Promise<Client> {
    if (!shared) {
      shared = new Client({ connectionString: ownerUrl });
      await shared.connect();
    }
    return shared;
  }
  afterAll(async () => {
    await shared?.end();
  });
});
