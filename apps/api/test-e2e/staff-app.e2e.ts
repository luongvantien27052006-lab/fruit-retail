import type { INestApplication } from '@nestjs/common';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateSync } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAuthKeys } from '../src/auth/auth-config';
import { enrollmentCodeHash, newEnrollmentCode } from '../src/auth/device-proof';
import { ARGON_PROFILES, hashSecret } from '../src/auth/password';
import { PiiCipher, totpAad } from '../src/auth/pii-cipher';
import { createApp } from '../src/bootstrap';
import { createMaster } from '../src/cli/create-master';
import { loadEnv } from '../src/config/env';
import { testAuthEnv } from '../test/helpers/auth-env';
import { type MigratedDb, startMigratedDb } from '../test/helpers/db';
import { relaxedRatePolicies } from '../test/helpers/rate-limit';

// CP03 lát 9 — staff app Flutter chạy THẬT trên Windows (flutter test integration_test -d windows) với API local:
// đăng ký máy bằng mã ghi danh → Master kích hoạt bằng mã ghép đọc từ màn hình máy → PIN → refresh kèm chữ ký thiết bị
// → khóa màn hình (thu hồi phiên). Chạy: pnpm --filter @fruit/api test:e2e -- staff-app (chỉ trên Windows có Flutter).

const run = process.platform === 'win32' && process.env['SKIP_FLUTTER_E2E'] !== '1';

