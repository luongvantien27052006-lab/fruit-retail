import type { INestApplication } from '@nestjs/common';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { generateSync } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { ipSource } from '../src/auth/auth-attempts';
import { loadAuthKeys } from '../src/auth/auth-config';
import { normalizeRecoveryCode, slidingExpiry } from '../src/auth/auth.service';
import { ARGON_PROFILES, hashSecret, verifySecret } from '../src/auth/password';
import { PiiCipher, totpAad } from '../src/auth/pii-cipher';
import { AccessTokens, ADMIN_ABSOLUTE_S, ADMIN_SLIDING_S } from '../src/auth/tokens';
import { createApp } from '../src/bootstrap';
import { createMaster } from '../src/cli/create-master';
import { loadEnv } from '../src/config/env';
import { newJwtKey, testAuthEnv } from './helpers/auth-env';
import { relaxedRatePolicies } from './helpers/rate-limit';
import { eventPayloadErrors, schemaErrors } from './helpers/contract';
import { type MigratedDb, startMigratedDb } from './helpers/db';

// CP03 lát 3 — xác thực Master/Viewer trên PostgreSQL + Redis thật. Kế hoạch: thiếu 2FA không vào được Master;
// step-up hết hạn ⇒ STEP_UP_REQUIRED; refresh cũ dùng lại ⇒ thu hồi cả họ (SEC1/2/4/5, ADR-012/021).

