import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';

// Test chạy trên PostgreSQL + Redis THẬT (Testcontainers) — không mock (fruit-engineering.md).
describe('GET /v1/health', () => {
  let pg: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let app: INestApplication;

  beforeAll(async () => {
    [pg, redis] = await Promise.all([
      new PostgreSqlContainer('postgis/postgis:17-3.5').start(),
      new RedisContainer('redis:7.4-alpine').start(),
    ]);
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL_APP: pg.getConnectionUri(),
      REDIS_URL: redis.getConnectionUrl(),
      PORT: '0',
      LOG_LEVEL: 'silent',
    });
    app = await createApp(env, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await Promise.allSettled([pg?.stop(), redis?.stop()]);
  });

  it('200 khi DB và Redis sống', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', checks: { db: 'ok', redis: 'ok' } });
  });

  it('nhiều request đồng thời lúc vừa khởi động đều 200 (không connect Redis chồng nhau)', async () => {
    const res = await Promise.all(Array.from({ length: 8 }, () => request(app.getHttpServer()).get('/v1/health')));
    expect(res.map((r) => r.status)).toEqual(Array(8).fill(200));
  });

  it('503 DEPENDENCY_UNAVAILABLE khi Redis chết; request_id lấy đúng X-Request-Id hợp lệ', async () => {
    await redis.stop();
    const res = await request(app.getHttpServer()).get('/v1/health').set('X-Request-Id', 'req-abc-12345');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(res.body.details.checks).toEqual({ db: 'ok', redis: 'down' });
    expect(res.body.request_id).toBe('req-abc-12345');
  });

  it('X-Request-Id sai dạng bị thay bằng UUID mới', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health').set('X-Request-Id', 'bad id <script>');
    expect(res.body.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('503 khi DB cũng chết (cả hai down), trả trong thời gian giới hạn', async () => {
    await pg.stop();
    const t0 = Date.now();
    const res = await request(app.getHttpServer()).get('/v1/health');
    expect(res.status).toBe(503);
    expect(res.body.details.checks).toEqual({ db: 'down', redis: 'down' });
    expect(Date.now() - t0).toBeLessThan(6_000);
  });
});

describe('loadEnv', () => {
  it('thiếu cấu hình bắt buộc → lỗi ngay khi khởi động, không fallback', () => {
    expect(() => loadEnv({ NODE_ENV: 'production', REDIS_URL: 'redis://x:6379' })).toThrowError(/DATABASE_URL_APP/);
  });
  it('TZ mặc định Asia/Ho_Chi_Minh, cutoff 04:00', () => {
    const e = loadEnv({ NODE_ENV: 'test', DATABASE_URL_APP: 'postgresql://u:p@h:5432/d', REDIS_URL: 'redis://h:6379' });
    expect(e.TZ).toBe('Asia/Ho_Chi_Minh');
    expect(e.BUSINESS_DAY_CUTOFF).toBe('04:00');
  });
});
