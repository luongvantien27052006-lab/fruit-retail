import type { INestApplication } from '@nestjs/common';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAuthKeys } from '../src/auth/auth-config';
import { normalizeVnPhone, OTP_SEND_LIMITS, phoneAad, phoneHash } from '../src/auth/customer-auth.service';
import { createOtpProvider, OTP_PROVIDER, type TestDoubleOtpProvider } from '../src/auth/otp-provider';
import { PiiCipher } from '../src/auth/pii-cipher';
import { CUSTOMER_SESSION_S } from '../src/auth/tokens';
import { createApp } from '../src/bootstrap';
import { DEFAULT_RATE_POLICIES } from '../src/common/rate-limit';
import { type Env, loadEnv } from '../src/config/env';
import { ipBucket } from '../src/infra/rate-limiter.service';
import { testAuthEnv } from './helpers/auth-env';
import { schemaErrors } from './helpers/contract';
import { type MigratedDb, startMigratedDb } from './helpers/db';

// CP03 lát 5 — khách SĐT + OTP (SEC6, ADR-012, ADR-023) và giới hạn tần suất Redis, trên PostgreSQL + Redis thật với
// NGƯỠNG THẬT. Mỗi test dùng IP riêng qua X-Forwarded-For (app tin proxy loopback) để giới hạn theo IP không lẫn nhau.