describe('auth Master/Viewer (CP03 lát 3)', () => {
  let db: MigratedDb;
  let redis: StartedRedisContainer;
  let app: INestApplication;
  let authEnv: Record<string, string>;
  const http = () => request(app.getHttpServer());
  const rows = (sql: string, p: unknown[] = []) => db.q(sql, p);

  /** TOTP của user: giải mã secret trong DB bằng khóa test (không đi đường tắt qua API) */
  let cipher: PiiCipher;
  async function totp(userId: string, offsetS = 0): Promise<string> {
    const [u] = await rows(`SELECT totp_secret_enc FROM core.users WHERE id = $1`, [userId]);
    const secret = cipher.decrypt(u?.totp_secret_enc as Buffer, totpAad(userId)).toString('utf8');
    return generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + offsetS });
  }
  /** Mô phỏng "đã sang bước 30 s mới" để dùng mã kế tiếp (mã cũ vẫn bị chặn dùng lại trong test riêng) */
  const forgetStep = (userId: string) => rows(`UPDATE core.users SET totp_last_step = NULL WHERE id = $1`, [userId]);
  const unlock = async (userId: string) => {
    await rows(`DELETE FROM core.auth_lockouts WHERE user_id = $1`, [userId]);
    await rows(`UPDATE core.users SET locked_until = NULL WHERE id = $1`, [userId]);
  };
  /** ADR-030: khóa theo (tài khoản, nguồn) — test chạy từ một IP ⇒ một dòng nguồn */
  const lockRow = async (userId: string) =>
    (
      await rows(
        `SELECT failed_count, lock_count, EXTRACT(EPOCH FROM locked_until - now())::int AS left_s,
                (locked_until > now()) IS TRUE AS locked
         FROM core.auth_lockouts WHERE user_id = $1 AND source LIKE 'ip:%'`,
        [userId],
      )
    )[0];

  async function enrolledMaster(device = `dev-${randomBytes(6).toString('hex')}`) {
    const m = await createMaster(db.roleUrl('app_rw'), `m-${randomBytes(4).toString('hex')}@fruit.test`, {
      mustChangePassword: false,
    });
    const l = await http()
      .post('/v1/auth/login')
      .set('X-Device-Id', device)
      .send({ email: m.email, password: m.password });
    expect(l.body.status).toBe('ENROLLMENT_REQUIRED');
    const bearer = `Bearer ${l.body.access_token as string}`;
    expect((await http().post('/v1/auth/2fa/setup').set('Authorization', bearer).send({})).status).toBe(200);
    const c = await http()
      .post('/v1/auth/2fa/confirm')
      .set('Authorization', bearer)
      .send({ code: await totp(m.userId) });
    expect(c.status).toBe(200);
    await forgetStep(m.userId);
    return { ...m, device, recovery: c.body.recovery_codes as string[], enrollSession: l.body.session_id as string };
  }

  async function fullLogin(m: { email: string; password: string; userId: string }, device?: string) {
    const l = http().post('/v1/auth/login');
    if (device) void l.set('X-Device-Id', device);
    const r1 = await l.send({ email: m.email, password: m.password });
    expect(r1.body.status).toBe('MFA_REQUIRED');
    const v = http()
      .post('/v1/auth/2fa/verify')
      .set('Authorization', `Bearer ${r1.body.mfa_challenge as string}`);
    if (device) void v.set('X-Device-Id', device);
    const r2 = await v.send({ code: await totp(m.userId) });
    expect(r2.status).toBe(200);
    await forgetStep(m.userId);
    return r2.body as { access_token: string; refresh_token: string; session_id: string };
  }

  beforeAll(async () => {
    [db, redis] = await Promise.all([startMigratedDb(), new RedisContainer('redis:7.4-alpine').start()]);
    authEnv = testAuthEnv(db.roleUrl('audit_writer'));
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL_APP: db.roleUrl('app_rw'),
      REDIS_URL: redis.getConnectionUrl(),
      PORT: '0',
      LOG_LEVEL: 'silent',
      ...authEnv,
    });
    cipher = new PiiCipher(loadAuthKeys(env));
    app = await createApp(env, { logger: false }, { providers: [relaxedRatePolicies] });
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    await Promise.allSettled([db?.pg.stop(), redis?.stop()]);
  });

  it('sai email/mật khẩu ⇒ 401 như nhau; login_logs ghi HMAC định danh, không có email rõ', async () => {
    const m = await createMaster(db.roleUrl('app_rw'), 'Sai.Pass@Fruit.test', { mustChangePassword: false });
    const a = await http().post('/v1/auth/login').send({ email: 'khong-co@fruit.test', password: 'x' });
    const b = await http().post('/v1/auth/login').send({ email: m.email, password: 'sai-mat-khau' });
    expect([a.status, a.body.code, b.status, b.body.code]).toEqual([
      401,
      'AUTHENTICATION_REQUIRED',
      401,
      'AUTHENTICATION_REQUIRED',
    ]);
    expect(a.body.message).toBe(b.body.message);
    const logs = await rows(`SELECT result, identifier_hash, user_id FROM audit.login_logs ORDER BY at`);
    expect(logs.map((l) => l.result)).toEqual(['UNKNOWN_USER', 'BAD_CREDENTIALS']);
    expect(logs.every((l) => (l.identifier_hash as Buffer).length === 32)).toBe(true);
    const dump = JSON.stringify(await rows(`SELECT * FROM audit.login_logs`));
    expect(dump).not.toContain('fruit.test');
    expect(m.email).toBe('sai.pass@fruit.test'); // email chuẩn hóa chữ thường
  });

  it('SEC1 — Master chưa đăng ký 2FA chỉ gọi được route đăng ký; đăng ký xong mới vào được', async () => {
    const m = await createMaster(db.roleUrl('app_rw'), 'enroll@fruit.test', { mustChangePassword: false });
    const l = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    expect(l.status).toBe(200);
    expect(l.body.status).toBe('ENROLLMENT_REQUIRED');
    const bearer = `Bearer ${l.body.access_token as string}`;
    const blocked = await http().get('/v1/auth/sessions').set('Authorization', bearer);
    expect([blocked.status, blocked.body.code]).toEqual([403, 'TWO_FACTOR_ENROLLMENT_REQUIRED']);
    // confirm khi chưa setup ⇒ 409
    expect(
      (await http().post('/v1/auth/2fa/confirm').set('Authorization', bearer).send({ code: '123456' })).status,
    ).toBe(409);
    const s = await http().post('/v1/auth/2fa/setup').set('Authorization', bearer).send({});
    expect(s.status).toBe(200);
    expect(s.body.otpauth_uri).toMatch(/^otpauth:\/\/totp\//);
    // secret lưu mã hóa (ADR-015): không có bản rõ trong DB; AAD gắn đúng dòng
    const [u] = await rows(`SELECT totp_secret_enc, totp_enabled_at FROM core.users WHERE id = $1`, [m.userId]);
    expect((u?.totp_secret_enc as Buffer).toString('latin1')).not.toContain(s.body.secret);
    expect(u?.totp_enabled_at).toBeNull();
    expect(() => cipher.decrypt(u?.totp_secret_enc as Buffer, totpAad(randomBytes(16).toString('hex')))).toThrow();
    const wrong = await http().post('/v1/auth/2fa/confirm').set('Authorization', bearer).send({ code: '000000' });
    expect([wrong.status, wrong.body.code]).toEqual([401, 'OTP_INVALID']);
    const ok = await http()
      .post('/v1/auth/2fa/confirm')
      .set('Authorization', bearer)
      .send({ code: await totp(m.userId) });
    expect(ok.status).toBe(200);
    expect(ok.body.recovery_codes).toHaveLength(10);
    expect(new Set(ok.body.recovery_codes as string[]).size).toBe(10);
    // phiên hiện tại đã qua 2FA ⇒ vào được
    expect((await http().get('/v1/auth/sessions').set('Authorization', bearer)).status).toBe(200);
    // mã khôi phục lưu Argon2id, không bản rõ
    const codes = await rows(`SELECT code_hash FROM core.recovery_codes WHERE user_id = $1`, [m.userId]);
    expect(codes).toHaveLength(10);
    expect(codes.every((c) => String(c.code_hash).startsWith('$argon2id$'))).toBe(true);
    // đã bật 2FA ⇒ setup lại bị từ chối; mật khẩu đúng thôi không ra phiên nữa
    expect((await http().post('/v1/auth/2fa/setup').set('Authorization', bearer).send({})).status).toBe(409);
    const again = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    expect(again.body.status).toBe('MFA_REQUIRED');
    expect(again.body.access_token).toBeUndefined();
    const audit = await rows(`SELECT action FROM audit.logs WHERE resource_id = $1 ORDER BY at`, [m.userId]);
    expect(audit.map((a) => a.action)).toEqual(['user.master_create', 'auth.totp_setup', 'auth.totp_enable']);
  });

  it('2FA verify: mã đúng ⇒ phiên; mfa_challenge dùng 1 lần; mã TOTP đã dùng không dùng lại được', async () => {
    const m = await enrolledMaster();
    const l = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    const ch = `Bearer ${l.body.mfa_challenge as string}`;
    const bad = await http().post('/v1/auth/2fa/verify').set('Authorization', ch).send({ code: '000000' });
    expect([bad.status, bad.body.code]).toEqual([401, 'OTP_INVALID']);
    const code = await totp(m.userId);
    const ok = await http().post('/v1/auth/2fa/verify').set('Authorization', ch).send({ code });
    expect(ok.status).toBe(200);
    expect(ok.body.amr).toEqual(['pwd', 'otp']);
    const reuseCh = await http().post('/v1/auth/2fa/verify').set('Authorization', ch).send({ code });
    expect([reuseCh.status, reuseCh.body.code]).toEqual([401, 'MFA_CHALLENGE_INVALID']);
    // challenge mới + CÙNG mã TOTP (cùng bước 30 s) ⇒ bị chặn dùng lại
    const l2 = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    const replay = await http()
      .post('/v1/auth/2fa/verify')
      .set('Authorization', `Bearer ${l2.body.mfa_challenge as string}`)
      .send({ code });
    expect([replay.status, replay.body.code]).toEqual([401, 'OTP_INVALID']);
    // token thử thách không phải access token và ngược lại
    expect((await http().get('/v1/auth/sessions').set('Authorization', ch)).status).toBe(401);
    const asCh = await http()
      .post('/v1/auth/2fa/verify')
      .set('Authorization', `Bearer ${ok.body.access_token as string}`)
      .send({ code: '123456' });
    expect([asCh.status, asCh.body.code]).toEqual([401, 'MFA_CHALLENGE_INVALID']);
  });

  it('mfa_challenge hết hạn ⇒ MFA_CHALLENGE_INVALID; 5 lần sai trên một challenge ⇒ challenge chết', async () => {
    const m = await enrolledMaster();
    const l = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    await rows(
      `UPDATE core.auth_challenges SET created_at = now() - interval '6 minutes', expires_at = now() - interval '1 minute'
       WHERE user_id = $1`,
      [m.userId],
    );
    const exp = await http()
      .post('/v1/auth/2fa/verify')
      .set('Authorization', `Bearer ${l.body.mfa_challenge as string}`)
      .send({ code: await totp(m.userId) });
    expect([exp.status, exp.body.code]).toEqual([401, 'MFA_CHALLENGE_INVALID']);
  });

  it('SEC5 — 5 lần sai mật khẩu từ MỘT nguồn ⇒ khóa nguồn đó 15 phút; đang khóa thì mật khẩu đúng cũng bị chặn', async () => {
    const m = await enrolledMaster();
    for (let i = 0; i < 4; i++)
      expect((await http().post('/v1/auth/login').send({ email: m.email, password: 'sai' })).status).toBe(401);
    // mật khẩu đúng KHÔNG xóa bộ đếm (chưa qua 2FA); lần sai thứ 5 ⇒ khóa nguồn
    const l = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    expect(l.body.status).toBe('MFA_REQUIRED');
    expect((await http().post('/v1/auth/login').send({ email: m.email, password: 'sai' })).status).toBe(401);
    const u = await lockRow(m.userId);
    expect(u?.failed_count).toBe(0);
    expect(u?.lock_count).toBe(1);
    expect(Number(u?.left_s)).toBeGreaterThan(14 * 60);
    expect(Number(u?.left_s)).toBeLessThanOrEqual(15 * 60);
    // /auth/login: đang khóa trả CÙNG lỗi với sai email (không liệt kê email — S3); mật khẩu đúng cũng không qua
    const locked = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    const unknown = await http().post('/v1/auth/login').send({ email: 'khong-ton-tai@fruit.test', password: 'x' });
    expect([locked.status, locked.body.code, locked.body.message]).toEqual([
      unknown.status,
      unknown.body.code,
      unknown.body.message,
    ]);
    // bước 2FA đếm riêng theo tài khoản (review cổng lần 2 TB-3): người ĐÃ đúng mật khẩu trước lúc khóa vẫn hoàn tất được
    // 2FA bằng challenge đã nhận (mỗi challenge tối đa 5 lần, 5 phút); đúng ⇒ xóa khóa của nguồn
    const v = await http()
      .post('/v1/auth/2fa/verify')
      .set('Authorization', `Bearer ${l.body.mfa_challenge as string}`)
      .send({ code: await totp(m.userId) });
    expect([v.status, v.body.code]).toEqual([200, undefined]);
    expect(await lockRow(m.userId)).toBeUndefined();
    await forgetStep(m.userId);
    // lần khóa kế tiếp gấp đôi (30 phút)
    await unlock(m.userId);
    for (let i = 0; i < 5; i++) await http().post('/v1/auth/login').send({ email: m.email, password: 'sai' });
    const u2 = await lockRow(m.userId);
    expect(u2?.lock_count).toBe(1); // unlock() xóa dòng ⇒ đếm lại từ đầu; mức tăng dần kiểm ở test ADR-030 dưới
    expect(Number(u2?.left_s)).toBeGreaterThan(14 * 60);
    // hết khóa + đăng nhập trọn vẹn ⇒ xóa mức khóa tăng dần
    await unlock(m.userId);
    await fullLogin(m);
    expect(await lockRow(m.userId)).toBeUndefined(); // đăng nhập trọn vẹn ⇒ xóa dòng khóa của nguồn
    const results = await rows(`SELECT result FROM audit.login_logs WHERE user_id = $1`, [m.userId]);
    expect(results.some((r) => r.result === 'LOCKED')).toBe(true);
  });

  const countResult = async (userId: string, result: string) =>
    Number(
      (
        await rows(`SELECT count(*)::int AS n FROM audit.login_logs WHERE user_id = $1 AND result = $2`, [
          userId,
          result,
        ])
      )[0]?.n,
    );

  /** Bất biến "không rò": mỗi lần sai đã được kiểm đều nằm trong bộ đếm hoặc đã kích một lần khóa (R1) */
  async function expectNoLeak(userId: string, failResult: string) {
    const [u] = await rows(
      `SELECT COALESCE(sum(lock_count * 5 + failed_count), 0)::int AS n FROM core.auth_lockouts WHERE user_id = $1`,
      [userId],
    );
    expect(Number(u?.n)).toBe(await countResult(userId, failResult));
  }

  it('S1 — đợt 40 mật khẩu sai + 1 đúng song song: ≤ 5 lần được kiểm, chen ngang ⇒ 429 không đếm, không rò', async () => {
    const m = await enrolledMaster();
    const res = await Promise.all([
      ...Array.from({ length: 40 }, () => http().post('/v1/auth/login').send({ email: m.email, password: 'sai' })),
      http().post('/v1/auth/login').send({ email: m.email, password: m.password }),
    ]);
    expect(await countResult(m.userId, 'BAD_CREDENTIALS')).toBeLessThanOrEqual(5);
    // sai ⇒ 401 chung hoặc 429 (đang xử lý lần khác / hết suất); không có mã lỗi nào khác lộ trạng thái
    expect(res.slice(0, 40).every((r) => [401, 429].includes(r.status))).toBe(true);
    const right = res[40];
    if (right?.status === 200) expect(right.body.status).toBe('MFA_REQUIRED');
    else expect([401, 429]).toContain(right?.status);
    await expectNoLeak(m.userId, 'BAD_CREDENTIALS');
    // sau đợt: chưa khóa ⇒ mật khẩu đúng vào được (không bị khóa vĩnh viễn); đã khóa ⇒ 401
    const u = await lockRow(m.userId);
    const after = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    expect(after.status).toBe(u?.locked ? 401 : 200);
  });

  it('S1 — tài khoản chưa đăng ký 2FA: đợt song song không vượt 5 lần, phiên chỉ cấp khi chưa khóa', async () => {
    const m = await createMaster(db.roleUrl('app_rw'), `burst-${randomBytes(3).toString('hex')}@fruit.test`, {
      mustChangePassword: false,
    });
    const res = await Promise.all([
      ...Array.from({ length: 30 }, () => http().post('/v1/auth/login').send({ email: m.email, password: 'sai' })),
      http().post('/v1/auth/login').send({ email: m.email, password: m.password }),
    ]);
    expect(await countResult(m.userId, 'BAD_CREDENTIALS')).toBeLessThanOrEqual(5);
    const sessions = await rows(`SELECT count(*)::int AS n FROM core.sessions WHERE user_id = $1`, [m.userId]);
    expect(Number(sessions[0]?.n)).toBe(res[30]?.status === 200 ? 1 : 0);
    if (res[30]?.status === 200) expect(res[30].body.status).toBe('ENROLLMENT_REQUIRED');
    await expectNoLeak(m.userId, 'BAD_CREDENTIALS');
  });

  it('S1 — step-up song song: ≤ 5 lần được kiểm (theo PHIÊN); đủ 5 lần sai ⇒ phiên bị thu hồi; 2fa verify song song ≤ 5', async () => {
    const m = await enrolledMaster();
    const t = await fullLogin(m);
    const bearer = `Bearer ${t.access_token}`;
    const su = await Promise.all(
      Array.from({ length: 20 }, () =>
        http().post('/v1/auth/step-up').set('Authorization', bearer).send({ code: '000000' }),
      ),
    );
    const failed = await countResult(m.userId, 'STEP_UP_FAILED');
    const revokedLog = await countResult(m.userId, 'REAUTH_REVOKED');
    expect(failed + revokedLog).toBeLessThanOrEqual(5);
    for (const r of su)
      expect(['OTP_INVALID', 'RATE_LIMITED', 'SESSION_REVOKED', 'AUTHENTICATION_REQUIRED']).toContain(r.body.code);
    // ADR-030: step-up sai KHÔNG khóa đăng nhập của tài khoản
    expect(await lockRow(m.userId)).toBeUndefined();
    // tuần tự trên phiên mới: 4 sai vẫn sống, lần sai thứ 5 ⇒ thu hồi phiên, mã đúng sau đó cũng không qua
    const t2 = await fullLogin(m);
    const b2 = `Bearer ${t2.access_token}`;
    for (let i = 0; i < 4; i++)
      expect((await http().post('/v1/auth/step-up').set('Authorization', b2).send({ code: '000000' })).body.code).toBe(
        'OTP_INVALID',
      );
    const fifth = await http().post('/v1/auth/step-up').set('Authorization', b2).send({ code: '000000' });
    expect([fifth.status, fifth.body.code]).toEqual([401, 'SESSION_REVOKED']);
    const [sess] = await rows(`SELECT revoke_reason FROM core.sessions WHERE id = $1`, [t2.session_id]);
    expect(sess?.revoke_reason).toBe('REAUTH_FAILED');
    await forgetStep(m.userId);
    const after = await http()
      .post('/v1/auth/step-up')
      .set('Authorization', b2)
      .send({ code: await totp(m.userId) });
    expect(after.status).toBe(401);

    const m2 = await enrolledMaster();
    const l = await http().post('/v1/auth/login').send({ email: m2.email, password: m2.password });
    const ch = `Bearer ${l.body.mfa_challenge as string}`;
    await Promise.all(
      Array.from({ length: 30 }, () =>
        http().post('/v1/auth/2fa/verify').set('Authorization', ch).send({ code: '000000' }),
      ),
    );
    expect(await countResult(m2.userId, 'BAD_TOTP')).toBeLessThanOrEqual(5);
    const [c] = await rows(`SELECT attempts FROM core.auth_challenges WHERE user_id = $1`, [m2.userId]);
    expect(Number(c?.attempts)).toBeLessThanOrEqual(5);
    await expectNoLeak(m2.userId, 'BAD_TOTP');
  });

  it('ADR-030 — kẻ ẩn danh sai mật khẩu chỉ khóa nguồn của mình: Master ở mạng khác vẫn vào; phiên đang mở vẫn step-up', async () => {
    const m = await enrolledMaster();
    const t = await fullLogin(m);
    const attacker = '203.0.113.7';
    for (let i = 0; i < 5; i++)
      await http().post('/v1/auth/login').set('X-Forwarded-For', attacker).send({ email: m.email, password: 'sai' });
    // nguồn của kẻ tấn công bị khóa: mật khẩu đúng từ đó cũng 401
    expect(
      (
        await http()
          .post('/v1/auth/login')
          .set('X-Forwarded-For', attacker)
          .send({ email: m.email, password: m.password })
      ).status,
    ).toBe(401);
    // Master ở mạng khác đăng nhập bình thường
    const ok = await http()
      .post('/v1/auth/login')
      .set('X-Forwarded-For', '198.51.100.20')
      .send({ email: m.email, password: m.password });
    expect(ok.body.status).toBe('MFA_REQUIRED');
    // phiên đang mở vẫn xác thực lại được (không bị khóa đăng nhập chặn)
    await forgetStep(m.userId);
    const su = await http()
      .post('/v1/auth/step-up')
      .set('Authorization', `Bearer ${t.access_token}`)
      .send({ code: await totp(m.userId) });
    expect(su.status).toBe(200);
    // IPv6: cùng /64 là một nguồn (xoay địa chỉ trong mạng con không né được khóa)
    for (let i = 0; i < 5; i++)
      await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', `2001:db8:1:2::${i + 1}`)
        .send({ email: m.email, password: 'sai' });
    expect(
      (
        await http()
          .post('/v1/auth/login')
          .set('X-Forwarded-For', '2001:db8:1:2::99')
          .send({ email: m.email, password: m.password })
      ).status,
    ).toBe(401);
    const srcs = await rows(`SELECT source FROM core.auth_lockouts WHERE user_id = $1 AND locked_until > now()`, [
      m.userId,
    ]);
    expect(srcs).toHaveLength(2);
    for (const r of srcs) expect(String(r.source)).toMatch(/^ip:[A-Za-z0-9_-]{22}$/); // không lưu IP thô
  });

  it('review cổng lần 2 (TB-3) — bước 2FA đếm theo TÀI KHOẢN: xoay mạng không mở thêm lượt dò mã TOTP', async () => {
    const m = await enrolledMaster();
    for (let i = 0; i < 5; i++) {
      const ip = `198.51.100.${i + 1}`;
      const l = await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: m.email, password: m.password });
      await http()
        .post('/v1/auth/2fa/verify')
        .set('X-Forwarded-For', ip)
        .set('Authorization', `Bearer ${l.body.mfa_challenge as string}`)
        .send({ code: '000000' });
    }
    const [mfa] = await rows(
      `SELECT (locked_until > now()) IS TRUE AS locked FROM core.auth_lockouts WHERE user_id = $1 AND source = 'mfa'`,
      [m.userId],
    );
    expect(mfa?.locked).toBe(true);
    // mạng thứ 6 có mật khẩu đúng + mã đúng vẫn không qua bước 2FA
    const l6 = await http()
      .post('/v1/auth/login')
      .set('X-Forwarded-For', '198.51.100.99')
      .send({ email: m.email, password: m.password });
    await forgetStep(m.userId);
    const v6 = await http()
      .post('/v1/auth/2fa/verify')
      .set('X-Forwarded-For', '198.51.100.99')
      .set('Authorization', `Bearer ${l6.body.mfa_challenge as string}`)
      .send({ code: await totp(m.userId) });
    expect([v6.status, v6.body.code]).toEqual([403, 'ACCOUNT_LOCKED']);
  });

  it('review cổng lần 3 (TB-1) — nguồn mfa đang khóa (kẻ lộ mật khẩu) mà trình duyệt quen vẫn qua bước 2FA', async () => {
    const dev = `dev-${randomBytes(8).toString('hex')}`;
    const m = await enrolledMaster(dev);
    // kẻ có mật khẩu (trình duyệt lạ) nhập sai mã 2FA 5 lần ⇒ khóa nguồn mfa
    for (let i = 0; i < 5; i++) {
      const l = await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', '203.0.113.66')
        .send({ email: m.email, password: m.password });
      await http()
        .post('/v1/auth/2fa/verify')
        .set('X-Forwarded-For', '203.0.113.66')
        .set('Authorization', `Bearer ${l.body.mfa_challenge as string}`)
        .send({ code: '000000' });
    }
    const [lk] = await rows(
      `SELECT (locked_until > now()) IS TRUE AS locked FROM core.auth_lockouts WHERE user_id = $1 AND source = 'mfa'`,
      [m.userId],
    );
    expect(lk?.locked).toBe(true);
    // Master trên trình duyệt quen vẫn vào trọn vẹn
    await forgetStep(m.userId);
    const t = await fullLogin(m, dev);
    expect(t.access_token).toBeTruthy();
  });

  it('review cổng lần 4 (T-7) — sự kiện an ninh làm trình duyệt cũ hết quen (phiên cũ đã đăng xuất / hết hạn)', async () => {
    const dev = `dev-${randomBytes(8).toString('hex')}`;
    const m = await enrolledMaster(dev);
    const t = await fullLogin(m, dev);
    await http().post('/v1/auth/logout').set('Authorization', `Bearer ${t.access_token}`).send({});
    // đổi mật khẩu = sự kiện an ninh (mô phỏng qua cột mốc — các route đặt mốc có test riêng ở admin-accounts / rbac)
    await rows(`UPDATE core.users SET trust_epoch = now() WHERE id = $1`, [m.userId]);
    await rows(`UPDATE core.users SET fail_window_count = 49, fail_window_start = now() WHERE id = $1`, [m.userId]);
    await http()
      .post('/v1/auth/login')
      .set('X-Forwarded-For', '203.0.113.51')
      .send({ email: m.email, password: 'sai' });
    // trình duyệt cũ (chỉ có phiên TRƯỚC mốc) không còn được miễn khóa toàn tài khoản
    const r = await http()
      .post('/v1/auth/login')
      .set('X-Device-Id', dev)
      .send({ email: m.email, password: m.password });
    expect(r.status).toBe(401);
  });

  it('NC-25 — trình duyệt quen (X-Device-Id của phiên đã qua 2FA) không bị khóa toàn tài khoản; ngân sách 50 lần sai/ngày khóa người lạ', async () => {
    const dev = `dev-${randomBytes(8).toString('hex')}`;
    const m = await enrolledMaster(dev); // phiên đầu đã qua 2FA với X-Device-Id = dev
    // kẻ tấn công: 50 lần sai từ 10 mạng /48 khác nhau ⇒ khóa toàn tài khoản + LOCKED_GLOBAL
    for (let n = 1; n <= 10; n++)
      for (let i = 0; i < 5; i++)
        await http()
          .post('/v1/auth/login')
          .set('X-Forwarded-For', `2001:db8:${n}::1`)
          .send({ email: m.email, password: 'sai' });
    expect(await countResult(m.userId, 'LOCKED_GLOBAL')).toBeGreaterThanOrEqual(1);
    // người lạ ở mạng mới: mật khẩu đúng cũng 401
    expect(
      (
        await http()
          .post('/v1/auth/login')
          .set('X-Forwarded-For', '203.0.113.200')
          .send({ email: m.email, password: m.password })
      ).status,
    ).toBe(401);
    // Master trên trình duyệt quen vẫn vào (không bị khóa toàn tài khoản)
    const ok = await http()
      .post('/v1/auth/login')
      .set('X-Device-Id', dev)
      .set('X-Forwarded-For', '203.0.113.200')
      .send({ email: m.email, password: m.password });
    expect(ok.body.status).toBe('MFA_REQUIRED');
    // X-Device-Id đoán bừa KHÔNG được coi là quen
    const guess = await http()
      .post('/v1/auth/login')
      .set('X-Device-Id', `dev-${randomBytes(8).toString('hex')}`)
      .send({ email: m.email, password: m.password });
    expect(guess.status).toBe(401);
  });

  it('review cổng lần 2 (TB-A) — lần thử của nguồn A đang bận không chặn nguồn B hay step-up của phiên đang mở', async () => {
    const m = await enrolledMaster();
    const t = await fullLogin(m);
    const ipA = '192.0.2.77';
    // giữ cứng khóa độc quyền (tài khoản, nguồn A) — như một lần thử chậm đang chạy
    const hold = new Client({ connectionString: db.ownerUrl });
    await hold.connect();
    try {
      await hold.query('BEGIN');
      await hold.query(`SELECT pg_advisory_xact_lock(hashtextextended('auth:' || $1::uuid::text || ':' || $2, 0))`, [
        m.userId,
        `s:${ipSource(ipA)}`,
      ]);
      const a = await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', ipA)
        .send({ email: m.email, password: m.password });
      expect(a.status).toBe(401); // nguồn A bận ⇒ cùng lỗi chung
      const b = await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', '198.51.100.77')
        .send({ email: m.email, password: m.password });
      expect(b.body.status).toBe('MFA_REQUIRED');
      await forgetStep(m.userId);
      const su = await http()
        .post('/v1/auth/step-up')
        .set('Authorization', `Bearer ${t.access_token}`)
        .send({ code: await totp(m.userId) });
      expect(su.status).toBe(200);
    } finally {
      await hold.query('ROLLBACK').catch(() => undefined);
      await hold.end();
    }
  });

  it('ADR-030 — khóa tăng dần theo nguồn, tự giảm sau 24 giờ; ≥ 10 nguồn bị khóa ⇒ khóa toàn tài khoản 1 giờ', async () => {
    const m = await enrolledMaster();
    const ip = '192.0.2.50';
    const bad = (x = ip) =>
      http().post('/v1/auth/login').set('X-Forwarded-For', x).send({ email: m.email, password: 'sai' });
    for (let i = 0; i < 5; i++) await bad();
    // hết khóa (giả lập) ⇒ 5 lần sai nữa ⇒ khóa gấp đôi
    await rows(`UPDATE core.auth_lockouts SET locked_until = now() - interval '1 second' WHERE user_id = $1`, [
      m.userId,
    ]);
    for (let i = 0; i < 5; i++) await bad();
    const [r2] = await rows(
      `SELECT lock_count, EXTRACT(EPOCH FROM locked_until - now())::int AS left_s FROM core.auth_lockouts WHERE user_id = $1`,
      [m.userId],
    );
    expect(r2?.lock_count).toBe(2);
    expect(Number(r2?.left_s)).toBeGreaterThan(29 * 60);
    // 24 giờ không sai ⇒ lần sai kế tiếp tính lại từ mức 0
    await rows(
      `UPDATE core.auth_lockouts SET locked_until = now() - interval '25 hours', updated_at = now() - interval '26 hours' WHERE user_id = $1`,
      [m.userId],
    );
    await bad();
    const [r3] = await rows(`SELECT failed_count, lock_count FROM core.auth_lockouts WHERE user_id = $1`, [m.userId]);
    expect([r3?.failed_count, r3?.lock_count]).toEqual([1, 0]);
    // tấn công phân tán: 10 nguồn khác nhau cùng bị khóa ⇒ khóa toàn tài khoản (nguồn thứ 11 cũng bị chặn)
    for (let n = 1; n <= 10; n++) for (let i = 0; i < 5; i++) await bad(`198.18.${n}.1`);
    const [u] = await rows(`SELECT (locked_until > now()) IS TRUE AS locked FROM core.users WHERE id = $1`, [m.userId]);
    expect(u?.locked).toBe(true);
    expect(await countResult(m.userId, 'LOCKED_GLOBAL')).toBeGreaterThanOrEqual(1);
    expect(
      (
        await http()
          .post('/v1/auth/login')
          .set('X-Forwarded-For', '198.18.99.1')
          .send({ email: m.email, password: m.password })
      ).status,
    ).toBe(401);
  });

  it('R1 — hàng đợi Argon2 đầy (429) không làm rò bộ đếm; sau bão Master vẫn đăng nhập được', async () => {
    const m = await enrolledMaster();
    // bão: nhiều login email bịa cùng IP (giới hạn suất theo IP) xen lẫn lần thử của nạn nhân
    const storm = Array.from({ length: 60 }, (_, i) =>
      http()
        .post('/v1/auth/login')
        .send({ email: `bia-${i}@fruit.test`, password: 'x' }),
    );
    const victim = Array.from({ length: 8 }, () =>
      http().post('/v1/auth/login').send({ email: m.email, password: 'sai' }),
    );
    const all = await Promise.all([...storm, ...victim]);
    expect(all.some((r) => r.status === 429)).toBe(true);
    await expectNoLeak(m.userId, 'BAD_CREDENTIALS');
    // lần bị 429 cũng có dòng login_logs (nạn nhân có lần bị chen ngang hoặc hết suất)
    const victimBusy = all.slice(60).filter((r) => r.status === 429).length;
    expect(await countResult(m.userId, 'RATE_LIMITED')).toBe(victimBusy);
    const u = await lockRow(m.userId);
    if (!u?.locked) {
      expect(Number(u?.failed_count ?? 0)).toBeLessThan(5);
      await fullLogin(m); // không bị khóa vĩnh viễn
    } else {
      expect(Number(u.left_s)).toBeGreaterThan(0); // khóa CÓ hạn
    }
  });

  it('S2 — setup chạy đua với confirm không ghi đè secret đã bật; confirm thu hồi phiên chỉ-mật-khẩu khác', async () => {
    for (let i = 0; i < 3; i++) {
      const m = await createMaster(db.roleUrl('app_rw'), `race-${i}-${randomBytes(3).toString('hex')}@fruit.test`, {
        mustChangePassword: false,
      });
      const a = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
      const b = await http().post('/v1/auth/login').send({ email: m.email, password: m.password }); // "kẻ biết mật khẩu"
      const ba = `Bearer ${a.body.access_token as string}`;
      const bb = `Bearer ${b.body.access_token as string}`;
      const s1 = await http().post('/v1/auth/2fa/setup').set('Authorization', ba).send({});
      const code = await totp(m.userId);
      const [confirm, setup2] = await Promise.all([
        http().post('/v1/auth/2fa/confirm').set('Authorization', ba).send({ code }),
        new Promise((r) => setTimeout(r, 20 * i)).then(() =>
          http().post('/v1/auth/2fa/setup').set('Authorization', bb).send({}),
        ),
      ]);
      const [u] = await rows(`SELECT totp_secret_enc, totp_enabled_at FROM core.users WHERE id = $1`, [m.userId]);
      const stored = cipher.decrypt(u?.totp_secret_enc as Buffer, totpAad(m.userId)).toString('utf8');
      if (confirm.status === 200) {
        // đã bật ⇒ secret phải là secret mà người confirm đã quét
        expect(u?.totp_enabled_at).not.toBeNull();
        expect(stored).toBe(s1.body.secret);
        expect(setup2.status).toBe(409);
        // phiên chỉ-mật-khẩu của "kẻ biết mật khẩu" bị thu hồi
        const [sb] = await rows(`SELECT revoke_reason FROM core.sessions WHERE id = $1`, [b.body.session_id]);
        expect(sb?.revoke_reason).toBe('TOTP_ENABLED');
      } else {
        // setup thứ hai thắng trước: confirm theo secret cũ thất bại, 2FA chưa bật
        expect(u?.totp_enabled_at).toBeNull();
      }
    }
  });

  it('T6 — sinh lại mã khôi phục hai lần song song: chỉ còn đúng 10 mã, đúng bộ trả về sau cùng', async () => {
    const m = await enrolledMaster();
    const t = await fullLogin(m);
    const b = `Bearer ${t.access_token}`;
    expect(
      (
        await http()
          .post('/v1/auth/step-up')
          .set('Authorization', b)
          .send({ code: await totp(m.userId) })
      ).status,
    ).toBe(200);
    const res = await Promise.all(
      [0, 1].map(() => http().post('/v1/auth/2fa/recovery-codes').set('Authorization', b).send({})),
    );
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    const [n] = await rows(
      `SELECT count(*)::int AS n FROM core.recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
      [m.userId],
    );
    expect(Number(n?.n)).toBe(10);
  });

  it('T1 — login song song: email có thật (bị chen ngang) và email bịa trả cùng 401, không lộ qua 429', async () => {
    const m = await enrolledMaster();
    const real = await Promise.all(
      [0, 1, 2].map(() => http().post('/v1/auth/login').send({ email: m.email, password: 'sai' })),
    );
    const fake = await Promise.all(
      [0, 1, 2].map(() => http().post('/v1/auth/login').send({ email: 'bia-t1@fruit.test', password: 'sai' })),
    );
    expect(real.map((r) => [r.status, r.body.code, r.body.message])).toEqual(
      fake.map((r) => [r.status, r.body.code, r.body.message]),
    );
    expect(real.every((r) => r.status === 401)).toBe(true);
    await expectNoLeak(m.userId, 'BAD_CREDENTIALS');
  });

  it('S5 — response API có Cache-Control: no-store', async () => {
    const r = await http().post('/v1/auth/login').send({ email: 'x@fruit.test', password: 'x' });
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('SEC4 — refresh xoay vòng; dùng lại refresh đã xoay ⇒ thu hồi cả họ (token mới + access token đều chết)', async () => {
    const m = await enrolledMaster();
    const t = await fullLogin(m);
    const r1 = await http().post('/v1/auth/refresh').send({ refresh_token: t.refresh_token });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(t.refresh_token);
    expect(r1.body.session_id).toBe(t.session_id);
    // review cổng CP03 TB5: refresh để lại dấu vết trong login_logs (đúng lẫn sai)
    expect(await countResult(m.userId, 'REFRESH_OK')).toBe(1);
    expect(
      (
        await http()
          .post('/v1/auth/refresh')
          .send({ refresh_token: 'x'.repeat(43) })
      ).status,
    ).toBe(401);
    // token rác (không khớp phiên nào) ⇒ KHÔNG ghi từng dòng (review cổng lần 2 T-4)
    const [rf] = await rows(
      `SELECT count(*)::int AS n FROM audit.login_logs WHERE result = 'REFRESH_FAILED' AND user_id IS NULL`,
    );
    expect(Number(rf?.n)).toBe(0);
    expect((await http().get('/v1/auth/sessions').set('Authorization', `Bearer ${r1.body.access_token}`)).status).toBe(
      200,
    );
    // kẻ trộm dùng lại token cũ
    const reuse = await http().post('/v1/auth/refresh').send({ refresh_token: t.refresh_token });
    expect([reuse.status, reuse.body.code]).toEqual([401, 'SESSION_REVOKED']);
    const [s] = await rows(`SELECT revoked_at, revoke_reason FROM core.sessions WHERE id = $1`, [t.session_id]);
    expect(s?.revoked_at).not.toBeNull();
    expect(s?.revoke_reason).toBe('REFRESH_REUSE');
    expect((await http().post('/v1/auth/refresh').send({ refresh_token: r1.body.refresh_token })).status).toBe(401);
    const acc = await http().get('/v1/auth/sessions').set('Authorization', `Bearer ${r1.body.access_token}`);
    expect([acc.status, acc.body.code]).toEqual([401, 'SESSION_REVOKED']);
    const a = await rows(`SELECT actor_id FROM audit.logs WHERE action = 'auth.refresh_reuse' AND resource_id = $1`, [
      t.session_id,
    ]);
    expect(a).toHaveLength(1);
    expect(a[0]?.actor_id).toBe(m.userId);
    // token rác / sai dạng
    expect(
      (
        await http()
          .post('/v1/auth/refresh')
          .send({ refresh_token: 'x'.repeat(43) })
      ).status,
    ).toBe(401);
    expect((await http().post('/v1/auth/refresh').send({ refresh_token: 'ngắn' })).status).toBe(401);
  });

  it('SEC4 — hai refresh song song cùng một token: một cái qua, cả họ bị thu hồi', async () => {
    const m = await enrolledMaster();
    const t = await fullLogin(m);
    const res = await Promise.all(
      [0, 1].map(() => http().post('/v1/auth/refresh').send({ refresh_token: t.refresh_token })),
    );
    expect(res.map((r) => r.status).sort()).toEqual([200, 401]);
    const [s] = await rows(`SELECT revoke_reason FROM core.sessions WHERE id = $1`, [t.session_id]);
    expect(s?.revoke_reason).toBe('REFRESH_REUSE');
  });

  it('phiên hết hạn trượt 12 giờ / trần 7 ngày ⇒ refresh bị từ chối', async () => {
    const m = await enrolledMaster();
    const t = await fullLogin(m);
    await rows(
      `UPDATE core.sessions SET created_at = now() - interval '8 days', expires_at = now() + interval '1 hour' WHERE id = $1`,
      [t.session_id],
    );
    const r = await http().post('/v1/auth/refresh').send({ refresh_token: t.refresh_token });
    expect([r.status, r.body.code]).toEqual([401, 'SESSION_REVOKED']);
    const now = new Date('2026-11-25T00:00:00Z');
    expect(slidingExpiry(now, now).getTime() - now.getTime()).toBe(ADMIN_SLIDING_S * 1000);
    const old = new Date(now.getTime() - (ADMIN_ABSOLUTE_S - 3600) * 1000);
    expect(slidingExpiry(old, now).getTime()).toBe(old.getTime() + ADMIN_ABSOLUTE_S * 1000);
  });

  it('SEC2 — step-up: thiếu/hết hạn ⇒ STEP_UP_REQUIRED; có step-up ⇒ sinh lại mã khôi phục', async () => {
    const m = await enrolledMaster();
    const t = await fullLogin(m);
    const bearer = `Bearer ${t.access_token}`;
    const no = await http().post('/v1/auth/2fa/recovery-codes').set('Authorization', bearer).send({});
    expect([no.status, no.body.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    const bad = await http().post('/v1/auth/step-up').set('Authorization', bearer).send({ code: '000000' });
    expect([bad.status, bad.body.code]).toEqual([401, 'OTP_INVALID']);
    const su = await http()
      .post('/v1/auth/step-up')
      .set('Authorization', bearer)
      .send({ code: await totp(m.userId) });
    expect(su.status).toBe(200);
    const left = (new Date(su.body.step_up_until as string).getTime() - Date.now()) / 1000;
    expect(left).toBeGreaterThan(280);
    expect(left).toBeLessThanOrEqual(300);
    const ok = await http().post('/v1/auth/2fa/recovery-codes').set('Authorization', bearer).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.recovery_codes).toHaveLength(10);
    // mã khôi phục cũ hết hiệu lực
    const [n] = await rows(`SELECT count(*)::int AS n FROM core.recovery_codes WHERE user_id = $1`, [m.userId]);
    expect(n?.n).toBe(10);
    // hết hạn step-up (server đọc DB, không tin claim trong token)
    await rows(`UPDATE core.sessions SET step_up_until = now() - interval '1 second' WHERE id = $1`, [t.session_id]);
    const exp = await http()
      .post('/v1/auth/2fa/recovery-codes')
      .set('Authorization', `Bearer ${su.body.access_token as string}`)
      .send({});
    expect([exp.status, exp.body.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    // ADR-030: step-up đếm theo phiên; lần đúng đã xóa bộ đếm của phiên
    const [u] = await rows(`SELECT reauth_failed_count FROM core.sessions WHERE id = $1`, [t.session_id]);
    expect(u?.reauth_failed_count).toBe(0);
  });

  it('mã khôi phục: đăng nhập được một lần, mã đã dùng bị từ chối', async () => {
    const m = await enrolledMaster();
    const code = m.recovery[0]?.toUpperCase(); // không phân biệt hoa/thường
    const l = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    const r = await http()
      .post('/v1/auth/2fa/recover')
      .set('Authorization', `Bearer ${l.body.mfa_challenge as string}`)
      .send({ recovery_code: code });
    expect(r.status).toBe(200);
    expect(r.body.amr).toEqual(['pwd', 'rcv']);
    expect(r.body.recovery_codes_remaining).toBe(9);
    const l2 = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    const again = await http()
      .post('/v1/auth/2fa/recover')
      .set('Authorization', `Bearer ${l2.body.mfa_challenge as string}`)
      .send({ recovery_code: code });
    expect([again.status, again.body.code]).toEqual([401, 'OTP_INVALID']);
    const a = await rows(
      `SELECT actor_id FROM audit.logs WHERE action = 'auth.recovery_code_use' AND resource_id = $1`,
      [m.userId],
    );
    expect(a.map((x) => x.actor_id)).toEqual([m.userId]);
    expect(normalizeRecoveryCode(' AbCd-EfGh ')).toBe('abcdefgh');
  });

  it('logout / thu hồi phiên: access token chết ngay; không thu hồi được phiên người khác (404)', async () => {
    const m = await enrolledMaster();
    const a = await fullLogin(m);
    const b = await fullLogin(m);
    const other = await enrolledMaster();
    const o = await fullLogin(other);
    const list = await http().get('/v1/auth/sessions').set('Authorization', `Bearer ${a.access_token}`);
    expect(list.body.items.map((s: { id: string }) => s.id)).toContain(b.session_id);
    expect(list.body.items.find((s: { current: boolean }) => s.current).id).toBe(a.session_id);
    const notMine = await http()
      .delete(`/v1/auth/sessions/${o.session_id}`)
      .set('Authorization', `Bearer ${a.access_token}`);
    expect(notMine.status).toBe(404);
    expect(
      (await http().delete(`/v1/auth/sessions/${b.session_id}`).set('Authorization', `Bearer ${a.access_token}`))
        .status,
    ).toBe(204);
    expect((await http().get('/v1/auth/sessions').set('Authorization', `Bearer ${b.access_token}`)).body.code).toBe(
      'SESSION_REVOKED',
    );
    expect(
      (await http().post('/v1/auth/logout').set('Authorization', `Bearer ${a.access_token}`).send({})).status,
    ).toBe(200);
    expect((await http().get('/v1/auth/sessions').set('Authorization', `Bearer ${a.access_token}`)).status).toBe(401);
    expect((await http().get('/v1/auth/sessions').set('Authorization', `Bearer ${o.access_token}`)).status).toBe(200);
    const acts = await rows(`SELECT action FROM audit.logs WHERE actor_id = $1 AND action LIKE 'auth.%'`, [m.userId]);
    expect(acts.map((x) => x.action).sort()).toEqual([
      'auth.logout',
      'auth.session_revoke',
      'auth.totp_enable',
      'auth.totp_setup',
    ]);
  });

  it('tài khoản bị Master khóa ⇒ login 401 chung, phiên đang có mất hiệu lực; STAFF không đăng nhập qua /auth/login', async () => {
    const m = await enrolledMaster();
    const t = await fullLogin(m);
    await rows(`UPDATE core.users SET status = 'LOCKED' WHERE id = $1`, [m.userId]);
    const r = await http().get('/v1/auth/sessions').set('Authorization', `Bearer ${t.access_token}`);
    expect([r.status, r.body.code]).toEqual([401, 'SESSION_REVOKED']);
    const l = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    expect([l.status, l.body.code]).toEqual([401, 'AUTHENTICATION_REQUIRED']);
    expect(await countResult(m.userId, 'LOCKED')).toBeGreaterThanOrEqual(1);
    expect((await http().post('/v1/auth/refresh').send({ refresh_token: t.refresh_token })).status).toBe(401);
    // STAFF có email + mật khẩu (dữ liệu bất thường) vẫn không vào được luồng admin
    const sid = (await rows(`SELECT gen_random_uuid() AS id`))[0]?.id as string;
    await rows(`INSERT INTO core.users (id, type, email, password_hash) VALUES ($1, 'STAFF', 'staff@fruit.test', $2)`, [
      sid,
      await hashSecret('mat-khau-staff'),
    ]);
    const s = await http().post('/v1/auth/login').send({ email: 'staff@fruit.test', password: 'mat-khau-staff' });
    expect(s.status).toBe(401);
  });

  it('SEC5 — đăng nhập từ thiết bị mới ⇒ sự kiện auth.new_device_login (thiết bị cũ thì không)', async () => {
    const m = await enrolledMaster('dev-quen-thuoc-01');
    const t1 = await fullLogin(m, 'dev-quen-thuoc-01');
    const t2 = await fullLogin(m, 'dev-quen-thuoc-01');
    const t3 = await fullLogin(m, 'dev-la-hoan-toan-02');
    const ev = await rows(
      `SELECT payload, payload->>'session_id' AS sid FROM integration.outbox WHERE event_type = 'auth.new_device_login' AND aggregate_id = $1`,
      [m.userId],
    );
    // kích hoạt 2FA trên thiết bị A = lần đầu ⇒ sự kiện; đăng nhập lại trên A ⇒ không; thiết bị B ⇒ sự kiện
    expect(ev.map((e) => e.sid).sort()).toEqual([m.enrollSession, t3.session_id].sort());
    expect(ev.map((e) => e.sid)).not.toContain(t1.session_id);
    expect(ev.map((e) => e.sid)).not.toContain(t2.session_id);
    for (const e of ev) expect(eventPayloadErrors('auth.new_device_login', e.payload)).toEqual([]);
  });

  it('JWT: chữ ký sai / kid lạ / alg none / token hết hạn ⇒ 401', async () => {
    const m = await enrolledMaster();
    const t = await fullLogin(m);
    const [h, p, sig] = t.access_token.split('.') as [string, string, string];
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: randomBytes(16).toString('hex') })).toString('base64url')}.${sig}`;
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'at+jwt', kid: 'k1' })).toString('base64url')}.${p}.`;
    // token ký bằng khóa khác cùng kid
    const foreign = new AccessTokens(
      loadAuthKeys(loadEnv({ ...envBase(), ...testAuthEnv(), JWT_SIGNING_KEYS: newJwtKey('k1') })),
    );
    const f = await foreign.sign({ sub: m.userId, typ: 'master', sid: t.session_id, amr: ['pwd', 'otp'] });
    for (const tok of [tampered, none, f.token, 'abc.def.ghi', `${h}.${p}`]) {
      const r = await http().get('/v1/auth/sessions').set('Authorization', `Bearer ${tok}`);
      expect({ tok: tok.slice(0, 12), status: r.status }).toEqual({ tok: tok.slice(0, 12), status: 401 });
    }
    expect((await http().get('/v1/auth/sessions').set('Authorization', `Basic ${t.access_token}`)).status).toBe(401);
  });

  it('xoay khóa JWT: khóa cũ còn trong danh sách vẫn kiểm được; bỏ khóa cũ ⇒ token cũ hết hiệu lực', async () => {
    const k1 = newJwtKey('k1');
    const k2 = newJwtKey('k2');
    const old = new AccessTokens(loadAuthKeys(loadEnv({ ...envBase(), ...testAuthEnv(), JWT_SIGNING_KEYS: k1 })));
    const both = new AccessTokens(
      loadAuthKeys(loadEnv({ ...envBase(), ...testAuthEnv(), JWT_SIGNING_KEYS: `${k1},${k2}` })),
    );
    const onlyNew = new AccessTokens(loadAuthKeys(loadEnv({ ...envBase(), ...testAuthEnv(), JWT_SIGNING_KEYS: k2 })));
    const claims = { sub: 'u', typ: 'master' as const, sid: 's', amr: ['pwd' as const] };
    const t1 = (await old.sign(claims)).token;
    const t2 = (await both.sign(claims)).token;
    expect(JSON.parse(Buffer.from(t2.split('.')[0] ?? '', 'base64url').toString()).kid).toBe('k2'); // khóa cuối ký
    expect(await both.verify(t1)).toEqual({ sub: 'u', sid: 's' });
    expect(await onlyNew.verify(t2)).toEqual({ sub: 'u', sid: 's' });
    expect(await onlyNew.verify(t1)).toBeUndefined();
    // hết hạn
    const expired = (await old.sign(claims, new Date(Date.now() - 16 * 60 * 1000))).token;
    expect(await old.verify(expired)).toBeUndefined();
  });

  it('cấu hình khóa thiếu/sai ⇒ không khởi động (không có khóa mặc định)', () => {
    const base = { ...envBase(), ...testAuthEnv() };
    expect(() => loadAuthKeys(loadEnv({ ...base, JWT_SIGNING_KEYS: '' }))).toThrow(/JWT_SIGNING_KEYS/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' });
    expect(() => loadAuthKeys(loadEnv({ ...base, JWT_SIGNING_KEYS: `k:${rsa.toString('base64')}` }))).toThrow(
      /Ed25519/,
    );
    expect(() => loadAuthKeys(loadEnv({ ...base, PII_ENC_KEYS: `1:${randomBytes(16).toString('base64')}` }))).toThrow(
      /32 byte/,
    );
    expect(() => loadAuthKeys(loadEnv({ ...base, PII_HASH_PEPPER: randomBytes(8).toString('base64') }))).toThrow(
      /32 byte/,
    );
    expect(() => loadAuthKeys(loadEnv({ ...base, PII_ENC_KEYS: undefined }))).toThrow(/PII_ENC_KEYS/);
    // lỗi không chứa giá trị khóa
    try {
      loadAuthKeys(loadEnv({ ...base, JWT_SIGNING_KEYS: 'k1:QUJDRA==' }));
    } catch (e) {
      expect(String(e)).not.toContain('QUJDRA');
    }
    // khóa PII: khóa ghi là id lớn nhất; dữ liệu mã hóa bằng khóa cũ vẫn giải được khi còn cấu hình
    const k1 = `1:${randomBytes(32).toString('base64')}`;
    const k2 = `2:${randomBytes(32).toString('base64')}`;
    const c1 = new PiiCipher(loadAuthKeys(loadEnv({ ...base, PII_ENC_KEYS: k1 })));
    const c12 = new PiiCipher(loadAuthKeys(loadEnv({ ...base, PII_ENC_KEYS: `${k2},${k1}` })));
    const blob = c1.encrypt('bi-mat', 'users:totp_secret_enc:x');
    expect(c12.decrypt(blob, 'users:totp_secret_enc:x').toString()).toBe('bi-mat');
    expect(Buffer.from(c12.encrypt('y', 'a')).readUInt16BE(1)).toBe(2);
  });

  it('response của mọi route auth khớp schema OpenAPI (hợp đồng)', async () => {
    const check = (name: string, body: unknown) =>
      expect({ name, errors: schemaErrors(name, body) }).toEqual({ name, errors: [] });
    expect(schemaErrors('AuthTokenPair', {}).length).toBeGreaterThan(0); // bộ kiểm không rỗng
    const m = await createMaster(db.roleUrl('app_rw'), 'contract@fruit.test', { mustChangePassword: false });
    const l = await http()
      .post('/v1/auth/login')
      .set('X-Device-Id', 'dev-contract-01')
      .send({ email: m.email, password: m.password });
    check('AuthLoginResponse', l.body);
    const b = `Bearer ${l.body.access_token as string}`;
    const s1 = await http().post('/v1/auth/2fa/setup').set('Authorization', b).send({});
    check('AuthTotpSetupResponse', s1.body);
    const c = await http()
      .post('/v1/auth/2fa/confirm')
      .set('Authorization', b)
      .send({ code: await totp(m.userId) });
    check('AuthTotpConfirmResponse', c.body);
    await forgetStep(m.userId);
    const l2 = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    check('AuthLoginResponse', l2.body);
    const v = await http()
      .post('/v1/auth/2fa/verify')
      .set('Authorization', `Bearer ${l2.body.mfa_challenge as string}`)
      .send({ code: await totp(m.userId) });
    check('AuthTokenPair', v.body);
    await forgetStep(m.userId);
    const r = await http().post('/v1/auth/refresh').send({ refresh_token: v.body.refresh_token });
    check('AuthTokenPair', r.body);
    const bb = `Bearer ${r.body.access_token as string}`;
    const su = await http()
      .post('/v1/auth/step-up')
      .set('Authorization', bb)
      .send({ code: await totp(m.userId) });
    check('AuthStepUpResponse', su.body);
    const rc = await http().post('/v1/auth/2fa/recovery-codes').set('Authorization', bb).send({});
    check('AuthRecoveryCodesResponse', rc.body);
    check('AuthSessionList', (await http().get('/v1/auth/sessions').set('Authorization', bb)).body);
    const l3 = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    const rv = await http()
      .post('/v1/auth/2fa/recover')
      .set('Authorization', `Bearer ${l3.body.mfa_challenge as string}`)
      .send({ recovery_code: (rc.body.recovery_codes as string[])[3] });
    check('AuthRecoverResponse', rv.body);
    check('OkResponse', (await http().post('/v1/auth/logout').set('Authorization', bb).send({})).body);
    const e = await http().post('/v1/auth/logout').set('Authorization', bb).send({});
    check('Error', e.body);
    // thân lạ bị từ chối (strict)
    expect((await http().post('/v1/auth/login').send({ email: m.email, password: 'x', extra: 1 })).status).toBe(400);
  });

  it('Argon2id: PHC đúng tham số; hash hỏng/tham số vô lý ⇒ false (không ném)', async () => {
    const h = await hashSecret('mat-khau-dai-du');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(await verifySecret(h, 'mat-khau-dai-du')).toBe(true);
    expect(await verifySecret(h, 'mat-khau-sai')).toBe(false);
    expect(await verifySecret('rac', 'x')).toBe(false);
    expect(await verifySecret(h.replace('m=65536', 'm=99999999'), 'mat-khau-dai-du')).toBe(false);
    expect(await verifySecret(h, 'x'.repeat(300))).toBe(false);
    const c = await hashSecret('abcd', ARGON_PROFILES.CODE);
    expect(c).toMatch(/m=19456,t=2,p=1/);
  });
});

function envBase(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL_APP: 'postgresql://u:p@127.0.0.1:1/none',
    REDIS_URL: 'redis://127.0.0.1:1',
    LOG_LEVEL: 'silent',
  };
}
