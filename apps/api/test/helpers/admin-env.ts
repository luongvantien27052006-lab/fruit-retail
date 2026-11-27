import type { INestApplication } from '@nestjs/common';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { generateSync } from 'otplib';
import request from 'supertest';
import { expect } from 'vitest';
import { loadAuthKeys } from '../../src/auth/auth-config';
import {
  enrollmentCodeHash,
  newEnrollmentCode,
  normalizeEnrollmentCode,
  proofMessage,
} from '../../src/auth/device-proof';
import { ARGON_PROFILES, hashSecret } from '../../src/auth/password';
import { PiiCipher, totpAad } from '../../src/auth/pii-cipher';
import { createApp } from '../../src/bootstrap';
import { createMaster } from '../../src/cli/create-master';
import { loadEnv } from '../../src/config/env';
import { testAuthEnv } from './auth-env';
import { type MigratedDb, startMigratedDb } from './db';
import { relaxedRatePolicies } from './rate-limit';

export type Http = ReturnType<typeof request>;
export interface Client {
  get(u: string): request.Test;
  post(u: string, b: object): request.Test;
  put(u: string, b: object): request.Test;
  patch(u: string, b: object): request.Test;
}

export interface AdminEnv {
  db: MigratedDb;
  app: INestApplication;
  http: () => Http;
  /** Master đã qua 2FA (chưa step-up) */
  master: Client;
  masterId: string;
  /** Master step-up còn hạn (5 phút) */
  masterStepUp(): Promise<Client>;
  /** cửa hàng trưởng đăng nhập PIN trên máy POS đã kích hoạt của một cửa hàng mới */
  storeManager(): Promise<Client & { storeId: string }>;
  hex(n?: number): string;
  close(): Promise<void>;
}

/** Postgres + Redis thật, app đầy đủ, một Master đã đăng ký 2FA — dùng chung cho test API quản trị (CP04+). */
export async function startAdminEnv(): Promise<AdminEnv> {
  const [db, redis]: [MigratedDb, StartedRedisContainer] = await Promise.all([
    startMigratedDb(),
    new RedisContainer('redis:7.4-alpine').start(),
  ]);
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL_APP: db.roleUrl('app_rw'),
    DATABASE_URL_VIEWER: db.roleUrl('viewer_ro'),
    REDIS_URL: redis.getConnectionUrl(),
    PORT: '0',
    LOG_LEVEL: 'silent',
    ...testAuthEnv(db.roleUrl('audit_writer')),
  });
  const cipher = new PiiCipher(loadAuthKeys(env));
  const app = await createApp(env, { logger: false }, { providers: [relaxedRatePolicies] });
  await app.init();
  const http = () => request(app.getHttpServer());
  const hex = (n = 3) => randomBytes(n).toString('hex').toUpperCase();
  const bearerClient = (bearer: string, deviceId?: string): Client => {
    const h = <T extends request.Test>(t: T) => {
      t.set('Authorization', bearer);
      if (deviceId) t.set('X-Device-Id', deviceId);
      return t;
    };
    return {
      get: (u) => h(http().get(`/v1${u}`)),
      post: (u, b) => h(http().post(`/v1${u}`)).send(b),
      put: (u, b) => h(http().put(`/v1${u}`)).send(b),
      patch: (u, b) => h(http().patch(`/v1${u}`)).send(b),
    };
  };
  const totp = async (userId: string) => {
    const [u] = await db.q(`SELECT totp_secret_enc FROM core.users WHERE id = $1`, [userId]);
    return generateSync({ secret: cipher.decrypt(u?.totp_secret_enc as Buffer, totpAad(userId)).toString('utf8') });
  };

  const m = await createMaster(db.roleUrl('app_rw'), `m-${hex().toLowerCase()}@fruit.test`, {
    mustChangePassword: false,
  });
  const l = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
  const b0 = `Bearer ${l.body.access_token as string}`;
  await http().post('/v1/auth/2fa/setup').set('Authorization', b0).send({});
  const c = await http()
    .post('/v1/auth/2fa/confirm')
    .set('Authorization', b0)
    .send({ code: await totp(m.userId) });
  expect(c.status).toBe(200);
  const masterBearer = `Bearer ${c.body.access_token as string}`;
  const master = bearerClient(masterBearer);

  async function masterStepUp(): Promise<Client> {
    // mã TOTP cùng bước 30 giây bị chặn dùng lại (ADR-021) ⇒ test (owner) xóa mốc bước đã dùng
    await db.q(`UPDATE core.users SET totp_last_step = NULL WHERE id = $1`, [m.userId]);
    const r = await http()
      .post('/v1/auth/step-up')
      .set('Authorization', masterBearer)
      .send({ code: await totp(m.userId) });
    expect(r.status).toBe(200);
    return bearerClient(`Bearer ${r.body.access_token as string}`);
  }

  async function storeManager() {
    const storeId = randomUUID();
    const sc = `S${hex()}`;
    await db.q(`INSERT INTO core.stores (id, code, name) VALUES ($1, $2, $2)`, [storeId, sc]);
    const userId = randomUUID();
    const code = `NV${hex()}`;
    const pin = '246813';
    await db.q(`INSERT INTO core.users (id, type, pin_hash) VALUES ($1, 'STAFF', $2)`, [
      userId,
      await hashSecret(pin, ARGON_PROFILES.PASSWORD),
    ]);
    await db.q(`INSERT INTO core.staff (user_id, staff_code, full_name) VALUES ($1, $2, $2)`, [userId, code]);
    await db.q(
      `INSERT INTO core.user_role_assignments (id, user_id, role, scope_type, scope_id) VALUES ($1, $2, 'STORE_MANAGER', 'STORE', $3)`,
      [randomUUID(), userId, storeId],
    );
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const id = randomUUID();
    const pub = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
    const proof = (purpose: 'register' | 'pin', binding: string) => {
      const ts = Math.floor(Date.now() / 1000);
      const nonce = randomBytes(16).toString('base64url');
      return {
        ts,
        nonce,
        signature: sign(null, proofMessage(purpose, id, ts, nonce, binding), privateKey).toString('base64url'),
      };
    };
    const enroll = newEnrollmentCode();
    await db.q(
      `INSERT INTO core.pos_enrollment_codes (id, store_id, code_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '30 minutes')`,
      [randomUUID(), storeId, Buffer.from(enrollmentCodeHash(enroll)), m.userId],
    );
    const reg = await http()
      .post('/v1/auth/devices/register')
      .set('X-Device-Id', id)
      .send({
        enrollment_code: enroll,
        name: 'Quầy',
        platform: 'windows',
        public_key: pub,
        device_proof: proof('register', `${normalizeEnrollmentCode(enroll)}\n${pub}`),
      });
    expect(reg.status).toBe(201);
    const act = await master.post(`/admin/pos-devices/${id}/activate`, {
      pairing_code: reg.body.pairing_code as string,
    });
    expect(act.status).toBe(200);
    const pl = await http()
      .post('/v1/auth/pin')
      .set('X-Device-Id', id)
      .send({ staff_code: code, pin, device_proof: proof('pin', code) });
    expect(pl.status).toBe(200);
    return { ...bearerClient(`Bearer ${pl.body.access_token as string}`, id), storeId };
  }

  return {
    db,
    app,
    http,
    master,
    masterId: m.userId,
    masterStepUp,
    storeManager,
    hex,
    close: async () => {
      await app.close();
      await Promise.allSettled([db.pg.stop(), redis.stop()]);
    },
  };
}