describe.runIf(run)('staff app Windows thật ↔ API (CP03 lát 9)', () => {
  let db: MigratedDb;
  let redis: StartedRedisContainer;
  let app: INestApplication;
  let cipher: PiiCipher;
  let master = '';
  let masterId = '';
  let coord = '';
  const hex = (n = 3) => randomBytes(n).toString('hex').toUpperCase();
  const http = () => request(app.getHttpServer());

  async function totp(userId: string): Promise<string> {
    await db.q(`UPDATE core.users SET totp_last_step = NULL WHERE id = $1`, [userId]);
    const [u] = await db.q(`SELECT totp_secret_enc FROM core.users WHERE id = $1`, [userId]);
    return generateSync({ secret: cipher.decrypt(u?.totp_secret_enc as Buffer, totpAad(userId)).toString('utf8') });
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
    await app.listen(0, '127.0.0.1');
    const m = await createMaster(db.roleUrl('app_rw'), `sa-${hex().toLowerCase()}@fruit.test`, {
      mustChangePassword: false,
    });
    masterId = m.userId;
    const l = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    const b0 = `Bearer ${l.body.access_token as string}`;
    await http().post('/v1/auth/2fa/setup').set('Authorization', b0).send({});
    const cf = await http()
      .post('/v1/auth/2fa/confirm')
      .set('Authorization', b0)
      .send({ code: await totp(m.userId) });
    const su = await http()
      .post('/v1/auth/step-up')
      .set('Authorization', `Bearer ${cf.body.access_token as string}`)
      .send({ code: await totp(m.userId) });
    expect(su.status).toBe(200);
    master = `Bearer ${su.body.access_token as string}`;
    coord = mkdtempSync(join(tmpdir(), 'frtest-staffapp-'));
  });

  afterAll(async () => {
    await app?.close();
    await Promise.allSettled([db?.pg.stop(), redis?.stop()]);
    if (coord) rmSync(coord, { recursive: true, force: true });
  });

  it('đăng ký → kích hoạt → PIN → refresh chữ ký → khóa màn hình', async () => {
    const storeId = randomUUID();
    await db.q(`INSERT INTO core.stores (id, code, name) VALUES ($1, $2, $2)`, [storeId, `S${hex()}`]);
    const enroll = newEnrollmentCode();
    await db.q(
      `INSERT INTO core.pos_enrollment_codes (id, store_id, code_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '30 minutes')`,
      [randomUUID(), storeId, Buffer.from(enrollmentCodeHash(enroll)), masterId],
    );
    const staffId = randomUUID();
    const staffCode = `NV${hex()}`;
    const pin = '246813';
    await db.q(`INSERT INTO core.users (id, type, pin_hash) VALUES ($1, 'STAFF', $2)`, [
      staffId,
      await hashSecret(pin, ARGON_PROFILES.PASSWORD),
    ]);
    await db.q(`INSERT INTO core.staff (user_id, staff_code, full_name) VALUES ($1, $2, 'Thu Ngân E2E')`, [
      staffId,
      staffCode,
    ]);
    await db.q(
      `INSERT INTO core.user_role_assignments (id, user_id, role, scope_type, scope_id) VALUES ($1, $2, 'CASHIER', 'STORE', $3)`,
      [randomUUID(), staffId, storeId],
    );

    const apiPort = (app.getHttpServer().address() as AddressInfo).port;
    const dir = resolve(process.cwd(), '../staff_app');
    // shell (flutter.bat) cần quote từng tham số — không để dấu cách/ký tự đặc biệt trong đường dẫn làm hỏng dòng lệnh
    const q = (a: string) => `"${a.replace(/"/g, '')}"`;
    const flutter = spawn(
      'flutter',
      [
        'test',
        'integration_test/live_api_test.dart',
        '-d',
        'windows',
        `--dart-define=API_BASE_URL=http://127.0.0.1:${apiPort}`,
        `--dart-define=COORD_DIR=${coord}`,
        `--dart-define=ENROLL_CODE=${enroll}`,
        `--dart-define=STAFF_CODE=${staffCode}`,
        `--dart-define=STAFF_PIN=${pin}`,
      ].map(q),
      { cwd: dir, shell: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // luôn dọn cây tiến trình flutter + app Windows, kể cả khi test ném lỗi giữa chừng
    const killTree = () => {
      if (flutter.exitCode === null && flutter.pid) spawn('taskkill', ['/T', '/F', '/PID', String(flutter.pid)]);
    };
    try {
      let out = '';
      flutter.stdout.on('data', (d: Buffer) => (out += d.toString()));
      flutter.stderr.on('data', (d: Buffer) => (out += d.toString()));
      const exited = new Promise<number>((ok) => flutter.on('exit', (c) => ok(c ?? 1)));

      // vai Master: chờ máy hiện mã ghép rồi kích hoạt bằng mã đó (đọc "từ màn hình" qua file điều phối)
      const pairingFile = join(coord, 'pairing.txt');
      const end = Date.now() + 8 * 60_000; // lần đầu build Windows có thể lâu
      while (!existsSync(pairingFile)) {
        if (Date.now() > end || flutter.exitCode !== null)
          throw new Error(`app chưa tới bước mã ghép:\n${out.slice(-4000)}`);
        await new Promise((r) => setTimeout(r, 500));
      }
      const [deviceId, pairing] = readFileSync(pairingFile, 'utf8').split('\n');
      const [pend] = await db.q(`SELECT status, platform, store_id FROM core.pos_devices WHERE id = $1`, [deviceId]);
      expect(pend).toMatchObject({ status: 'PENDING', platform: 'windows', store_id: storeId });
      const a = await http()
        .post(`/v1/admin/pos-devices/${deviceId}/activate`)
        .set('Authorization', master)
        .send({ pairing_code: pairing });
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      writeFileSync(join(coord, 'activated.txt'), 'ok');

      const code = await exited;
      expect(code, out.slice(-6000)).toBe(0);
      expect(existsSync(join(coord, 'done.txt'))).toBe(true);

      const sessions = await db.q(
        `SELECT revoked_at, revoke_reason, pos_device_id FROM core.sessions WHERE user_id = $1`,
        [staffId],
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.pos_device_id).toBe(deviceId);
      expect(sessions[0]?.revoke_reason).toBe('LOGOUT'); // khóa màn hình ⇒ thu hồi phiên ở server
      const [rt] = await db.q(
        `SELECT count(*)::int AS n FROM core.refresh_tokens r JOIN core.sessions s ON s.id = r.session_id WHERE s.user_id = $1`,
        [staffId],
      );
      expect(rt?.n).toBe(2); // token đầu + một lần xoay (refresh có chữ ký thiết bị thành công, không dùng lại)
      const reuse = await db.q(`SELECT 1 FROM audit.login_logs WHERE user_id = $1 AND result = 'REFRESH_REUSE'`, [
        staffId,
      ]);
      expect(reuse).toHaveLength(0);
    } finally {
      killTree();
    }
  }, 600_000);
});
