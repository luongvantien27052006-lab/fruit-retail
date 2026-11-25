import type { INestApplication } from '@nestjs/common';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAuthKeys } from '../src/auth/auth-config';
import { OTP_PROVIDER, type TestDoubleOtpProvider } from '../src/auth/otp-provider';
import { PiiCipher, totpAad } from '../src/auth/pii-cipher';
import { createApp } from '../src/bootstrap';
import { createMaster } from '../src/cli/create-master';
import { type Env, loadEnv } from '../src/config/env';
import { MAX_PENDING_PER_USER } from '../src/files/files.service';
import { generateSync } from 'otplib';
import { testAuthEnv } from './helpers/auth-env';
import { schemaErrors } from './helpers/contract';
import { type MigratedDb, startMigratedDb } from './helpers/db';
import { relaxedRatePolicies } from './helpers/rate-limit';

// CP03 lát 7 — file: presign → PUT → complete (server tự tính sha256) → tải về 60 giây (ADR-014, ADR-025) trên
// PostgreSQL + Redis + S3 thật (SeaweedFS — cùng image với diễn tập backup CP02).

const BUCKET = 'fruit-files-test';

describe('file presign / complete / download (CP03 lát 7)', () => {
  let db: MigratedDb;
  let redis: StartedRedisContainer;
  let s3: StartedTestContainer;
  let app: INestApplication;
  let env: Env;
  let cipher: PiiCipher;
  const http = () => request(app.getHttpServer());
  const rows = (sql: string, p: unknown[] = []) => db.q(sql, p);
  let phoneSeq = 0;

  const jpeg = (n = 2048) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(n - 4)]);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  async function customer(): Promise<string> {
    const phone = `09${String(31_000_000 + phoneSeq++).padStart(8, '0')}`;
    const dev = `files-${randomBytes(6).toString('hex')}`;
    await http().post('/v1/auth/otp/request').set('X-Device-Id', dev).send({ phone });
    const otp = app.get<TestDoubleOtpProvider>(OTP_PROVIDER);
    const code = otp.last(`+84${phone.slice(1)}`)?.code ?? '';
    const v = await http().post('/v1/auth/otp/verify').set('X-Device-Id', dev).send({ phone, code });
    expect(v.status).toBe(200);
    return `Bearer ${v.body.access_token as string}`;
  }
  async function master(): Promise<string> {
    const m = await createMaster(db.roleUrl('app_rw'), `m-${randomBytes(3).toString('hex')}@fruit.test`);
    const l = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    const b = `Bearer ${l.body.access_token as string}`;
    await http().post('/v1/auth/2fa/setup').set('Authorization', b).send({});
    const [u] = await rows(`SELECT totp_secret_enc FROM core.users WHERE id = $1`, [m.userId]);
    const secret = cipher.decrypt(u?.totp_secret_enc as Buffer, totpAad(m.userId)).toString('utf8');
    const c = await http()
      .post('/v1/auth/2fa/confirm')
      .set('Authorization', b)
      .send({ code: generateSync({ secret }) });
    return `Bearer ${c.body.access_token as string}`;
  }
  const presign = (bearer: string, body: object) =>
    http().post('/v1/files/presign').set('Authorization', bearer).send(body);
  const put = (url: string, mime: string, data: Buffer) =>
    fetch(url, { method: 'PUT', headers: { 'Content-Type': mime }, body: data });
  async function upload(bearer: string, data: Buffer, over: Record<string, unknown> = {}) {
    const p = await presign(bearer, {
      kind: 'PHOTO_COMPLAINT',
      mime: 'image/jpeg',
      bytes: data.length,
      sha256: sha(data),
      capture_source: 'GALLERY',
      ...over,
    });
    expect(p.status).toBe(200);
    const r = await put(p.body.upload_url as string, String(over.mime ?? 'image/jpeg'), data);
    return { id: p.body.id as string, presign: p, put: r };
  }
  const complete = (bearer: string, id: string) =>
    http().post(`/v1/files/${id}/complete`).set('Authorization', bearer).send({});

  beforeAll(async () => {
    const ak = randomBytes(10).toString('hex');
    const sk = randomBytes(20).toString('hex');
    const cfg = JSON.stringify({
      identities: [
        { name: 'app', credentials: [{ accessKey: ak, secretKey: sk }], actions: ['Admin', 'Read', 'Write', 'List'] },
      ],
    });
    [db, redis, s3] = await Promise.all([
      startMigratedDb(),
      new RedisContainer('redis:7.4-alpine').start(),
      new GenericContainer('chrislusf/seaweedfs:3.97')
        .withEntrypoint(['sh', '-c'])
        .withCommand([
          `printf '%s' '${cfg}' > /etc/s3.json && exec weed server -dir=/data -s3 -s3.port=8333 -s3.config=/etc/s3.json -master.volumeSizeLimitMB=64 -volume.max=20`,
        ])
        .withExposedPorts(8333)
        .start(),
    ]);
    for (let i = 0; i < 60; i++) {
      await s3.exec(['sh', '-c', `echo "s3.bucket.create -name ${BUCKET}" | weed shell -master=localhost:9333`]);
      const l = await s3.exec(['sh', '-c', 'echo "s3.bucket.list" | weed shell -master=localhost:9333']);
      if (l.output.includes(BUCKET)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const endpoint = `http://${s3.getHost()}:${s3.getMappedPort(8333)}`;
    env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL_APP: db.roleUrl('app_rw'),
      REDIS_URL: redis.getConnectionUrl(),
      PORT: '0',
      LOG_LEVEL: 'silent',
      OTP_PROVIDER: 'TEST_DOUBLE',
      S3_ENDPOINT: endpoint,
      S3_BUCKET: BUCKET,
      S3_ACCESS_KEY: ak,
      S3_SECRET_KEY: sk,
      ...testAuthEnv(db.roleUrl('audit_writer')),
    });
    cipher = new PiiCipher(loadAuthKeys(env));
    app = await createApp(env, { logger: false }, { providers: [relaxedRatePolicies] });
    await app.init();
  }, 180_000);
  afterAll(async () => {
    await app?.close();
    await Promise.allSettled([db?.pg.stop(), redis?.stop(), s3?.stop()]);
  });

  it('presign kiểm loại / định dạng / kích thước / nguồn chụp; thiếu đăng nhập ⇒ 401', async () => {
    const c = await customer();
    const ok = {
      kind: 'PHOTO_COMPLAINT',
      mime: 'image/jpeg',
      bytes: 100,
      sha256: sha(Buffer.from('x')),
      capture_source: 'GALLERY',
    };
    for (const bad of [
      { ...ok, kind: 'REPORT' },
      { ...ok, mime: 'image/png' },
      { ...ok, bytes: 5 * 1024 * 1024 + 1 },
      { ...ok, sha256: 'ABC' },
    ])
      expect((await presign(c, bad)).status).toBe(400);
    const r = await presign(c, ok);
    expect(r.status).toBe(200);
    expect(schemaErrors('FilePresignResponse', r.body)).toEqual([]);
    expect((await http().post('/v1/files/presign').send(ok)).status).toBe(401);
    // TB1: khách chỉ tải ảnh khiếu nại; ảnh nghiệp vụ nội bộ ⇒ 403
    for (const kind of ['PHOTO_SPOILAGE', 'PHOTO_WEIGHT', 'PHOTO_RECEIPT', 'PHOTO_PRODUCT'])
      expect((await presign(c, { ...ok, kind, capture_source: 'CAMERA' })).status).toBe(403);
    // ảnh hủy hàng chỉ chụp trực tiếp (Master/nhân viên)
    const m = await master();
    expect((await presign(m, { ...ok, kind: 'PHOTO_SPOILAGE', capture_source: 'GALLERY' })).status).toBe(400);
    expect((await presign(m, { ...ok, kind: 'PHOTO_SPOILAGE', capture_source: 'CAMERA' })).status).toBe(200);
  });

  it('C1 — PUT lại sau khi READY (URL còn hạn) ⇒ nội dung tải về vẫn là bản ĐÃ KIỂM; khóa tải lên đã bị xóa', async () => {
    const c = await customer();
    const a = jpeg(1500);
    const u = await upload(c, a);
    expect((await complete(c, u.id)).body.status).toBe('READY');
    const b = jpeg(1500); // ảnh khác, cùng kích thước, cùng Content-Type ⇒ chữ ký PUT vẫn đúng
    expect((await put(u.presign.body.upload_url as string, 'image/jpeg', b)).ok).toBe(true);
    const dl = await http().get(`/v1/files/${u.id}/download-url`).set('Authorization', c);
    const got = Buffer.from(await (await fetch(dl.body.url as string)).arrayBuffer());
    expect(got.equals(a)).toBe(true);
    expect(got.equals(b)).toBe(false);
  });

  it('cấu hình S3 thiếu một phần ⇒ không khởi động (không âm thầm tắt tính năng file)', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL_APP: 'postgresql://u:p@127.0.0.1:1/x',
        REDIS_URL: 'redis://127.0.0.1:1',
        S3_ENDPOINT: 'http://127.0.0.1:1',
        S3_BUCKET: 'b-test',
        S3_ACCESS_KEY: 'k',
      }),
    ).toThrow(/S3_SECRET_KEY/);
  });

  it('tải lên đúng ⇒ READY (server tự tính sha256); tải về qua presigned GET ra đúng byte; audit', async () => {
    const c = await customer();
    const data = jpeg(4096);
    const u = await upload(c, data);
    expect(u.put.status).toBe(200);
    const done = await complete(c, u.id);
    expect(done.status).toBe(200);
    expect(schemaErrors('FileCompleteResponse', done.body)).toEqual([]);
    expect(done.body).toMatchObject({
      status: 'READY',
      bytes: 4096,
      sha256: sha(data),
      duplicate_of_id: null,
      warnings: [],
    });
    const dl = await http().get(`/v1/files/${u.id}/download-url`).set('Authorization', c);
    expect(dl.status).toBe(200);
    expect(schemaErrors('FileDownloadUrlResponse', dl.body)).toEqual([]);
    const got = Buffer.from(await (await fetch(dl.body.url as string)).arrayBuffer());
    expect(got.equals(data)).toBe(true);
    const audits = await rows(`SELECT action FROM audit.logs WHERE resource_id = $1 ORDER BY at`, [u.id]);
    expect(audits.map((a) => a.action)).toEqual(['file.presign', 'file.complete']);
    // complete lần 2 ⇒ 409
    expect((await complete(c, u.id)).status).toBe(409);
  });

  it('sha256 sai / định dạng thật khác khai báo / chưa PUT / quá hạn ⇒ REJECTED hoặc 409; object bị từ chối bị xóa', async () => {
    const c = await customer();
    const data = jpeg();
    const wrongSha = await upload(c, data, { sha256: sha(Buffer.from('khác')) });
    const r1 = await complete(c, wrongSha.id);
    expect(r1.body).toMatchObject({ status: 'REJECTED', reject_reason: 'SHA256_MISMATCH' });
    expect((await http().get(`/v1/files/${wrongSha.id}/download-url`).set('Authorization', c)).status).toBe(409);

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(500)]);
    const fake = await upload(c, png); // khai image/jpeg, sha đúng, nội dung PNG
    expect((await complete(c, fake.id)).body).toMatchObject({
      status: 'REJECTED',
      reject_reason: 'CONTENT_TYPE_MISMATCH',
    });

    const p = await presign(c, {
      kind: 'PHOTO_COMPLAINT',
      mime: 'image/jpeg',
      bytes: 10,
      sha256: sha(jpeg(10)),
      capture_source: 'GALLERY',
    });
    expect((await complete(c, p.body.id as string)).status).toBe(409); // chưa PUT

    const old = await upload(c, jpeg());
    await rows(`UPDATE core.files SET created_at = now() - interval '2 hours' WHERE id = $1`, [old.id]);
    expect((await complete(c, old.id)).body).toMatchObject({ status: 'REJECTED', reject_reason: 'EXPIRED' });
  });

  it('PUT khác kích thước / khác Content-Type đã ký ⇒ S3 từ chối; ghi đè byte khác cùng kích thước ⇒ REJECTED', async () => {
    const c = await customer();
    const data = jpeg(1000);
    const p = await presign(c, {
      kind: 'PHOTO_COMPLAINT',
      mime: 'image/jpeg',
      bytes: 1000,
      sha256: sha(data),
      capture_source: 'GALLERY',
    });
    const url = p.body.upload_url as string;
    expect((await put(url, 'image/jpeg', jpeg(2000))).ok).toBe(false);
    expect((await put(url, 'image/webp', data)).ok).toBe(false);
    expect((await put(url, 'image/jpeg', jpeg(1000))).ok).toBe(true); // cùng cỡ, khác nội dung
    expect((await complete(c, p.body.id as string)).body.reject_reason).toBe('SHA256_MISMATCH');
  });

  it('ảnh dùng lại (trùng sha256 với file đã nhận) ⇒ READY kèm duplicate_of_id + cảnh báo (FR-INV-16)', async () => {
    const a = await customer();
    const b = await customer();
    const data = jpeg(3000);
    const first = await upload(a, data);
    expect((await complete(a, first.id)).body.status).toBe('READY');
    const again = await upload(b, data);
    const r = await complete(b, again.id);
    expect(r.body).toMatchObject({ status: 'READY', duplicate_of_id: first.id, warnings: ['DUPLICATE_CONTENT'] });
  });

  it('người khác không complete / tải được (404); Master tải được; trần file PENDING mỗi người ⇒ 429', async () => {
    const a = await customer();
    const b = await customer();
    const u = await upload(a, jpeg());
    expect((await complete(b, u.id)).status).toBe(404);
    expect((await complete(a, u.id)).body.status).toBe('READY');
    expect((await http().get(`/v1/files/${u.id}/download-url`).set('Authorization', b)).status).toBe(404);
    expect(
      (
        await http()
          .get(`/v1/files/${u.id}/download-url`)
          .set('Authorization', await master())
      ).status,
    ).toBe(200);

    const c = await customer();
    const body = {
      kind: 'PHOTO_COMPLAINT',
      mime: 'image/jpeg',
      bytes: 10,
      sha256: sha(jpeg(10)),
      capture_source: 'GALLERY',
    };
    const st = await Promise.all(Array.from({ length: MAX_PENDING_PER_USER + 3 }, () => presign(c, body)));
    expect(st.filter((x) => x.status === 200)).toHaveLength(MAX_PENDING_PER_USER);
    expect(st.filter((x) => x.status === 429)).toHaveLength(3);
  });

  it('chưa cấu hình S3 ⇒ 503 CONFIGURATION_NOT_READY', async () => {
    const no = await createApp(
      { ...env, S3_ENDPOINT: undefined, S3_BUCKET: undefined },
      { logger: false },
      { providers: [relaxedRatePolicies] },
    );
    await no.init();
    try {
      const prev = app;
      app = no;
      const c = await customer();
      app = prev;
      const r = await request(no.getHttpServer())
        .post('/v1/files/presign')
        .set('Authorization', c)
        .send({
          kind: 'PHOTO_COMPLAINT',
          mime: 'image/jpeg',
          bytes: 10,
          sha256: sha(jpeg(10)),
          capture_source: 'GALLERY',
        });
      expect([r.status, r.body.code]).toEqual([503, 'CONFIGURATION_NOT_READY']);
    } finally {
      await no.close();
    }
  });
});
