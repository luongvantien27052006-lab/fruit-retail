import { Controller, Get, type INestApplication, Inject } from '@nestjs/common';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { TransactionHost } from '@nestjs-cls/transactional';
import { generateKeyPairSync, type KeyObject, randomBytes, randomUUID, sign } from 'node:crypto';
import { generateSync } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAuthKeys } from '../src/auth/auth-config';
import { enrollmentCodeHash, newEnrollmentCode, normalizeEnrollmentCode, proofMessage } from '../src/auth/device-proof';
import { ARGON_PROFILES, hashSecret } from '../src/auth/password';
import { PiiCipher, totpAad } from '../src/auth/pii-cipher';
import { isWeakPin } from '../src/admin/staff-admin.service';
import { createApp } from '../src/bootstrap';
import { createMaster } from '../src/cli/create-master';
import { RequirePermission } from '../src/common/access';
import { decide, type LimitRow } from '../src/common/approval-limits.service';
import type { Tx } from '../src/common/audit-outbox.service';
import { loadEnv } from '../src/config/env';
import { ViewerDb } from '../src/infra/viewer-db.service';
import { testAuthEnv } from './helpers/auth-env';
import { schemaErrors } from './helpers/contract';
import { type MigratedDb, startMigratedDb } from './helpers/db';
import { relaxedRatePolicies } from './helpers/rate-limit';

// CP03 lát 6 — RBAC theo phạm vi + cô lập Viewer (ADR-024) trên PostgreSQL + Redis thật.
// T16: viewer gọi /admin/* ⇒ 403. T17: kết nối viewer_ro đọc core ⇒ permission denied. Cửa hàng trưởng không thao tác
// cửa hàng khác.

/** Route thử chỉ có trong test: đọc qua ViewerDb (viewer_ro + hồ sơ) và thử chạm pool app_rw */
@Controller('viewer/_probe')
class ViewerProbe {
  constructor(
    private readonly vdb: ViewerDb,
    @Inject(TransactionHost) private readonly txHost: Tx,
  ) {}

  @RequirePermission('viewer:read')
  @Get()
  async probe() {
    const { ClsServiceManager } = await import('nestjs-cls');
    const p = ClsServiceManager.getClsService().get('principal') as { viewerProfileId: string };
    const out = await this.vdb.read(p.viewerProfileId, async (q) => {
      const [u] = await q<{ u: string; prof: string | null; n: number }>(
        `SELECT current_user AS u, reporting.current_profile()::text AS prof, cardinality(reporting.allowed_stores()) AS n`,
      );
      let core = 'ok';
      await q('SAVEPOINT s');
      try {
        await q('SELECT count(*) FROM core.users');
      } catch (e) {
        core = (e as { code?: string }).code ?? 'err';
        await q('ROLLBACK TO SAVEPOINT s');
      }
      return { ...u, core };
    });
    let appPool = 'ok';
    try {
      await this.txHost.tx.user.count();
    } catch (e) {
      appPool = (e as Error).message.includes('viewer') ? 'blocked' : 'err';
    }
    return { ...out, appPool };
  }
}

interface Device {
  id: string;
  key: KeyObject;
  pub: string;
}

