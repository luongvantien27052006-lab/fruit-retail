import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAppendOnlyPrivileges, checkViewerRls } from '../src/db/privilege-checks';
import { applySqlMigrations, ROLE_PASSWORD_ENV } from '../src/db/sql-migrations';

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

  it('áp đúng thứ tự: infra/sql (000, 001) rồi prisma/0001_foundation; chạy lại không áp gì', async () => {
    const rows = await q(`SELECT file FROM integration.sql_migrations ORDER BY applied_at, file`);
    expect(rows.map((r) => r.file)).toEqual([
      '000_bootstrap.sql',
      '001_extension_privileges.sql',
      'prisma/0001_foundation',
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

  it('app_rw: S/I/U trên core, không DELETE (trừ bảng tạm đã liệt kê); không sửa bảng mã quyền', async () => {
    for (const t of ['core.users', 'core.staff', 'core.sessions', 'core.pos_devices', 'core.files', 'core.stores']) {
      expect({
        t,
        s: await priv('app_rw', t, 'SELECT'),
        i: await priv('app_rw', t, 'INSERT'),
        u: await priv('app_rw', t, 'UPDATE'),
        d: await priv('app_rw', t, 'DELETE'),
      }).toEqual({ t, s: true, i: true, u: true, d: false });
    }
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

  it('audit.* chỉ-thêm: không role nào UPDATE/DELETE/TRUNCATE; trigger chặn cả owner', async () => {
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
    expect(rows.map((r) => r.f)).toEqual(['reporting.allowed_stores(p_profile uuid)', 'reporting.current_profile()']);
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
               USING (store_id = ANY (reporting.allowed_stores(reporting.current_profile())));
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
    expect(counts).toMatchObject({ STORE_MANAGER: 39, CASHIER: 14, PICKER: 9, WAREHOUSE_STAFF: 15 });
  });

  it('hạn mức duyệt §2.3 đúng giá trị', async () => {
    const rows = await q(
      `SELECT role::text, action::text, max_amount::text AS amt, max_pct_bp AS pct, same_day_only AS day
       FROM core.approval_limits WHERE role = 'STORE_MANAGER' ORDER BY action`,
    );
    const byAction = Object.fromEntries(rows.map((r) => [r.action, { amt: r.amt, pct: r.pct, day: r.day }]));
    expect(byAction).toMatchObject({
      LINE_DISCOUNT: { amt: '50000', pct: 1000 },
      SALE_VOID: { amt: '500000', pct: null, day: true },
      REFUND: { amt: '200000', pct: null },
      SPOILAGE_APPROVE: { amt: '1000000', pct: null },
      STOCKTAKE_ADJUST: { amt: '1000000', pct: 200 },
      MARKDOWN: { amt: null, pct: 2000 },
    });
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
         AND table_name NOT IN ('stores', 'warehouses')`, // địa chỉ cửa hàng/kho là thông tin công khai
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
    ).rejects.toThrow(/không đổi được khóa/);
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
    ).rejects.toThrow(/không hợp lệ/);
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
