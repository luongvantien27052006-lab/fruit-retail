import type { INestApplication } from '@nestjs/common';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { generateKeyPairSync, type KeyObject, randomBytes, randomUUID, sign } from 'node:crypto';
import { generateSync } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAuthKeys } from '../src/auth/auth-config';
import { proofMessage, type ProofPurpose, refreshBinding } from '../src/auth/device-proof';
import { ARGON_PROFILES, hashSecret } from '../src/auth/password';
import { PiiCipher, totpAad } from '../src/auth/pii-cipher';
import { MAX_PENDING_PER_STORE } from '../src/auth/pos-device.service';
import { STAFF_SESSION_S } from '../src/auth/tokens';
import { createApp } from '../src/bootstrap';
import { createMaster } from '../src/cli/create-master';
import { loadEnv } from '../src/config/env';
import { testAuthEnv } from './helpers/auth-env';
import { schemaErrors } from './helpers/contract';
import { type MigratedDb, startMigratedDb } from './helpers/db';

// CP03 lát 4 — nhân viên POS (SEC3, ADR-012, ADR-022) trên PostgreSQL + Redis thật. Kế hoạch: thiết bị PENDING/REVOKED
// không đăng nhập được; chữ ký sai hoặc nonce dùng lại bị từ chối; thu hồi thiết bị ⇒ thu hồi mọi phiên.

interface Device {
  id: string;
  key: KeyObject;
  pub: string;
  storeCode: string;
  pairing?: string;
}