describe('RBAC + cô lập Viewer (CP03 lát 6)', () => {
  let db: MigratedDb;
  let redis: StartedRedisContainer;
  let app: INestApplication;
  let cipher: PiiCipher;
  const http = () => request(app.getHttpServer());
  const rows = (sql: string, p: unknown[] = []) => db.q(sql, p);
  const hex = (n = 3) => randomBytes(n).toString('hex').toUpperCase();
  let master: string;
  let masterId: string;

  async function totp(userId: string): Promise<string> {
    const [u] = await rows(`SELECT totp_secret_enc FROM core.users WHERE id = $1`, [userId]);
    return generateSync({
      secret: cipher.decrypt(u?.totp_secret_enc as Buffer, totpAad(userId)).toString('utf8'),
    });
  }
  async function adminBearer(email: string, password: string, userId: string): Promise<string> {
    const l = await http().post('/v1/auth/login').send({ email, password });
    const bearer = `Bearer ${l.body.access_token as string}`;
    await http().post('/v1/auth/2fa/setup').set('Authorization', bearer).send({});
    const c = await http()
      .post('/v1/auth/2fa/confirm')
      .set('Authorization', bearer)
      .send({ code: await totp(userId) });
    expect(c.status).toBe(200);
    return `Bearer ${c.body.access_token as string}`;
  }
  async function stepUp(bearer: string, userId: string) {
    // mã TOTP cùng bước 30 giây với lần 2fa/confirm sẽ bị chặn dùng lại (ADR-021) ⇒ test (owner) xóa mốc bước đã dùng
    await rows(`UPDATE core.users SET totp_last_step = NULL WHERE id = $1`, [userId]);
    const r = await http()
      .post('/v1/auth/step-up')
      .set('Authorization', bearer)
      .send({ code: await totp(userId) });
    expect(r.status).toBe(200);
    return `Bearer ${r.body.access_token as string}`;
  }

  async function store() {
    const id = randomUUID();
    const code = `S${hex()}`;
    await rows(`INSERT INTO core.stores (id, code, name) VALUES ($1, $2, $3)`, [id, code, code]);
    return { id, code };
  }
  async function staffSql(roles: { role: string; storeId: string }[], pin = '246813') {
    const userId = randomUUID();
    const code = `NV${hex()}`;
    await rows(`INSERT INTO core.users (id, type, pin_hash) VALUES ($1, 'STAFF', $2)`, [
      userId,
      await hashSecret(pin, ARGON_PROFILES.PASSWORD),
    ]);
    await rows(`INSERT INTO core.staff (user_id, staff_code, full_name) VALUES ($1, $2, $2)`, [userId, code]);
    for (const r of roles)
      await rows(
        `INSERT INTO core.user_role_assignments (id, user_id, role, scope_type, scope_id) VALUES ($1, $2, $3, 'STORE', $4)`,
        [randomUUID(), userId, r.role, r.storeId],
      );
    return { userId, code, pin };
  }
  const proof = (d: Device, purpose: 'register' | 'pin', binding: string) => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(16).toString('base64url');
    const signature = sign(null, proofMessage(purpose, d.id, ts, nonce, binding), d.key).toString('base64url');
    return { ts, nonce, signature };
  };
  async function activeDevice(storeId: string): Promise<Device> {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const d = { id: randomUUID(), key: privateKey, pub: (publicKey.export({ format: 'jwk' }) as { x: string }).x };
    const code = newEnrollmentCode();
    await rows(
      `INSERT INTO core.pos_enrollment_codes (id, store_id, code_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '30 minutes')`,
      [randomUUID(), storeId, Buffer.from(enrollmentCodeHash(code)), masterId],
    );
    const r = await http()
      .post('/v1/auth/devices/register')
      .set('X-Device-Id', d.id)
      .send({
        enrollment_code: code,
        name: 'Quầy',
        platform: 'windows',
        public_key: d.pub,
        device_proof: proof(d, 'register', `${normalizeEnrollmentCode(code)}\n${d.pub}`),
      });
    expect(r.status).toBe(201);
    const a = await http()
      .post(`/v1/admin/pos-devices/${d.id}/activate`)
      .set('Authorization', master)
      .send({ pairing_code: r.body.pairing_code });
    expect(a.status).toBe(200);
    return d;
  }
  /** đăng nhập PIN ⇒ hàm gửi request kèm Bearer + X-Device-Id */
  async function staffClient(d: Device, s: { code: string; pin: string }) {
    const l = await http()
      .post('/v1/auth/pin')
      .set('X-Device-Id', d.id)
      .send({ staff_code: s.code, pin: s.pin, device_proof: proof(d, 'pin', s.code) });
    expect(l.status).toBe(200);
    const bearer = `Bearer ${l.body.access_token as string}`;
    return {
      sessionId: l.body.session_id as string,
      get: (u: string) => http().get(u).set('Authorization', bearer).set('X-Device-Id', d.id),
      post: (u: string, b: object) => http().post(u).set('Authorization', bearer).set('X-Device-Id', d.id).send(b),
      patch: (u: string, b: object) => http().patch(u).set('Authorization', bearer).set('X-Device-Id', d.id).send(b),
      del: (u: string) => http().delete(u).set('Authorization', bearer).set('X-Device-Id', d.id),
    };
  }

  beforeAll(async () => {
    [db, redis] = await Promise.all([startMigratedDb(), new RedisContainer('redis:7.4-alpine').start()]);
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL_APP: db.roleUrl('app_rw'),
      DATABASE_URL_VIEWER: db.roleUrl('viewer_ro'),
      REDIS_URL: redis.getConnectionUrl(),
      PORT: '0',
      LOG_LEVEL: 'silent',
      ...testAuthEnv(db.roleUrl('audit_writer')),
    });
    cipher = new PiiCipher(loadAuthKeys(env));
    app = await createApp(env, { logger: false }, { controllers: [ViewerProbe], providers: [relaxedRatePolicies] });
    await app.init();
    const m = await createMaster(db.roleUrl('app_rw'), `m-${hex().toLowerCase()}@fruit.test`);
    masterId = m.userId;
    master = await adminBearer(m.email, m.password, m.userId);
  });
  afterAll(async () => {
    await app?.close();
    await Promise.allSettled([db?.pg.stop(), redis?.stop()]);
  });

  // ───────── nhân viên theo phạm vi ─────────

  it('Master tạo nhân viên (PIN băm, PIN yếu ⇒ 400, mã trùng ⇒ 409); nhân viên mới đăng nhập PIN được', async () => {
    const a = await store();
    const code = `NV${hex()}`;
    const body = {
      staff_code: code.toLowerCase(),
      full_name: 'Thu Ngân A',
      pin: '480263',
      role: { role: 'CASHIER', store_id: a.id },
    };
    const r = await http().post('/v1/admin/staff').set('Authorization', master).send(body);
    expect(r.status).toBe(201);
    expect(schemaErrors('Staff', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ staff_code: code, status: 'ACTIVE', roles: [{ role: 'CASHIER', store_id: a.id }] });
    const [u] = await rows(`SELECT pin_hash FROM core.users WHERE id = $1`, [r.body.user_id]);
    expect(String(u?.pin_hash)).toMatch(/^\$argon2id\$/);
    expect((await http().post('/v1/admin/staff').set('Authorization', master).send(body)).status).toBe(409);
    for (const pin of ['111111', '123456', '987654', '121212', '123123', '890123'])
      expect(
        (
          await http()
            .post('/v1/admin/staff')
            .set('Authorization', master)
            .send({ ...body, staff_code: `X${hex()}`, pin })
        ).status,
      ).toBe(400);
    expect(isWeakPin('480263')).toBe(false);
    const audits = await rows(`SELECT action FROM audit.logs WHERE resource_id = $1`, [r.body.user_id]);
    expect(audits.map((x) => x.action)).toEqual(['staff.create']);
    const d = await activeDevice(a.id);
    await staffClient(d, { code, pin: '480263' });
  });

  it('cửa hàng trưởng chỉ thấy/sửa/gán nhân viên thu ngân, soạn hàng của cửa hàng mình; ngoài phạm vi ⇒ 404/403', async () => {
    const a = await store();
    const b = await store();
    const sm = await staffSql([{ role: 'STORE_MANAGER', storeId: a.id }]);
    const cashA = await staffSql([{ role: 'CASHIER', storeId: a.id }]);
    const cashB = await staffSql([{ role: 'CASHIER', storeId: b.id }]);
    const peer = await staffSql([{ role: 'STORE_MANAGER', storeId: a.id }]);
    const mixed = await staffSql([
      { role: 'CASHIER', storeId: a.id },
      { role: 'CASHIER', storeId: b.id },
    ]);
    const c = await staffClient(await activeDevice(a.id), sm);

    const list = await c.get('/v1/admin/staff');
    expect(list.status).toBe(200);
    expect(schemaErrors('StaffList', list.body)).toEqual([]);
    const ids = (list.body.items as { user_id: string }[]).map((x) => x.user_id);
    expect(ids).toContain(cashA.userId);
    for (const x of [cashB, peer, mixed, sm]) expect(ids).not.toContain(x.userId);
    expect((await c.get(`/v1/admin/staff/${cashA.userId}`)).status).toBe(200);
    for (const x of [cashB, peer, mixed]) {
      expect((await c.get(`/v1/admin/staff/${x.userId}`)).status).toBe(404);
      expect((await c.patch(`/v1/admin/staff/${x.userId}`, { full_name: 'x' })).status).toBe(404);
    }
    expect((await c.patch(`/v1/admin/staff/${sm.userId}`, { full_name: 'tự sửa' })).status).toBe(403);
    expect((await c.patch(`/v1/admin/staff/${cashA.userId}`, { full_name: 'Đã sửa' })).body.full_name).toBe('Đã sửa');

    // tạo: chỉ CASHIER/PICKER ở cửa hàng mình
    const mk = (role: string, storeId: string) =>
      c.post('/v1/admin/staff', {
        staff_code: `N${hex()}`,
        full_name: 'Mới',
        pin: '480263',
        role: { role, store_id: storeId },
      });
    expect((await mk('PICKER', a.id)).status).toBe(201);
    expect((await mk('CASHIER', b.id)).status).toBe(404);
    expect((await mk('STORE_MANAGER', a.id)).status).toBe(403);
    // gán / gỡ vai trò (nhân viên không có step-up ⇒ không cần)
    const as = await c.post('/v1/admin/role-assignments', { user_id: cashA.userId, role: 'PICKER', store_id: a.id });
    expect(as.status).toBe(201);
    expect(schemaErrors('RoleAssignment', as.body)).toEqual([]);
    expect(
      (await c.post('/v1/admin/role-assignments', { user_id: cashA.userId, role: 'PICKER', store_id: b.id })).status,
    ).toBe(404);
    expect(
      (await c.post('/v1/admin/role-assignments', { user_id: cashB.userId, role: 'PICKER', store_id: a.id })).status,
    ).toBe(404);
    expect(
      (await c.post('/v1/admin/role-assignments', { user_id: sm.userId, role: 'PICKER', store_id: a.id })).status,
    ).toBe(403);
    const [rb] = await rows(`SELECT id FROM core.user_role_assignments WHERE user_id = $1`, [cashB.userId]);
    expect((await c.del(`/v1/admin/role-assignments/${rb?.id as string}`)).status).toBe(404);
    expect((await c.del(`/v1/admin/role-assignments/${as.body.id as string}`)).status).toBe(204);
  });

  it('cửa hàng trưởng 2 cửa hàng đứng ở máy cửa hàng A chỉ thao tác cửa hàng A', async () => {
    const a = await store();
    const b = await store();
    const sm = await staffSql([
      { role: 'STORE_MANAGER', storeId: a.id },
      { role: 'STORE_MANAGER', storeId: b.id },
    ]);
    const cashB = await staffSql([{ role: 'CASHIER', storeId: b.id }]);
    const c = await staffClient(await activeDevice(a.id), sm);
    expect((await c.get(`/v1/admin/staff/${cashB.userId}`)).status).toBe(404);
    const devs = await c.get('/v1/admin/pos-devices');
    expect((devs.body.items as { store_id: string }[]).every((x) => x.store_id === a.id)).toBe(true);
    expect((await c.post('/v1/admin/pos-devices/enrollment-codes', { store_id: b.id })).status).toBe(404);
  });

  it('phiên nhân viên chết ngay khi mất vai trò ở cửa hàng của máy, hoặc cửa hàng ngừng hoạt động', async () => {
    const a = await store();
    const s = await staffSql([{ role: 'CASHIER', storeId: a.id }]);
    const d = await activeDevice(a.id);
    const c = await staffClient(d, s);
    expect((await c.get('/v1/auth/sessions')).status).toBe(200);
    await rows(`UPDATE core.user_role_assignments SET revoked_at = now(), revoked_by = $2 WHERE user_id = $1`, [
      s.userId,
      masterId,
    ]);
    expect((await c.get('/v1/auth/sessions')).body.code).toBe('SESSION_REVOKED');
    const s2 = await staffSql([{ role: 'CASHIER', storeId: a.id }]);
    const c2 = await staffClient(d, s2);
    await rows(`UPDATE core.stores SET status = 'INACTIVE' WHERE id = $1`, [a.id]);
    expect((await c2.get('/v1/auth/sessions')).body.code).toBe('SESSION_REVOKED');
    // đăng nhập PIN mới trên máy của cửa hàng ngừng ⇒ 401 chung
    const l = await http()
      .post('/v1/auth/pin')
      .set('X-Device-Id', d.id)
      .send({ staff_code: s2.code, pin: s2.pin, device_proof: proof(d, 'pin', s2.code) });
    expect(l.status).toBe(401);
  });

  it('đổi PIN / khóa nhân viên ⇒ thu hồi mọi phiên; Master gán vai trò cần step-up', async () => {
    const a = await store();
    const s = await staffSql([{ role: 'CASHIER', storeId: a.id }]);
    const d = await activeDevice(a.id);
    const c = await staffClient(d, s);
    const r = await http().patch(`/v1/admin/staff/${s.userId}`).set('Authorization', master).send({ pin: '573918' });
    expect(r.status).toBe(200);
    expect((await c.get('/v1/auth/sessions')).body.code).toBe('SESSION_REVOKED');
    const [sess] = await rows(`SELECT revoke_reason FROM core.sessions WHERE id = $1`, [c.sessionId]);
    expect(sess?.revoke_reason).toBe('PIN_RESET');
    const c2 = await staffClient(d, { code: s.code, pin: '573918' });
    await http().patch(`/v1/admin/staff/${s.userId}`).set('Authorization', master).send({ status: 'DISABLED' });
    expect((await c2.get('/v1/auth/sessions')).status).toBe(401);

    const body = { user_id: s.userId, role: 'PICKER', store_id: a.id };
    const no = await http().post('/v1/admin/role-assignments').set('Authorization', master).send(body);
    expect([no.status, no.body.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    const up = await stepUp(master, masterId);
    expect((await http().post('/v1/admin/role-assignments').set('Authorization', up).send(body)).status).toBe(201);
    // vai trò admin không gán ở đây
    expect(
      (
        await http()
          .post('/v1/admin/role-assignments')
          .set('Authorization', up)
          .send({ ...body, role: 'MASTER_ADMIN' })
      ).status,
    ).toBe(400);
    master = up;
  });

  // ───────── hạn mức duyệt từ dữ liệu ─────────

  it('hạn mức duyệt: đọc từ approval_limits (ANY = một ngưỡng), Master sửa được (step-up), cấu hình bị cấm ⇒ 400', async () => {
    const load = async (role: string, action: string): Promise<LimitRow[]> =>
      (
        await rows(
          `SELECT role::text, allowed, max_amount, max_pct_bp, limit_mode, same_day_only, requires_pin, requires_note
           FROM core.approval_limits WHERE role = $1 AND action = $2`,
          [role, action],
        )
      ).map((x) => ({
        role: String(x.role),
        allowed: x.allowed as boolean,
        maxAmount: x.max_amount === null ? null : BigInt(String(x.max_amount)),
        maxPctBp: x.max_pct_bp as number | null,
        limitMode: String(x.limit_mode),
        sameDayOnly: x.same_day_only as boolean,
        requiresPin: x.requires_pin as boolean,
        requiresNote: x.requires_note as boolean,
      }));
    const st = await load('STORE_MANAGER', 'STOCKTAKE_ADJUST'); // ≤ 1.000.000đ HOẶC ≤ 2%
    expect(decide(st, { action: 'STOCKTAKE_ADJUST', amount: 1_500_000n, base: 100_000_000n }).allowed).toBe(true); // 1,5%
    expect(decide(st, { action: 'STOCKTAKE_ADJUST', amount: 900_000n, base: 10_000_000n }).allowed).toBe(true); // 9% nhưng ≤ 1tr
    expect(decide(st, { action: 'STOCKTAKE_ADJUST', amount: 1_500_000n, base: 10_000_000n })).toEqual({
      allowed: false,
      reason: 'OVER_LIMIT',
    });
    const sv = await load('STORE_MANAGER', 'SALE_VOID'); // ≤ 500.000đ trong ngày
    expect(decide(sv, { action: 'SALE_VOID', amount: 400_000n, sameDay: true }).allowed).toBe(true);
    expect(decide(sv, { action: 'SALE_VOID', amount: 400_000n, sameDay: false })).toMatchObject({
      reason: 'SAME_DAY_ONLY',
    });
    expect(
      decide(await load('CASHIER', 'SALE_VOID'), { action: 'SALE_VOID', amount: 1n, sameDay: true }),
    ).toMatchObject({
      reason: 'NO_LIMIT_ROW',
    });
    expect(decide(await load('MASTER_ADMIN', 'SALE_VOID'), { action: 'SALE_VOID', amount: 10n ** 12n }).allowed).toBe(
      true,
    );
    const mw = await load('STORE_MANAGER', 'MANUAL_WEIGHT');
    expect(decide(mw, { action: 'MANUAL_WEIGHT' })).toMatchObject({
      allowed: true,
      requiresPin: true,
      requiresNote: true,
    });

    // Master sửa: SM hủy hóa đơn tới 300.000đ
    const item = {
      role: 'STORE_MANAGER',
      action: 'SALE_VOID',
      allowed: true,
      max_amount: 300_000,
      max_pct_bp: null,
      limit_mode: 'ANY',
      same_day_only: true,
      requires_pin: false,
      requires_note: false,
    };
    const put = await http()
      .put('/v1/admin/approval-limits')
      .set('Authorization', master)
      .send({ items: [item] });
    expect(put.status).toBe(200);
    expect(schemaErrors('ApprovalLimitsResponse', put.body)).toEqual([]);
    expect(
      decide(await load('STORE_MANAGER', 'SALE_VOID'), { action: 'SALE_VOID', amount: 400_000n, sameDay: true })
        .allowed,
    ).toBe(false);
    for (const bad of [
      { ...item, action: 'MARKDOWN', max_amount: null, max_pct_bp: 2000 },
      { ...item, role: 'MASTER_ADMIN', action: 'NO_SALE_OPEN', max_amount: null },
      { ...item, action: 'LINE_DISCOUNT' },
    ])
      expect(
        (
          await http()
            .put('/v1/admin/approval-limits')
            .set('Authorization', master)
            .send({ items: [bad] })
        ).status,
      ).toBe(400);
    // cửa hàng trưởng không sửa được hạn mức
    const a = await store();
    const sm = await staffSql([{ role: 'STORE_MANAGER', storeId: a.id }]);
    const c = await staffClient(await activeDevice(a.id), sm);
    const r = await c.get('/v1/admin/approval-limits');
    expect(r.status).toBe(404); // không có route GET
    expect(
      (
        await http()
          .put('/v1/admin/approval-limits')
          .set('Authorization', 'Bearer x')
          .send({ items: [item] })
      ).status,
    ).toBe(401);
  });

  // ───────── cô lập Viewer ─────────

  async function viewer(profiles: string[]) {
    const id = randomUUID();
    const email = `v-${hex().toLowerCase()}@fruit.test`;
    const password = `Pw-${randomBytes(9).toString('base64url')}`;
    await rows(`INSERT INTO core.users (id, type, email, password_hash) VALUES ($1, 'VIEWER', $2, $3)`, [
      id,
      email,
      await hashSecret(password, ARGON_PROFILES.PASSWORD),
    ]);
    await rows(
      `INSERT INTO core.user_role_assignments (id, user_id, role, scope_type) VALUES ($1, $2, 'VIEW_ONLY_ADMIN', 'ALL')`,
      [randomUUID(), id],
    );
    for (const code of profiles)
      await rows(
        `INSERT INTO core.viewer_profile_assignments (user_id, viewer_profile_id) SELECT $1, id FROM core.viewer_profiles WHERE code = $2`,
        [id, code],
      );
    return { id, bearer: await adminBearer(email, password, id) };
  }

  it('T16 — tài khoản xem gọi /admin/*, /pos/* ⇒ 403; chỉ /viewer/* và /auth/*', async () => {
    const v = await viewer(['EXECUTIVE']);
    for (const u of ['/v1/admin/staff', '/v1/admin/pos-devices'])
      expect(
        await http()
          .get(u)
          .set('Authorization', v.bearer)
          .then((r) => [r.status, r.body.code]),
      ).toEqual([403, 'ACTION_FORBIDDEN']);
    expect(
      (await http().put('/v1/admin/approval-limits').set('Authorization', v.bearer).send({ items: [] })).status,
    ).toBe(403);
    expect((await http().get('/v1/auth/sessions').set('Authorization', v.bearer)).status).toBe(200);
    // Master không vào route viewer
    expect((await http().get('/v1/viewer/_probe').set('Authorization', master)).status).toBe(403);
  });

  it('T17 — route viewer đọc bằng viewer_ro + hồ sơ: core ⇒ permission denied; pool app_rw bị chặn; 0/2 hồ sơ ⇒ 403', async () => {
    const v = await viewer(['EXECUTIVE']);
    const r = await http().get('/v1/viewer/_probe').set('Authorization', v.bearer);
    expect(r.status).toBe(200);
    const [prof] = await rows(`SELECT id::text FROM core.viewer_profiles WHERE code = 'EXECUTIVE'`);
    expect(r.body).toMatchObject({ u: 'viewer_ro', prof: prof?.id, core: '42501', appPool: 'blocked' });
    expect(r.body.n).toBeGreaterThan(0); // EXECUTIVE toàn chuỗi
    const none = await viewer([]);
    expect((await http().get('/v1/viewer/_probe').set('Authorization', none.bearer)).status).toBe(403);
    const two = await viewer(['EXECUTIVE', 'SHAREHOLDER']);
    expect((await http().get('/v1/viewer/_probe').set('Authorization', two.bearer)).status).toBe(403);
  });
});
