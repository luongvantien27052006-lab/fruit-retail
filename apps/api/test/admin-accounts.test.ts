import type { INestApplication } from '@nestjs/common';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { generateKeyPairSync, type KeyObject, randomBytes, randomUUID, sign } from 'node:crypto';
import { generateSync } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAuthKeys } from '../src/auth/auth-config';
import { enrollmentCodeHash, newEnrollmentCode, normalizeEnrollmentCode, proofMessage } from '../src/auth/device-proof';
import { ARGON_PROFILES, hashSecret } from '../src/auth/password';
import { PiiCipher, totpAad } from '../src/auth/pii-cipher';
import { createApp } from '../src/bootstrap';
import { createMaster } from '../src/cli/create-master';
import { loadEnv } from '../src/config/env';
import { testAuthEnv } from './helpers/auth-env';
import { schemaErrors } from './helpers/contract';
import { type MigratedDb, startMigratedDb } from './helpers/db';
import { relaxedRatePolicies } from './helpers/rate-limit';

// CP03 lát 8a — tài khoản admin, khóa/mở khóa, reset 2FA, phiên người khác, nhật ký (ADR-026) trên PostgreSQL + Redis thật.

interface Device {
  id: string;
  key: KeyObject;
  pub: string;
}

describe('quản trị tài khoản (CP03 lát 8a)', () => {
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
    app = await createApp(env, { logger: false }, { providers: [relaxedRatePolicies] });
    await app.init();
    const m = await createMaster(db.roleUrl('app_rw'), `m-${hex().toLowerCase()}@fruit.test`, {
      mustChangePassword: false,
    });
    masterId = m.userId;
    master = await stepUp(await adminBearer(m.email, m.password, m.userId), m.userId);
  });
  afterAll(async () => {
    await app?.close();
    await Promise.allSettled([db?.pg.stop(), redis?.stop()]);
  });

  // ───────── lát 8a: tài khoản admin, khóa, 2FA, phiên, nhật ký ─────────

  async function plainMaster() {
    const m = await createMaster(db.roleUrl('app_rw'), `pm-${hex().toLowerCase()}@fruit.test`, {
      mustChangePassword: false,
    });
    return { ...m, bearer: await adminBearer(m.email, m.password, m.userId) };
  }

  it('tạo tài khoản admin: chỉ Master + step-up; mật khẩu tạm đăng nhập được ⇒ bắt buộc đăng ký 2FA; audit không có mật khẩu', async () => {
    const p = await plainMaster();
    const body = { email: `new-${hex().toLowerCase()}@fruit.test`, role: 'MASTER_ADMIN' };
    const no = await http().post('/v1/admin/admin-accounts').set('Authorization', p.bearer).send(body);
    expect([no.status, no.body.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    const r = await http().post('/v1/admin/admin-accounts').set('Authorization', master).send(body);
    expect(r.status).toBe(201);
    expect(schemaErrors('AdminAccountCreateResponse', r.body)).toEqual([]);
    const l = await http().post('/v1/auth/login').send({ email: body.email, password: r.body.temporary_password });
    expect(l.body.status).toBe('ENROLLMENT_REQUIRED');
    expect((await http().post('/v1/admin/admin-accounts').set('Authorization', master).send(body)).status).toBe(409);
    const [a] = await rows(`SELECT after::text AS a FROM audit.logs WHERE resource_id = $1`, [r.body.user_id]);
    expect(String(a?.a)).not.toContain(r.body.temporary_password as string);
    // tài khoản xem cần đúng một hồ sơ
    const v = { email: `v-${hex().toLowerCase()}@fruit.test`, role: 'VIEW_ONLY_ADMIN' };
    expect((await http().post('/v1/admin/admin-accounts').set('Authorization', master).send(v)).status).toBe(400);
    const [prof] = await rows(`SELECT id::text FROM core.viewer_profiles WHERE code = 'EXECUTIVE'`);
    const vr = await http()
      .post('/v1/admin/admin-accounts')
      .set('Authorization', master)
      .send({ ...v, viewer_profile_id: prof?.id });
    expect(vr.status).toBe(201);
    // cửa hàng trưởng không tạo được
    const st = await store();
    const sm = await staffSql([{ role: 'STORE_MANAGER', storeId: st.id }]);
    const c = await staffClient(await activeDevice(st.id), sm);
    expect((await c.post('/v1/admin/admin-accounts', body)).status).toBe(403);
  });

  it('khóa: Master khóa ⇒ thu hồi phiên, đăng nhập 401; không tự khóa; SM khóa nhân viên cửa hàng mình (ngoài ⇒ 404), không mở khóa', async () => {
    const st = await store();
    const other = await store();
    const x = await staffSql([{ role: 'CASHIER', storeId: st.id }]);
    const d = await activeDevice(st.id);
    const cx = await staffClient(d, x);
    const r = await http()
      .post(`/v1/admin/users/${x.userId}/lock`)
      .set('Authorization', master)
      .send({ reason: 'thử khóa' });
    expect(r.status).toBe(200);
    expect(schemaErrors('UserLockResponse', r.body)).toEqual([]);
    expect(r.body.revoked_sessions).toBe(1);
    expect((await cx.get('/v1/auth/sessions')).status).toBe(401);
    expect(
      (
        await http()
          .post('/v1/auth/pin')
          .set('X-Device-Id', d.id)
          .send({ staff_code: x.code, pin: x.pin, device_proof: proof(d, 'pin', x.code) })
      ).status,
    ).toBe(401);
    expect(
      (await http().post(`/v1/admin/users/${masterId}/lock`).set('Authorization', master).send({ reason: 'tự làm' }))
        .status,
    ).toBe(403);
    // mở khóa (Master)
    const u = await http()
      .post(`/v1/admin/users/${x.userId}/unlock`)
      .set('Authorization', master)
      .send({ reason: 'mở lại' });
    expect([u.status, u.body.status]).toEqual([200, 'ACTIVE']);
    await staffClient(d, x);
    // cửa hàng trưởng
    const sm = await staffSql([{ role: 'STORE_MANAGER', storeId: st.id }]);
    const y = await staffSql([{ role: 'CASHIER', storeId: other.id }]);
    const c = await staffClient(d, sm);
    expect((await c.post(`/v1/admin/users/${y.userId}/lock`, { reason: 'ngoài phạm vi' })).status).toBe(404);
    expect((await c.post(`/v1/admin/users/${x.userId}/lock`, { reason: 'trong phạm vi' })).status).toBe(200);
    expect((await c.post(`/v1/admin/users/${x.userId}/unlock`, { reason: 'mở' })).status).toBe(403);
    expect((await c.post(`/v1/admin/users/${masterId}/lock`, { reason: 'khóa Master' })).status).toBe(404);
    // L1: tài khoản DISABLED (Master cho nghỉ) không khóa được ⇒ không có đường "khóa rồi mở khóa" để hồi sinh
    const z = await staffSql([{ role: 'CASHIER', storeId: st.id }]);
    await http().patch(`/v1/admin/staff/${z.userId}`).set('Authorization', master).send({ status: 'DISABLED' });
    const lz = await c.post(`/v1/admin/users/${z.userId}/lock`, { reason: 'khóa người đã nghỉ' });
    expect([lz.status, lz.body.code]).toEqual([409, 'INVALID_STATE_TRANSITION']);
    const [zs] = await rows(`SELECT status::text FROM core.users WHERE id = $1`, [z.userId]);
    expect(zs?.status).toBe('DISABLED');
  });

  it('không khóa được Master hoạt động cuối cùng: hai Master khóa nhau song song ⇒ đúng một thành công', async () => {
    const a = await plainMaster();
    const b = await plainMaster();
    const aUp = await stepUp(a.bearer, a.userId);
    const bUp = await stepUp(b.bearer, b.userId);
    // khóa hết Master khác (owner) để chỉ còn a, b hoạt động
    await rows(`UPDATE core.users SET status = 'LOCKED' WHERE type = 'MASTER' AND id <> ALL($1::uuid[])`, [
      [a.userId, b.userId],
    ]);
    const [ra, rb] = await Promise.all([
      http().post(`/v1/admin/users/${b.userId}/lock`).set('Authorization', aUp).send({ reason: 'đua' }),
      http().post(`/v1/admin/users/${a.userId}/lock`).set('Authorization', bUp).send({ reason: 'đua' }),
    ]);
    const ok = [ra, rb].filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    const [n] = await rows(`SELECT count(*)::int AS n FROM core.users WHERE type = 'MASTER' AND status = 'ACTIVE'`);
    expect(n?.n).toBe(1);
    const bad = [ra, rb].find((r) => r.status !== 200);
    expect([401, 422]).toContain(bad?.status);
    // trả lại trạng thái cho test khác
    await rows(`UPDATE core.users SET status = 'ACTIVE' WHERE type = 'MASTER'`);
  });

  it('reset 2FA người khác: chỉ Master + step-up; thử thách MFA cũ vô hiệu (G4); phiên bị thu hồi; lần sau phải đăng ký lại', async () => {
    const t = await plainMaster();
    // t đăng nhập lại ⇒ có thử thách MFA (đã bật 2FA)
    const l = await http().post('/v1/auth/login').send({ email: t.email, password: t.password });
    expect(l.body.status).toBe('MFA_REQUIRED');
    const codeOld = await totp(t.userId);
    const r = await http()
      .post(`/v1/admin/users/${t.userId}/2fa/reset`)
      .set('Authorization', master)
      .send({ reason: 'mất điện thoại' });
    expect(r.status).toBe(200);
    expect(schemaErrors('TwoFactorResetResponse', r.body)).toEqual([]);
    expect(r.body.revoked_sessions).toBeGreaterThanOrEqual(1);
    const v = await http()
      .post('/v1/auth/2fa/verify')
      .set('Authorization', `Bearer ${l.body.mfa_challenge as string}`)
      .send({ code: codeOld });
    expect(v.status).toBe(401);
    expect((await http().get('/v1/auth/sessions').set('Authorization', t.bearer)).status).toBe(401);
    const again = await http().post('/v1/auth/login').send({ email: t.email, password: t.password });
    expect(again.body.status).toBe('ENROLLMENT_REQUIRED');
    expect((await rows(`SELECT 1 FROM core.recovery_codes WHERE user_id = $1`, [t.userId])).length).toBe(0);
    expect(
      (
        await http()
          .post(`/v1/admin/users/${masterId}/2fa/reset`)
          .set('Authorization', master)
          .send({ reason: 'tự làm' })
      ).status,
    ).toBe(403);
    const st = await store();
    const s = await staffSql([{ role: 'CASHIER', storeId: st.id }]);
    expect(
      (
        await http()
          .post(`/v1/admin/users/${s.userId}/2fa/reset`)
          .set('Authorization', master)
          .send({ reason: 'nhân viên' })
      ).status,
    ).toBe(404);
  });

  it('phiên của người khác: Master xem + thu hồi; không thu hồi phiên hiện tại của mình; nhật ký lọc + phân trang', async () => {
    const t = await plainMaster();
    const list = await http().get(`/v1/admin/users/${t.userId}/sessions`).set('Authorization', master);
    expect(list.status).toBe(200);
    expect(schemaErrors('AdminSessionList', list.body)).toEqual([]);
    const live = (list.body.items as { id: string; active: boolean }[]).find((x) => x.active);
    const rv = await http()
      .post(`/v1/admin/sessions/${live?.id as string}/revoke`)
      .set('Authorization', master)
      .send({ reason: 'nghi lộ' });
    expect(rv.status).toBe(200);
    expect((await http().get('/v1/auth/sessions').set('Authorization', t.bearer)).status).toBe(401);
    const mine = await http().get(`/v1/admin/users/${masterId}/sessions`).set('Authorization', master);
    const cur = (mine.body.items as { id: string; active: boolean }[]).filter((x) => x.active);
    const self = await Promise.all(
      cur.map((x) =>
        // L3: id viết HOA vẫn nhận ra là phiên hiện tại
        http()
          .post(`/v1/admin/sessions/${x.id.toUpperCase()}/revoke`)
          .set('Authorization', master)
          .send({ reason: 'tự làm' }),
      ),
    );
    expect(self.some((r) => r.status === 403)).toBe(true);

    const a1 = await http().get(`/v1/admin/audit-logs?resource_id=${t.userId}`).set('Authorization', master);
    expect(a1.status).toBe(200);
    expect(schemaErrors('AuditLogList', a1.body)).toEqual([]);
    const p1 = await http().get('/v1/admin/audit-logs?limit=2').set('Authorization', master);
    expect(p1.body.items).toHaveLength(2);
    const p2 = await http()
      .get(`/v1/admin/audit-logs?limit=2&cursor=${p1.body.next_cursor as string}`)
      .set('Authorization', master);
    const ids1 = (p1.body.items as { id: string }[]).map((x) => x.id);
    for (const x of p2.body.items as { id: string }[]) expect(ids1).not.toContain(x.id);
    expect((await http().get('/v1/admin/audit-logs?limit=500').set('Authorization', master)).status).toBe(400);
    // cửa hàng trưởng không có audit:read
    const st = await store();
    const sm = await staffSql([{ role: 'STORE_MANAGER', storeId: st.id }]);
    const c = await staffClient(await activeDevice(st.id), sm);
    expect((await c.get('/v1/admin/audit-logs')).status).toBe(403);
    expect((await c.get(`/v1/admin/users/${t.userId}/sessions`)).status).toBe(403);
  });

  it('NC-22 — mật khẩu tạm phải đổi trước khi đăng ký 2FA; sai mật khẩu hiện tại ⇒ 401; chưa kích hoạt quá 72 giờ ⇒ không đăng nhập', async () => {
    const m = await createMaster(db.roleUrl('app_rw'), `nc22-${hex().toLowerCase()}@fruit.test`); // CLI thật: bắt đổi
    const l = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    expect(l.body).toMatchObject({ status: 'ENROLLMENT_REQUIRED', password_change_required: true });
    const b = `Bearer ${l.body.access_token as string}`;
    const s0 = await http().post('/v1/auth/2fa/setup').set('Authorization', b).send({});
    expect([s0.status, s0.body.code]).toEqual([403, 'PASSWORD_CHANGE_REQUIRED']);
    // phiên thứ hai để kiểm "thu hồi phiên khác"
    const l2 = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    const b2 = `Bearer ${l2.body.access_token as string}`;
    const newPw = `Mới-${randomBytes(9).toString('base64url')}`;
    const bad = await http()
      .post('/v1/auth/password')
      .set('Authorization', b)
      .send({ current_password: 'sai-mat-khau', new_password: newPw });
    expect(bad.status).toBe(401);
    const short = await http()
      .post('/v1/auth/password')
      .set('Authorization', b)
      .send({ current_password: m.password, new_password: 'ngắn' });
    expect(short.status).toBe(400);
    const ok = await http()
      .post('/v1/auth/password')
      .set('Authorization', b)
      .send({ current_password: m.password, new_password: newPw });
    expect(ok.status).toBe(200);
    expect(schemaErrors('AuthPasswordResponse', ok.body)).toEqual([]);
    expect(ok.body.revoked_sessions).toBeGreaterThanOrEqual(1);
    expect((await http().get('/v1/auth/sessions').set('Authorization', b2)).status).toBe(401); // phiên khác chết
    expect((await http().post('/v1/auth/2fa/setup').set('Authorization', b).send({})).status).toBe(200); // giờ đăng ký được
    expect((await http().post('/v1/auth/login').send({ email: m.email, password: m.password })).status).toBe(401); // mật khẩu cũ
    const [a] = await rows(`SELECT 1 FROM audit.logs WHERE resource_id = $1 AND action = 'auth.password_change'`, [
      m.userId,
    ]);
    expect(a).toBeTruthy();

    // tài khoản admin mới chưa kích hoạt quá 72 giờ ⇒ đăng nhập 401 chung
    const r = await http()
      .post('/v1/admin/admin-accounts')
      .set('Authorization', master)
      .send({ email: `old-${hex().toLowerCase()}@fruit.test`, role: 'MASTER_ADMIN' });
    await rows(`UPDATE core.users SET created_at = now() - interval '73 hours' WHERE id = $1`, [r.body.user_id]).catch(
      async () => {
        await rows(`ALTER TABLE core.users DISABLE TRIGGER USER`);
        await rows(`UPDATE core.users SET created_at = now() - interval '73 hours' WHERE id = $1`, [r.body.user_id]);
        await rows(`ALTER TABLE core.users ENABLE TRIGGER USER`);
      },
    );
    const old = await http().post('/v1/auth/login').send({ email: r.body.email, password: r.body.temporary_password });
    expect([old.status, old.body.code]).toEqual([401, 'AUTHENTICATION_REQUIRED']);

    // nhân viên không dùng route này
    const st = await store();
    const sm = await staffSql([{ role: 'STORE_MANAGER', storeId: st.id }]);
    const c = await staffClient(await activeDevice(st.id), sm);
    expect((await c.post('/v1/auth/password', { current_password: 'x', new_password: newPw })).status).toBe(403);
  });
});