describe('auth nhân viên POS + thiết bị (CP03 lát 4)', () => {
  let db: MigratedDb;
  let redis: StartedRedisContainer;
  let app: INestApplication;
  let cipher: PiiCipher;
  const http = () => request(app.getHttpServer());
  const rows = (sql: string, p: unknown[] = []) => db.q(sql, p);
  const hex = (n = 4) => randomBytes(n).toString('hex');

  // ───────── dữ liệu thử ─────────

  async function store(code = `S${hex(3)}`.toUpperCase()) {
    const id = randomUUID();
    await rows(`INSERT INTO core.stores (id, code, name) VALUES ($1, $2, $3)`, [id, code, `Cửa hàng ${code}`]);
    return { id, code };
  }

  async function staff(
    storeId: string | null,
    opts: { role?: string; pin?: string; code?: string; leftAt?: string } = {},
  ) {
    const userId = randomUUID();
    const code = opts.code ?? `NV${hex(3)}`.toUpperCase();
    const pin = opts.pin ?? '246810';
    await rows(`INSERT INTO core.users (id, type, pin_hash) VALUES ($1, 'STAFF', $2)`, [
      userId,
      await hashSecret(pin, ARGON_PROFILES.PASSWORD),
    ]);
    await rows(`INSERT INTO core.staff (user_id, staff_code, full_name, left_at) VALUES ($1, $2, $3, $4)`, [
      userId,
      code,
      `Nhân viên ${code}`,
      opts.leftAt ?? null,
    ]);
    if (storeId !== undefined)
      await rows(
        `INSERT INTO core.user_role_assignments (id, user_id, role, scope_type, scope_id) VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), userId, opts.role ?? 'CASHIER', storeId ? 'STORE' : 'ALL', storeId],
      );
    return { userId, code, pin };
  }

  function newDevice(storeCode: string): Device {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pub = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
    return { id: randomUUID(), key: privateKey, pub, storeCode };
  }

  function proof(
    d: Device,
    purpose: ProofPurpose,
    binding: string,
    o: { ts?: number; nonce?: string; key?: KeyObject } = {},
  ) {
    const ts = o.ts ?? Math.floor(Date.now() / 1000);
    const nonce = o.nonce ?? randomBytes(16).toString('base64url');
    const signature = sign(null, proofMessage(purpose, d.id, ts, nonce, binding), o.key ?? d.key).toString('base64url');
    return { ts, nonce, signature };
  }

  const registerBody = (d: Device, p = proof(d, 'register', `${d.storeCode}\n${d.pub}`)) => ({
    store_code: d.storeCode,
    name: 'Quầy 1',
    platform: 'windows',
    public_key: d.pub,
    device_proof: p,
  });

  async function register(d: Device) {
    const r = await http().post('/v1/auth/devices/register').set('X-Device-Id', d.id).send(registerBody(d));
    expect(r.status).toBe(201);
    d.pairing = r.body.pairing_code as string;
    return r;
  }

  const pinBody = (d: Device, code: string, pin: string, p = proof(d, 'pin', code.toUpperCase())) => ({
    staff_code: code,
    pin,
    device_proof: p,
  });
  const pin = (d: Device, code: string, pinCode: string, p?: ReturnType<typeof proof>) =>
    http()
      .post('/v1/auth/pin')
      .set('X-Device-Id', d.id)
      .send(pinBody(d, code, pinCode, p));

  // ───────── Master đã qua 2FA (người kích hoạt) ─────────

  async function totp(userId: string): Promise<string> {
    const [u] = await rows(`SELECT totp_secret_enc FROM core.users WHERE id = $1`, [userId]);
    const secret = cipher.decrypt(u?.totp_secret_enc as Buffer, totpAad(userId)).toString('utf8');
    return generateSync({ secret });
  }
  async function masterBearer(): Promise<string> {
    const m = await createMaster(db.roleUrl('app_rw'), `m-${hex()}@fruit.test`);
    const l = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    const bearer = `Bearer ${l.body.access_token as string}`;
    await http().post('/v1/auth/2fa/setup').set('Authorization', bearer).send({});
    const c = await http()
      .post('/v1/auth/2fa/confirm')
      .set('Authorization', bearer)
      .send({ code: await totp(m.userId) });
    expect(c.status).toBe(200);
    return `Bearer ${c.body.access_token as string}`;
  }
  let master: string;

  async function activeDevice(storeCode: string): Promise<Device> {
    const d = newDevice(storeCode);
    await register(d);
    const a = await http()
      .post(`/v1/admin/pos-devices/${d.id}/activate`)
      .set('Authorization', master)
      .send({ pairing_code: d.pairing });
    expect(a.status).toBe(200);
    return d;
  }

  beforeAll(async () => {
    [db, redis] = await Promise.all([startMigratedDb(), new RedisContainer('redis:7.4-alpine').start()]);
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL_APP: db.roleUrl('app_rw'),
      REDIS_URL: redis.getConnectionUrl(),
      PORT: '0',
      LOG_LEVEL: 'silent',
      ...testAuthEnv(db.roleUrl('audit_writer')),
    });
    cipher = new PiiCipher(loadAuthKeys(env));
    app = await createApp(env, { logger: false });
    await app.init();
    master = await masterBearer();
  });
  afterAll(async () => {
    await app?.close();
    await Promise.allSettled([db?.pg.stop(), redis?.stop()]);
  });

  // ───────── đăng ký / kích hoạt ─────────

  it('đăng ký ⇒ PENDING + mã ghép đôi; khóa sai / chữ ký sai / trùng ⇒ từ chối; PENDING không đăng nhập được', async () => {
    const s = await store();
    const n = await staff(s.id);
    const d = newDevice(s.code);
    const r = await register(d);
    expect(schemaErrors('PosDeviceRegisterResponse', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ device_id: d.id, status: 'PENDING' });
    const [row] = await rows(
      `SELECT status, store_id, octet_length(public_key) AS n FROM core.pos_devices WHERE id = $1`,
      [d.id],
    );
    expect(row).toEqual({ status: 'PENDING', store_id: s.id, n: 32 });

    // đăng ký lại cùng khóa / cùng id ⇒ 409
    const again = await http().post('/v1/auth/devices/register').set('X-Device-Id', d.id).send(registerBody(d));
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE_TRANSITION']);
    // chữ ký bằng khóa khác ⇒ 401
    const d2 = newDevice(s.code);
    const other = generateKeyPairSync('ed25519').privateKey;
    const bad = await http()
      .post('/v1/auth/devices/register')
      .set('X-Device-Id', d2.id)
      .send(registerBody(d2, proof(d2, 'register', `${d2.storeCode}\n${d2.pub}`, { key: other })));
    expect([bad.status, bad.body.code]).toEqual([401, 'AUTHENTICATION_REQUIRED']);
    // chữ ký đúng nhưng ràng buộc cửa hàng khác (đổi store_code sau khi ký) ⇒ 401
    const s2 = await store();
    const swapped = { ...registerBody(d2), store_code: s2.code };
    expect((await http().post('/v1/auth/devices/register').set('X-Device-Id', d2.id).send(swapped)).status).toBe(401);
    // khóa công khai bị tráo (chữ ký không khớp khóa gửi lên) ⇒ 401; thiếu X-Device-Id / cửa hàng không có ⇒ 400
    const junk = {
      ...registerBody(d2),
      public_key: generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x,
    };
    expect((await http().post('/v1/auth/devices/register').set('X-Device-Id', d2.id).send(junk)).status).toBe(401);
    expect((await http().post('/v1/auth/devices/register').send(registerBody(d2))).status).toBe(400);
    const d3 = newDevice('KHONGCO');
    expect(
      (await http().post('/v1/auth/devices/register').set('X-Device-Id', d3.id).send(registerBody(d3))).status,
    ).toBe(400);

    // PENDING ⇒ 403 DEVICE_NOT_ACTIVATED, không tạo phiên
    const p = await pin(d, n.code, n.pin);
    expect([p.status, p.body.code]).toEqual([403, 'DEVICE_NOT_ACTIVATED']);
    // thiết bị không tồn tại cũng vậy
    const ghost = newDevice(s.code);
    expect((await pin(ghost, n.code, n.pin)).body.code).toBe('DEVICE_NOT_ACTIVATED');
    expect(await rows(`SELECT 1 FROM core.sessions WHERE user_id = $1`, [n.userId])).toEqual([]);
    // audit đăng ký cùng transaction
    expect((await rows(`SELECT action FROM audit.logs WHERE resource_id = $1`, [d.id])).map((x) => x.action)).toEqual([
      'pos_device.register',
    ]);
  });

  it('kích hoạt: mã ghép đôi sai ⇒ 400; đúng ⇒ ACTIVE (audit); kích hoạt lại ⇒ 409; quầy khác cửa hàng ⇒ 400', async () => {
    const s = await store();
    const d = newDevice(s.code);
    await register(d);
    const wrong = await http()
      .post(`/v1/admin/pos-devices/${d.id}/activate`)
      .set('Authorization', master)
      .send({ pairing_code: 'AAAA-AAAA' });
    expect([wrong.status, wrong.body.code]).toEqual([400, 'INVALID_REQUEST']);
    const otherStore = await store();
    const reg = randomUUID();
    await rows(`INSERT INTO core.registers (id, store_id, code) VALUES ($1, $2, 'Q1')`, [reg, otherStore.id]);
    const badReg = await http()
      .post(`/v1/admin/pos-devices/${d.id}/activate`)
      .set('Authorization', master)
      .send({ pairing_code: d.pairing, register_id: reg });
    expect(badReg.status).toBe(400);
    const ok = await http()
      .post(`/v1/admin/pos-devices/${d.id}/activate`)
      .set('Authorization', master)
      .send({ pairing_code: (d.pairing ?? '').toLowerCase().replace('-', '') });
    expect(ok.status).toBe(200);
    expect(schemaErrors('PosDevice', ok.body)).toEqual([]);
    expect(ok.body.status).toBe('ACTIVE');
    const again = await http()
      .post(`/v1/admin/pos-devices/${d.id}/activate`)
      .set('Authorization', master)
      .send({ pairing_code: d.pairing });
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE_TRANSITION']);
    const list = await http().get('/v1/admin/pos-devices?status=ACTIVE').set('Authorization', master);
    expect(list.status).toBe(200);
    expect(schemaErrors('PosDeviceList', list.body)).toEqual([]);
    expect((list.body.items as { id: string }[]).some((x) => x.id === d.id)).toBe(true);
    const audits = await rows(`SELECT action, actor_type FROM audit.logs WHERE resource_id = $1 ORDER BY at`, [d.id]);
    expect(audits).toEqual([
      { action: 'pos_device.register', actor_type: null },
      { action: 'pos_device.activate', actor_type: 'MASTER' },
    ]);
  });

  it('yêu cầu đăng ký quá 7 ngày không kích hoạt được; trần hàng chờ mỗi cửa hàng ⇒ 429', async () => {
    const s = await store();
    const old = newDevice(s.code);
    await register(old);
    // giả lập đăng ký 8 ngày trước (owner vượt trigger mốc đăng ký)
    await rows(`ALTER TABLE core.pos_devices DISABLE TRIGGER pos_device_transition`);
    await rows(`UPDATE core.pos_devices SET registered_at = now() - interval '8 days' WHERE id = $1`, [old.id]);
    await rows(`ALTER TABLE core.pos_devices ENABLE TRIGGER pos_device_transition`);
    const r = await http()
      .post(`/v1/admin/pos-devices/${old.id}/activate`)
      .set('Authorization', master)
      .send({ pairing_code: old.pairing });
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE_TRANSITION']);

    // thiết bị hết hạn không tính vào trần; gửi song song vẫn không vượt trần
    const devs = Array.from({ length: MAX_PENDING_PER_STORE + 5 }, () => newDevice(s.code));
    const res = await Promise.all(
      devs.map((d) => http().post('/v1/auth/devices/register').set('X-Device-Id', d.id).send(registerBody(d))),
    );
    expect(res.filter((x) => x.status === 201).length).toBe(MAX_PENDING_PER_STORE);
    expect(res.filter((x) => x.status === 429).every((x) => x.body.code === 'RATE_LIMITED')).toBe(true);
    expect(res.filter((x) => x.status === 429).length).toBe(5);
  });

  // ───────── đăng nhập PIN ─────────

  it('PIN đúng trên thiết bị ACTIVE ⇒ phiên STAFF gắn thiết bị, hạn 24 giờ, amr pin; token chỉ dùng kèm đúng X-Device-Id', async () => {
    const s = await store();
    const n = await staff(s.id);
    const d = await activeDevice(s.code);
    const r = await pin(d, n.code.toLowerCase(), n.pin); // mã NV không phân biệt hoa/thường
    expect(r.status).toBe(200);
    expect(schemaErrors('AuthPinResponse', r.body)).toEqual([]);
    expect(r.body.staff).toMatchObject({ user_id: n.userId, staff_code: n.code });
    expect(r.body.amr).toEqual(['pin']);
    const [sess] = await rows(
      `SELECT user_type, pos_device_id, amr, extract(epoch FROM expires_at - created_at)::int AS ttl
       FROM core.sessions WHERE id = $1`,
      [r.body.session_id],
    );
    expect(sess).toEqual({ user_type: 'STAFF', pos_device_id: d.id, amr: ['pin'], ttl: STAFF_SESSION_S });
    const [dev] = await rows(`SELECT last_seen_at IS NOT NULL AS seen FROM core.pos_devices WHERE id = $1`, [d.id]);
    expect(dev?.seen).toBe(true);

    const bearer = `Bearer ${r.body.access_token as string}`;
    expect((await http().get('/v1/auth/sessions').set('Authorization', bearer).set('X-Device-Id', d.id)).status).toBe(
      200,
    );
    const noDev = await http().get('/v1/auth/sessions').set('Authorization', bearer);
    expect([noDev.status, noDev.body.code]).toEqual([401, 'AUTHENTICATION_REQUIRED']);
    const otherDev = await http()
      .get('/v1/auth/sessions')
      .set('Authorization', bearer)
      .set('X-Device-Id', randomUUID());
    expect(otherDev.status).toBe(401);
    // thu ngân không có device:write
    const adm = await http().get('/v1/admin/pos-devices').set('Authorization', bearer).set('X-Device-Id', d.id);
    expect([adm.status, adm.body.code]).toEqual([403, 'ACTION_FORBIDDEN']);
    const logs = await rows(`SELECT result FROM audit.login_logs WHERE user_id = $1`, [n.userId]);
    expect(logs.map((x) => x.result)).toEqual(['SUCCESS']);
  });

  it('sai PIN / mã NV không có / khác cửa hàng / đã nghỉ việc ⇒ cùng 401; 5 lần sai ⇒ khóa, PIN đúng cũng 401', async () => {
    const s = await store();
    const other = await store();
    const n = await staff(s.id);
    const foreign = await staff(other.id);
    const left = await staff(s.id, { leftAt: '2020-01-01' });
    const d = await activeDevice(s.code);
    const res = [
      await pin(d, n.code, '000000'),
      await pin(d, 'KHONGCO', '000000'),
      await pin(d, foreign.code, foreign.pin),
      await pin(d, left.code, left.pin),
    ];
    for (const r of res)
      expect([r.status, r.body.code, r.body.message]).toEqual([401, res[0]?.body.code, res[0]?.body.message]);
    expect(res[0]?.body.code).toBe('AUTHENTICATION_REQUIRED');
    for (let i = 0; i < 4; i++) await pin(d, n.code, '000000');
    const locked = await pin(d, n.code, n.pin);
    expect([locked.status, locked.body.message]).toEqual([401, res[0]?.body.message]);
    const [u] = await rows(`SELECT locked_until > now() AS locked FROM core.users WHERE id = $1`, [n.userId]);
    expect(u?.locked).toBe(true);
    const results = (await rows(`SELECT result FROM audit.login_logs WHERE user_id = $1 ORDER BY at`, [n.userId])).map(
      (x) => x.result,
    );
    expect(results).toEqual([...Array(5).fill('BAD_CREDENTIALS'), 'LOCKED']);
    expect((await rows(`SELECT result FROM audit.login_logs WHERE user_id = $1`, [foreign.userId]))[0]?.result).toBe(
      'STORE_NOT_ALLOWED',
    );
    // không lưu mã NV / PIN rõ trong nhật ký
    const dump = JSON.stringify(await rows(`SELECT * FROM audit.login_logs`));
    expect(dump).not.toContain(n.code);
    expect(dump).not.toContain(n.pin);
  });

  it('chữ ký sai, ràng buộc sai, đồng hồ lệch, nonce dùng lại ⇒ 401 (kể cả sau một lần PIN sai)', async () => {
    const s = await store();
    const n = await staff(s.id);
    const d = await activeDevice(s.code);
    const other = generateKeyPairSync('ed25519').privateKey;
    const cases = [
      proof(d, 'pin', n.code, { key: other }), // khóa khác
      proof(d, 'pin', 'NV_KHAC'), // ký cho mã NV khác
      proof(d, 'refresh', n.code), // sai mục đích
      proof(d, 'pin', n.code, { ts: Math.floor(Date.now() / 1000) - 600 }), // cũ 10 phút
      proof(d, 'pin', n.code, { ts: Math.floor(Date.now() / 1000) + 600 }), // tương lai
    ];
    for (const p of cases) {
      const r = await pin(d, n.code, n.pin, p);
      expect([r.status, r.body.code]).toEqual([401, 'AUTHENTICATION_REQUIRED']);
    }
    // nonce đã dùng cho một lần PIN sai ⇒ phát lại với PIN đúng bị chặn
    const p1 = proof(d, 'pin', n.code);
    expect((await pin(d, n.code, '000000', p1)).status).toBe(401);
    const replay = await pin(d, n.code, n.pin, p1);
    expect(replay.status).toBe(401);
    // phát lại một request THÀNH CÔNG ⇒ chặn
    const p2 = proof(d, 'pin', n.code);
    expect((await pin(d, n.code, n.pin, p2)).status).toBe(200);
    expect((await pin(d, n.code, n.pin, p2)).status).toBe(401);
    // không lần thử chữ ký sai nào đụng bộ đếm PIN (chỉ lần PIN sai thật)
    const [u] = await rows(`SELECT failed_login_count FROM core.users WHERE id = $1`, [n.userId]);
    expect(u?.failed_login_count).toBe(0); // lần đúng sau đó đã xóa
    const results = (await rows(`SELECT result FROM audit.login_logs WHERE device = $1`, [d.id])).map((x) => x.result);
    expect(results.filter((x) => x === 'DEVICE_PROOF_INVALID').length).toBe(5);
    expect(results.filter((x) => x === 'DEVICE_NONCE_REUSED').length).toBe(2);
  });

  // ───────── refresh nhân viên ─────────

  it('refresh nhân viên: bắt buộc chữ ký đúng thiết bị; không gia hạn; token lộ mà không có khóa thì vô dụng', async () => {
    const s = await store();
    const n = await staff(s.id);
    const d = await activeDevice(s.code);
    const l = await pin(d, n.code, n.pin);
    const rt = l.body.refresh_token as string;
    const [before] = await rows(`SELECT expires_at FROM core.sessions WHERE id = $1`, [l.body.session_id]);

    const noProof = await http().post('/v1/auth/refresh').set('X-Device-Id', d.id).send({ refresh_token: rt });
    expect(noProof.status).toBe(401);
    // kẻ gian có refresh token + chép X-Device-Id nhưng không có khóa ⇒ 401, phiên KHÔNG bị thu hồi
    const other = generateKeyPairSync('ed25519').privateKey;
    const forged = await http()
      .post('/v1/auth/refresh')
      .set('X-Device-Id', d.id)
      .send({ refresh_token: rt, device_proof: proof(d, 'refresh', refreshBinding(rt), { key: other }) });
    expect(forged.status).toBe(401);
    // thiết bị khác (đã kích hoạt, chữ ký hợp lệ của chính nó) ⇒ 401
    const d2 = await activeDevice(s.code);
    const cross = await http()
      .post('/v1/auth/refresh')
      .set('X-Device-Id', d2.id)
      .send({ refresh_token: rt, device_proof: proof(d2, 'refresh', refreshBinding(rt)) });
    expect(cross.status).toBe(401);
    const [mid] = await rows(`SELECT revoked_at FROM core.sessions WHERE id = $1`, [l.body.session_id]);
    expect(mid?.revoked_at).toBeNull();

    const ok = await http()
      .post('/v1/auth/refresh')
      .set('X-Device-Id', d.id)
      .send({ refresh_token: rt, device_proof: proof(d, 'refresh', refreshBinding(rt)) });
    expect(ok.status).toBe(200);
    expect(schemaErrors('AuthTokenPair', ok.body)).toEqual([]);
    const [after] = await rows(`SELECT expires_at FROM core.sessions WHERE id = $1`, [l.body.session_id]);
    expect(after?.expires_at).toEqual(before?.expires_at); // hạn tuyệt đối 24 giờ
    expect(
      (
        await http()
          .get('/v1/auth/sessions')
          .set('Authorization', `Bearer ${ok.body.access_token as string}`)
          .set('X-Device-Id', d.id)
      ).status,
    ).toBe(200);
    // dùng lại refresh đã xoay (có chữ ký hợp lệ) ⇒ thu hồi cả phiên
    const reuse = await http()
      .post('/v1/auth/refresh')
      .set('X-Device-Id', d.id)
      .send({ refresh_token: rt, device_proof: proof(d, 'refresh', refreshBinding(rt)) });
    expect([reuse.status, reuse.body.code]).toEqual([401, 'SESSION_REVOKED']);
    const [end] = await rows(`SELECT revoke_reason FROM core.sessions WHERE id = $1`, [l.body.session_id]);
    expect(end?.revoke_reason).toBe('REFRESH_REUSE');
  });

  // ───────── thu hồi ─────────

  it('thu hồi thiết bị ⇒ thu hồi mọi phiên; token/refresh/PIN trên thiết bị đó bị từ chối; audit có lý do', async () => {
    const s = await store();
    const a = await staff(s.id);
    const b = await staff(s.id);
    const d = await activeDevice(s.code);
    const la = await pin(d, a.code, a.pin);
    const lb = await pin(d, b.code, b.pin);
    const r = await http()
      .post(`/v1/admin/pos-devices/${d.id}/revoke`)
      .set('Authorization', master)
      .send({ reason: 'mất máy' });
    expect(r.status).toBe(200);
    expect(schemaErrors('PosDeviceRevokeResponse', r.body)).toEqual([]);
    expect(r.body.revoked_sessions).toBe(2);
    const sess = await rows(`SELECT revoke_reason FROM core.sessions WHERE pos_device_id = $1`, [d.id]);
    expect(sess.map((x) => x.revoke_reason)).toEqual(['DEVICE_REVOKED', 'DEVICE_REVOKED']);
    const use = await http()
      .get('/v1/auth/sessions')
      .set('Authorization', `Bearer ${la.body.access_token as string}`)
      .set('X-Device-Id', d.id);
    expect([use.status, use.body.code]).toEqual([401, 'SESSION_REVOKED']);
    const rt = lb.body.refresh_token as string;
    const ref = await http()
      .post('/v1/auth/refresh')
      .set('X-Device-Id', d.id)
      .send({ refresh_token: rt, device_proof: proof(d, 'refresh', refreshBinding(rt)) });
    expect(ref.status).toBeGreaterThanOrEqual(401);
    expect(['SESSION_REVOKED', 'DEVICE_REVOKED']).toContain(ref.body.code);
    const p = await pin(d, a.code, a.pin);
    expect([p.status, p.body.code]).toEqual([403, 'DEVICE_REVOKED']);
    const again = await http()
      .post(`/v1/admin/pos-devices/${d.id}/revoke`)
      .set('Authorization', master)
      .send({ reason: 'lại' });
    expect(again.status).toBe(409);
    const [au] = await rows(
      `SELECT reason, after FROM audit.logs WHERE resource_id = $1 AND action = 'pos_device.revoke'`,
      [d.id],
    );
    expect(au).toEqual({ reason: 'mất máy', after: { status: 'REVOKED', revoked_sessions: 2 } });
    // thiết bị PENDING cũng thu hồi được (từ chối yêu cầu đăng ký)
    const pend = newDevice(s.code);
    await register(pend);
    const rej = await http()
      .post(`/v1/admin/pos-devices/${pend.id}/revoke`)
      .set('Authorization', master)
      .send({ reason: 'không rõ máy' });
    expect([rej.status, rej.body.device.status, rej.body.revoked_sessions]).toEqual([200, 'REVOKED', 0]);
  });

  it('thu hồi chạy đua với nhiều đăng nhập PIN + refresh: không lỗi 500, không còn phiên sống trên thiết bị đã thu hồi', async () => {
    const s = await store();
    const people = await Promise.all(Array.from({ length: 6 }, () => staff(s.id)));
    const d = await activeDevice(s.code);
    const first = await pin(d, people[0]?.code ?? '', people[0]?.pin ?? '');
    const rt = first.body.refresh_token as string;
    const res = await Promise.all([
      ...people.slice(1).map((n) => pin(d, n.code, n.pin)),
      http()
        .post('/v1/auth/refresh')
        .set('X-Device-Id', d.id)
        .send({ refresh_token: rt, device_proof: proof(d, 'refresh', refreshBinding(rt)) }),
      http().post(`/v1/admin/pos-devices/${d.id}/revoke`).set('Authorization', master).send({ reason: 'đua' }),
    ]);
    expect(res.every((r) => r.status < 500)).toBe(true);
    expect(res.at(-1)?.status).toBe(200);
    // L1: đăng nhập thua cuộc đua ⇒ 403 DEVICE_REVOKED (không phải 400), có dòng login_logs
    for (const x of res.slice(0, 5)) {
      expect([200, 429, 403]).toContain(x.status);
      if (x.status === 403) expect(x.body.code).toBe('DEVICE_REVOKED');
    }
    const live = await rows(
      `SELECT count(*)::int AS n FROM core.sessions WHERE pos_device_id = $1 AND revoked_at IS NULL`,
      [d.id],
    );
    expect(live[0]?.n).toBe(0);
    // L5: số phiên trong response = số phiên thực bị thu hồi vì thiết bị
    const [{ n: revoked } = { n: -1 }] = await rows(
      `SELECT count(*)::int AS n FROM core.sessions WHERE pos_device_id = $1 AND revoke_reason = 'DEVICE_REVOKED'`,
      [d.id],
    );
    expect(res.at(-1)?.body.revoked_sessions).toBe(revoked);
  });

  it('nhiều nhân viên đăng nhập song song trên cùng thiết bị ⇒ không deadlock; quá 3 suất Argon2/thiết bị ⇒ 429', async () => {
    const s = await store();
    const people = await Promise.all(Array.from({ length: 6 }, () => staff(s.id)));
    const d = await activeDevice(s.code);
    const three = await Promise.all(people.slice(0, 3).map((n) => pin(d, n.code, n.pin)));
    expect(three.map((r) => r.status)).toEqual([200, 200, 200]);
    const six = await Promise.all(people.map((n) => pin(d, n.code, n.pin)));
    expect(six.every((r) => r.status === 200 || (r.status === 429 && r.body.code === 'RATE_LIMITED'))).toBe(true);
    expect(six.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(3);
  });

  // ───────── phạm vi cửa hàng ─────────

  it('cửa hàng trưởng chỉ thấy/kích hoạt/thu hồi thiết bị cửa hàng mình; ngoài phạm vi ⇒ 404', async () => {
    const a = await store();
    const b = await store();
    const sm = await staff(a.id, { role: 'STORE_MANAGER' });
    const da = await activeDevice(a.code);
    const l = await pin(da, sm.code, sm.pin);
    const bearer = `Bearer ${l.body.access_token as string}`;
    const pa = newDevice(a.code);
    const pb = newDevice(b.code);
    await register(pa);
    await register(pb);
    const list = await http().get('/v1/admin/pos-devices').set('Authorization', bearer).set('X-Device-Id', da.id);
    expect(list.status).toBe(200);
    const ids = (list.body.items as { id: string; store_id: string }[]).map((x) => x.store_id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((x) => x === a.id)).toBe(true);
    const foreign = await http()
      .post(`/v1/admin/pos-devices/${pb.id}/activate`)
      .set('Authorization', bearer)
      .set('X-Device-Id', da.id)
      .send({ pairing_code: pb.pairing });
    expect([foreign.status, foreign.body.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    const foreignRevoke = await http()
      .post(`/v1/admin/pos-devices/${pb.id}/revoke`)
      .set('Authorization', bearer)
      .set('X-Device-Id', da.id)
      .send({ reason: 'thử' });
    expect(foreignRevoke.status).toBe(404);
    const own = await http()
      .post(`/v1/admin/pos-devices/${pa.id}/activate`)
      .set('Authorization', bearer)
      .set('X-Device-Id', da.id)
      .send({ pairing_code: pa.pairing });
    expect(own.status).toBe(200);
    const [au] = await rows(
      `SELECT actor_type, device_id FROM audit.logs WHERE resource_id = $1 AND action = 'pos_device.activate'`,
      [pa.id],
    );
    // audit ghi thiết bị POS đã xác minh của người thực hiện
    expect(au).toEqual({ actor_type: 'STAFF', device_id: da.id });
  });

  // ───────── sửa theo kiểm thử agent lần 1 ─────────

  it('L1 — tạo phiên khi thiết bị vừa bị thu hồi ⇒ 403 DEVICE_REVOKED + login_logs', async () => {
    const s = await store();
    const n = await staff(s.id);
    const d = await activeDevice(s.code);
    // mô phỏng thu hồi commit sau bước kiểm chữ ký: trigger chặn tạo phiên STAFF trên thiết bị này
    await rows(`ALTER TABLE core.sessions DISABLE TRIGGER sessions_guard`);
    await rows(`
      CREATE FUNCTION core.zz_block_session() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION 'thu hồi giả lập' USING ERRCODE = 'check_violation'; END $f$`);
    await rows(
      `CREATE TRIGGER zz_block BEFORE INSERT ON core.sessions FOR EACH ROW EXECUTE FUNCTION core.zz_block_session()`,
    );
    try {
      const r = await pin(d, n.code, n.pin);
      expect([r.status, r.body.code]).toEqual([403, 'DEVICE_REVOKED']);
    } finally {
      await rows(`DROP TRIGGER zz_block ON core.sessions`);
      await rows(`DROP FUNCTION core.zz_block_session()`);
      await rows(`ALTER TABLE core.sessions ENABLE TRIGGER sessions_guard`);
    }
    const logs = await rows(`SELECT result FROM audit.login_logs WHERE user_id = $1`, [n.userId]);
    expect(logs.map((x) => x.result)).toEqual(['DEVICE_REVOKED']);
  });

  it('L2 — nghỉ việc ⇒ phiên chết ngay; mất vai trò ở cửa hàng ⇒ refresh bị từ chối', async () => {
    const s = await store();
    const a = await staff(s.id);
    const b = await staff(s.id);
    const d = await activeDevice(s.code);
    const la = await pin(d, a.code, a.pin);
    const lb = await pin(d, b.code, b.pin);
    await rows(`UPDATE core.staff SET left_at = current_date WHERE user_id = $1`, [a.userId]);
    const use = await http()
      .get('/v1/auth/sessions')
      .set('Authorization', `Bearer ${la.body.access_token as string}`)
      .set('X-Device-Id', d.id);
    expect([use.status, use.body.code]).toEqual([401, 'SESSION_REVOKED']);
    const rta = la.body.refresh_token as string;
    const refA = await http()
      .post('/v1/auth/refresh')
      .set('X-Device-Id', d.id)
      .send({ refresh_token: rta, device_proof: proof(d, 'refresh', refreshBinding(rta)) });
    expect(refA.status).toBe(401);
    await rows(`UPDATE core.user_role_assignments SET revoked_at = now(), revoked_by = user_id WHERE user_id = $1`, [
      b.userId,
    ]);
    const rtb = lb.body.refresh_token as string;
    const refB = await http()
      .post('/v1/auth/refresh')
      .set('X-Device-Id', d.id)
      .send({ refresh_token: rtb, device_proof: proof(d, 'refresh', refreshBinding(rtb)) });
    expect([refB.status, refB.body.code]).toEqual([401, 'SESSION_REVOKED']);
  });

  it('L3/L4 — danh sách không trả mã ghép đôi, ẩn REVOKED mặc định, không hiện PENDING hết hạn; mã 50 bit', async () => {
    const s = await store();
    const d = newDevice(s.code);
    await register(d);
    expect(d.pairing).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    const gone = newDevice(s.code);
    await register(gone);
    await http().post(`/v1/admin/pos-devices/${gone.id}/revoke`).set('Authorization', master).send({ reason: 'rác' });
    const old = newDevice(s.code);
    await register(old);
    await rows(`ALTER TABLE core.pos_devices DISABLE TRIGGER pos_device_transition`);
    await rows(`UPDATE core.pos_devices SET registered_at = now() - interval '8 days' WHERE id = $1`, [old.id]);
    await rows(`ALTER TABLE core.pos_devices ENABLE TRIGGER pos_device_transition`);
    const all = await http().get('/v1/admin/pos-devices').set('Authorization', master);
    expect(schemaErrors('PosDeviceList', all.body)).toEqual([]);
    const ids = (all.body.items as { id: string }[]).map((x) => x.id);
    expect(ids).toContain(d.id);
    expect(ids).not.toContain(gone.id);
    expect(ids).not.toContain(old.id);
    expect(JSON.stringify(all.body)).not.toContain(d.pairing);
    const rev = await http().get('/v1/admin/pos-devices?status=REVOKED').set('Authorization', master);
    expect((rev.body.items as { id: string }[]).map((x) => x.id)).toContain(gone.id);
  });

  it('nonce phải ở dạng base64url chuẩn (không bit thừa) ⇒ một nonce chỉ có một cách viết', async () => {
    const s = await store();
    const n = await staff(s.id);
    const d = await activeDevice(s.code);
    const canon = randomBytes(16).toString('base64url'); // 22 ký tự, 4 bit cuối thừa = 0
    const last = canon.at(-1) ?? 'A';
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alt = canon.slice(0, -1) + alphabet[(alphabet.indexOf(last) & ~15) | 1];
    expect(Buffer.from(alt, 'base64url').equals(Buffer.from(canon, 'base64url'))).toBe(true);
    expect((await pin(d, n.code, n.pin, proof(d, 'pin', n.code, { nonce: alt }))).status).toBe(401);
    expect((await pin(d, n.code, n.pin, proof(d, 'pin', n.code, { nonce: canon }))).status).toBe(200);
  });
});