describe('auth khách OTP + giới hạn tần suất (CP03 lát 5)', () => {
  let db: MigratedDb;
  let redis: StartedRedisContainer;
  let app: INestApplication;
  let env: Env;
  let cipher: PiiCipher;
  let otp: TestDoubleOtpProvider;
  const http = () => request(app.getHttpServer());
  const rows = (sql: string, p: unknown[] = []) => db.q(sql, p);

  let ipSeq = 1;
  const newIp = () => `203.0.113.${ipSeq++}`;
  let phoneSeq = 0;
  /** SĐT thử duy nhất mỗi lần gọi (đầu số 09) */
  const newPhone = () => `09${String(10_000_000 + (Date.now() % 1_000_000) * 10 + phoneSeq++).slice(-8)}`;
  const newDevice = () => `cust-${randomUUID()}`;

  interface Who {
    ip: string;
    device: string;
  }
  const who = (): Who => ({ ip: newIp(), device: newDevice() });
  const otpRequest = (phone: string, w: Who) =>
    http().post('/v1/auth/otp/request').set('X-Forwarded-For', w.ip).set('X-Device-Id', w.device).send({ phone });
  const otpVerify = (phone: string, code: string, w: Who) =>
    http().post('/v1/auth/otp/verify').set('X-Forwarded-For', w.ip).set('X-Device-Id', w.device).send({ phone, code });
  const lastCode = (phone: string) => otp.last(normalizeVnPhone(phone) ?? '')?.code ?? '';
  const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

  async function login(phone: string, w = who()) {
    expect((await otpRequest(phone, w)).status).toBe(200);
    const r = await otpVerify(phone, lastCode(phone), w);
    expect(r.status).toBe(200);
    return r;
  }

  beforeAll(async () => {
    [db, redis] = await Promise.all([startMigratedDb(), new RedisContainer('redis:7.4-alpine').start()]);
    env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL_APP: db.roleUrl('app_rw'),
      REDIS_URL: redis.getConnectionUrl(),
      PORT: '0',
      LOG_LEVEL: 'silent',
      OTP_PROVIDER: 'TEST_DOUBLE',
      ...testAuthEnv(db.roleUrl('audit_writer')),
    });
    cipher = new PiiCipher(loadAuthKeys(env));
    app = await createApp(env, { logger: false }); // chính sách giới hạn mặc định (ngưỡng thật)
    await app.init();
    otp = app.get(OTP_PROVIDER);
  });
  afterAll(async () => {
    await app?.close();
    await Promise.allSettled([db?.pg.stop(), redis?.stop()]);
  });

  // ───────── luồng chính ─────────

  it('SĐT + OTP ⇒ tạo tài khoản khách lần đầu, lần sau cùng tài khoản; SĐT chỉ lưu mã hóa + HMAC', async () => {
    const phone = newPhone();
    const w = who();
    const r1 = await otpRequest(phone, w);
    expect(r1.status, JSON.stringify(r1.body) + phone).toBe(200);
    expect(schemaErrors('AuthOtpRequestResponse', r1.body)).toEqual([]);
    expect(r1.body.resend_after_s).toBe(60);
    const code = lastCode(phone);
    expect(code).toMatch(/^\d{6}$/);
    const v = await otpVerify(phone, code, w);
    expect(v.status).toBe(200);
    expect(schemaErrors('AuthOtpVerifyResponse', v.body)).toEqual([]);
    expect(v.body.customer.is_new).toBe(true);
    expect(v.body.amr).toEqual(['otp']);
    const uid = v.body.customer.user_id as string;

    const e164 = normalizeVnPhone(phone) ?? '';
    const [u] = await rows(`SELECT type, phone_enc, phone_hash, status FROM core.users WHERE id = $1`, [uid]);
    expect(u?.type).toBe('CUSTOMER');
    expect(Buffer.from(u?.phone_hash as Buffer).equals(Buffer.from(phoneHash(cipher, e164)))).toBe(true);
    expect(cipher.decrypt(u?.phone_enc as Buffer, phoneAad(uid)).toString()).toBe(e164);
    expect((u?.phone_enc as Buffer).includes(Buffer.from(e164.slice(3)))).toBe(false);
    const [role] = await rows(`SELECT role, scope_type FROM core.user_role_assignments WHERE user_id = $1`, [uid]);
    expect(role).toEqual({ role: 'CUSTOMER', scope_type: 'ALL' });
    const [sess] = await rows(
      `SELECT user_type, amr, pos_device_id, extract(epoch FROM expires_at - created_at)::int AS ttl
       FROM core.sessions WHERE id = $1`,
      [v.body.session_id],
    );
    expect(sess).toMatchObject({ user_type: 'CUSTOMER', amr: ['otp'], pos_device_id: null });
    expect(sess?.ttl).toBe(CUSTOMER_SESSION_S);
    // mã OTP không lưu rõ; SĐT không nằm rõ trong login_logs / otp_challenges
    const [ch] = await rows(`SELECT code_hash, consumed_at FROM core.otp_challenges WHERE phone_hash = $1`, [
      Buffer.from(phoneHash(cipher, e164)),
    ]);
    expect(ch?.code_hash).not.toContain(code);
    expect(ch?.consumed_at).not.toBeNull();
    const logs = await rows(
      `SELECT result, identifier_hash FROM audit.login_logs WHERE identifier_hash = $1 ORDER BY at`,
      [Buffer.from(phoneHash(cipher, e164))],
    );
    expect(logs.map((x) => x.result)).toEqual(['OTP_SENT', 'SUCCESS']);
    const audits = await rows(`SELECT action, actor_type FROM audit.logs WHERE resource_id = $1`, [uid]);
    expect(audits).toEqual([{ action: 'customer.register', actor_type: 'CUSTOMER' }]);

    // token khách dùng được; quyền customer:self
    const me = await http()
      .get('/v1/auth/sessions')
      .set('Authorization', `Bearer ${v.body.access_token as string}`);
    expect(me.status).toBe(200);
    // lần sau (SĐT viết dạng khác) ⇒ cùng tài khoản, is_new = false, không audit thêm
    const alt = `+84 ${phone.slice(1, 4)} ${phone.slice(4)}`;
    // SĐT khác dạng là CÙNG SĐT ⇒ bị giới hạn 1 lần/60 giây; xóa bộ đếm thay vì chờ
    const w2 = who();
    await redis.exec(['redis-cli', 'FLUSHDB']);
    const v2 = await login(alt, w2);
    expect(v2.body.customer).toEqual({ user_id: uid, is_new: false });
    expect(await rows(`SELECT 1 FROM audit.logs WHERE resource_id = $1`, [uid])).toHaveLength(1);
  });

  it('sai mã ⇒ 401 OTP_INVALID; 5 lần sai ⇒ mã đúng cũng bị từ chối; mã đã dùng / mã cũ bị thay / hết hạn ⇒ 401', async () => {
    const phone = newPhone();
    const w = who();
    await otpRequest(phone, w);
    const code = lastCode(phone);
    for (let i = 0; i < 5; i++) {
      const r = await otpVerify(phone, wrong(code), w);
      expect([r.status, r.body.code]).toEqual([401, 'OTP_INVALID']);
    }
    expect((await otpVerify(phone, code, w)).status).toBe(401);
    const [c] = await rows(`SELECT attempts FROM core.otp_challenges WHERE phone_hash = $1`, [
      Buffer.from(phoneHash(cipher, normalizeVnPhone(phone) ?? '')),
    ]);
    expect(c?.attempts).toBe(5);

    // mã dùng rồi không dùng lại được
    const p2 = newPhone();
    const ok = await login(p2, w);
    expect(ok.status).toBe(200);
    const again = await otpVerify(p2, lastCode(p2), w);
    expect([again.status, again.body.code]).toEqual([401, 'OTP_INVALID']);

    // mã cũ bị thay bởi mã mới
    const p3 = newPhone();
    await otpRequest(p3, w);
    const old = lastCode(p3);
    await rows(
      `UPDATE core.otp_challenges SET created_at = created_at - interval '2 minutes',
                expires_at = expires_at - interval '2 minutes' WHERE phone_hash = $1`,
      [Buffer.from(phoneHash(cipher, normalizeVnPhone(p3) ?? ''))],
    );
    await redis.exec(['redis-cli', 'DEL', ...(await redisKeys('rl:otp.send.phone:60:*'))]);
    expect((await otpRequest(p3, w)).status).toBe(200);
    const fresh = lastCode(p3);
    if (fresh !== old) expect((await otpVerify(p3, old, w)).status).toBe(401);
    expect(
      await rows(`SELECT count(*)::int AS n FROM core.otp_challenges WHERE phone_hash = $1`, [
        Buffer.from(phoneHash(cipher, normalizeVnPhone(p3) ?? '')),
      ]),
    ).toEqual([{ n: 1 }]);

    // hết hạn
    await rows(
      `UPDATE core.otp_challenges SET created_at = now() - interval '6 minutes', expires_at = now() - interval '1 minute'
                WHERE phone_hash = $1`,
      [Buffer.from(phoneHash(cipher, normalizeVnPhone(p3) ?? ''))],
    );
    expect((await otpVerify(p3, fresh, w)).status).toBe(401);
  });

  it('xác minh song song cùng mã đúng ⇒ đúng một phiên, một tài khoản, không 500', async () => {
    const phone = newPhone();
    const w = who();
    await otpRequest(phone, w);
    const code = lastCode(phone);
    const res = await Promise.all(
      Array.from({ length: 5 }, () => otpVerify(phone, code, { ...w, device: newDevice() })),
    );
    expect(res.map((r) => r.status).sort()).toEqual([200, 401, 401, 401, 401]);
    const e = Buffer.from(phoneHash(cipher, normalizeVnPhone(phone) ?? ''));
    expect(await rows(`SELECT count(*)::int AS n FROM core.users WHERE phone_hash = $1`, [e])).toEqual([{ n: 1 }]);
  });

  it('SĐT sai định dạng / thiếu X-Device-Id ⇒ 400; SĐT của tài khoản nội bộ ⇒ 403 sau khi xác minh', async () => {
    const w = who();
    for (const bad of ['0123456789', '091234567', '+1 415 555 0100', '09123456789'])
      expect((await otpRequest(bad, w)).status).toBe(400);
    const noDev = await http().post('/v1/auth/otp/request').set('X-Forwarded-For', w.ip).send({ phone: newPhone() });
    expect(noDev.status).toBe(400);
    expect(normalizeVnPhone('0912.345.678')).toBe('+84912345678');
    expect(normalizeVnPhone('84 912 345 678')).toBe('+84912345678');

    const phone = newPhone();
    const sid = randomUUID();
    await rows(`INSERT INTO core.users (id, type, phone_hash, phone_enc, pin_hash) VALUES ($1, 'STAFF', $2, $3, 'x')`, [
      sid,
      Buffer.from(phoneHash(cipher, normalizeVnPhone(phone) ?? '')),
      Buffer.from(cipher.encrypt(normalizeVnPhone(phone) ?? '', phoneAad(sid))),
    ]);
    await otpRequest(phone, w);
    const r = await otpVerify(phone, lastCode(phone), w);
    expect([r.status, r.body.code]).toEqual([403, 'ACTION_FORBIDDEN']);
    expect(await rows(`SELECT 1 FROM core.sessions WHERE user_id = $1`, [sid])).toEqual([]);
  });

  // ───────── giới hạn gửi / nhập sai ─────────

  it('giới hạn gửi: cùng SĐT trong 60 giây ⇒ 429 OTP_RATE_LIMITED (retry_after_s); thiết bị 5/giờ; IP 20/giờ', async () => {
    const phone = newPhone();
    const w = who();
    expect((await otpRequest(phone, w)).status).toBe(200);
    const again = await otpRequest(phone, who());
    expect([again.status, again.body.code]).toEqual([429, 'OTP_RATE_LIMITED']);
    expect(again.body.details.retry_after_s).toBeGreaterThan(0);
    expect(again.body.details.retry_after_s).toBeLessThanOrEqual(60);
    expect(otp.count(normalizeVnPhone(phone) ?? '')).toBe(1);

    // thiết bị: 5 SĐT khác nhau / giờ (mỗi lần IP khác)
    const dev = newDevice();
    const byDev = [];
    for (let i = 0; i < OTP_SEND_LIMITS.device[0].max + 1; i++)
      byDev.push((await otpRequest(newPhone(), { ip: newIp(), device: dev })).status);
    expect(byDev).toEqual([200, 200, 200, 200, 200, 429]);

    // IP: 20 / giờ (SĐT + thiết bị khác nhau)
    const ip = newIp();
    const byIp = [];
    for (let i = 0; i < OTP_SEND_LIMITS.ip[0].max + 1; i++)
      byIp.push((await otpRequest(newPhone(), { ip, device: newDevice() })).status);
    expect(byIp.filter((s) => s === 200)).toHaveLength(20);
    expect(byIp.at(-1)).toBe(429);
    // lần bị từ chối không ăn suất của khóa khác: SĐT bị từ chối ở trên vẫn gửi được từ IP khác
  });

  it('nhập sai 10 lần/giờ theo SĐT (cộng dồn qua các mã) ⇒ 429, kể cả mã đúng; không gửi được thêm lượt thử', async () => {
    const phone = newPhone();
    const w = who();
    await otpRequest(phone, w);
    const code = lastCode(phone);
    const st: number[] = [];
    for (let i = 0; i < 10; i++) st.push((await otpVerify(phone, wrong(code), { ...w, device: newDevice() })).status);
    expect(st.every((s) => s === 401)).toBe(true);
    const blocked = await otpVerify(phone, code, w);
    expect([blocked.status, blocked.body.code]).toEqual([429, 'OTP_RATE_LIMITED']);
    const logs = await rows(`SELECT result FROM audit.login_logs WHERE identifier_hash = $1`, [
      Buffer.from(phoneHash(cipher, normalizeVnPhone(phone) ?? '')),
    ]);
    // lần bị 429 không ghi nhật ký (không tạo dòng log vô hạn từ request chưa xác thực)
    expect(logs.filter((x) => x.result === 'BAD_OTP')).toHaveLength(10);
    expect(logs.some((x) => x.result === 'RATE_LIMITED')).toBe(false);
  });

  // ───────── refresh phiên khách ─────────

  it('refresh khách: xoay vòng, KHÔNG gia hạn (60 ngày tuyệt đối); dùng lại refresh cũ ⇒ thu hồi cả họ', async () => {
    const v = await login(newPhone());
    const rt = v.body.refresh_token as string;
    const [before] = await rows(`SELECT expires_at FROM core.sessions WHERE id = $1`, [v.body.session_id]);
    const r1 = await http().post('/v1/auth/refresh').send({ refresh_token: rt });
    expect(r1.status).toBe(200);
    expect(r1.body.amr).toEqual(['otp']);
    const [after] = await rows(`SELECT expires_at FROM core.sessions WHERE id = $1`, [v.body.session_id]);
    expect((after?.expires_at as Date).getTime()).toBe((before?.expires_at as Date).getTime());
    const reuse = await http().post('/v1/auth/refresh').send({ refresh_token: rt });
    expect([reuse.status, reuse.body.code]).toEqual([401, 'SESSION_REVOKED']);
    const [s] = await rows(`SELECT revoke_reason FROM core.sessions WHERE id = $1`, [v.body.session_id]);
    expect(s?.revoke_reason).toBe('REFRESH_REUSE');
    // phiên hết hạn ⇒ refresh bị từ chối
    const v2 = await login(newPhone());
    await rows(`ALTER TABLE core.sessions DISABLE TRIGGER sessions_guard`);
    await rows(
      `UPDATE core.sessions SET created_at = now() - interval '61 days', expires_at = now() - interval '1 day' WHERE id = $1`,
      [v2.body.session_id],
    );
    await rows(`ALTER TABLE core.sessions ENABLE TRIGGER sessions_guard`);
    const late = await http().post('/v1/auth/refresh').send({ refresh_token: v2.body.refresh_token });
    expect([late.status, late.body.code]).toEqual([401, 'SESSION_REVOKED']);
  });

  // ───────── giới hạn theo nguồn cho route xác thực cũ (lát 3/4 hoãn sang) ─────────

  it('login: quá 30 lần/phút/IP ⇒ 429 trước khi chạm DB (không thêm login_logs); IPv6 gộp theo /64', async () => {
    const ip = newIp();
    const max = DEFAULT_RATE_POLICIES['auth.login']?.[0]?.max ?? 0;
    const email = `x-${randomBytes(4).toString('hex')}@fruit.test`;
    const st: number[] = [];
    for (let i = 0; i < max + 2; i++)
      st.push((await http().post('/v1/auth/login').set('X-Forwarded-For', ip).send({ email, password: 'sai' })).status);
    expect(st.slice(0, max).every((s) => s === 401)).toBe(true);
    expect(st.slice(max)).toEqual([429, 429]);
    const [n] = await rows(`SELECT count(*)::int AS n FROM audit.login_logs WHERE ip = $1::inet`, [ip]);
    expect(n?.n).toBe(max);

    expect(ipBucket('2001:db8:1:2:aaaa::1')).toBe(ipBucket('2001:0db8:0001:0002:ffff:1:2:3'));
    expect(ipBucket('2001:db8:1:2::1')).not.toBe(ipBucket('2001:db8:1:3::1'));
    expect(ipBucket('::ffff:10.0.0.1')).toBe(ipBucket('10.0.0.1'));
    // qua HTTP: hai địa chỉ cùng /64 dùng chung bộ đếm
    const a = '2001:db8:aa:bb::1';
    const b = '2001:db8:aa:bb:ffff::9';
    for (let i = 0; i < max; i++)
      await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', i % 2 ? a : b)
        .send({ email, password: 'sai' });
    expect(
      (await http().post('/v1/auth/login').set('X-Forwarded-For', b).send({ email, password: 'sai' })).status,
    ).toBe(429);
  });

  // ───────── cấu hình nhà cung cấp / Redis lỗi ─────────

  it('production không có nhà cung cấp OTP thật ⇒ không khởi động; TEST_DOUBLE / SMS chưa hiện thực ⇒ từ chối', async () => {
    const base = { ...env };
    expect(() => createOtpProvider({ ...base, NODE_ENV: 'production', OTP_PROVIDER: undefined })).toThrow(
      /OTP_PROVIDER/,
    );
    expect(() => createOtpProvider({ ...base, NODE_ENV: 'production', OTP_PROVIDER: 'TEST_DOUBLE' })).toThrow(/cấm/);
    expect(() => createOtpProvider({ ...base, NODE_ENV: 'staging', OTP_PROVIDER: 'SMS_BRANDNAME' })).toThrow(/CP14/);
    expect(createOtpProvider({ ...base, NODE_ENV: 'development', OTP_PROVIDER: undefined })).toBeNull();
    expect(createOtpProvider({ ...base, NODE_ENV: 'staging', OTP_PROVIDER: 'TEST_DOUBLE' })?.kind).toBe('TEST_DOUBLE');
    await expect(
      createApp(
        { ...base, NODE_ENV: 'production', OTP_PROVIDER: 'TEST_DOUBLE' },
        { logger: false, abortOnError: false },
      ),
    ).rejects.toThrow(/TEST_DOUBLE/);
  });

  it('chưa cấu hình OTP ⇒ 503 CONFIGURATION_NOT_READY; Redis lỗi ⇒ gửi OTP 503, đăng nhập vẫn chạy (khóa DB)', async () => {
    const noOtp = await createApp({ ...env, OTP_PROVIDER: undefined }, { logger: false });
    await noOtp.init();
    try {
      const r = await request(noOtp.getHttpServer())
        .post('/v1/auth/otp/request')
        .set('X-Device-Id', newDevice())
        .send({ phone: newPhone() });
      expect([r.status, r.body.code]).toEqual([503, 'CONFIGURATION_NOT_READY']);
    } finally {
      await noOtp.close();
    }
    const down = await createApp({ ...env, REDIS_URL: 'redis://127.0.0.1:1' }, { logger: false });
    await down.init();
    try {
      const r = await request(down.getHttpServer())
        .post('/v1/auth/otp/request')
        .set('X-Device-Id', newDevice())
        .send({ phone: newPhone() });
      expect([r.status, r.body.code]).toEqual([503, 'DEPENDENCY_UNAVAILABLE']);
      const l = await request(down.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: 'khong-co@fruit.test', password: 'sai' });
      expect(l.status).toBe(401);
    } finally {
      await down.close();
    }
  });

  async function redisKeys(pattern: string): Promise<string[]> {
    const r = await redis.exec(['redis-cli', '--raw', 'KEYS', pattern]);
    const keys = r.output
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
    return keys.length ? keys : ['__none__'];
  }
});
