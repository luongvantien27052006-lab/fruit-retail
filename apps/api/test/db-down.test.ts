import { Controller, Get, type INestApplication, Param, Post } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testAuthEnv } from './helpers/auth-env';
import { createApp } from '../src/bootstrap';
import { Public } from '../src/common/access';
import { AuditOutboxService, type Tx } from '../src/common/audit-outbox.service';
import { isConnectionError } from '../src/common/db-errors';
import { loadEnv } from '../src/config/env';
import { type MigratedDb, startMigratedDb } from './helpers/db';

// CP03 lát 2 (kiểm thử agent lần 3, T3): DB sập THẬT (dừng container) ⇒ 503 DEPENDENCY_UNAVAILABLE, không phải 500.
// File riêng vì test dừng container DB.

@Public()
@Controller('_down')
class DownController {
  constructor(
    private readonly txHost: TransactionHost,
    private readonly ao: AuditOutboxService,
  ) {}
  private get tx() {
    return (this.txHost as unknown as Tx).tx;
  }

  @Get('stores/:id')
  async read(@Param('id') id: string) {
    return this.tx.store.findUnique({ where: { id } });
  }

  @Post('stores/:id/rename')
  async rename(@Param('id') id: string) {
    await this.tx.store.update({ where: { id }, data: { name: 'x' } });
    await this.ao.recordAudit({ action: 'store.rename', resourceType: 'store', resourceId: id });
    return { ok: true };
  }
}

describe('DB sập thật ⇒ 503', () => {
  let db: MigratedDb;
  let redis: StartedRedisContainer;
  let app: INestApplication;
  const store = randomUUID();

  beforeAll(async () => {
    [db, redis] = await Promise.all([startMigratedDb(), new RedisContainer('redis:7.4-alpine').start()]);
    await db.q(`INSERT INTO core.stores (id, code, name) VALUES ($1, 'DOWN-1', 'x')`, [store]);
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL_APP: db.roleUrl('app_rw'),
      REDIS_URL: redis.getConnectionUrl(),
      PORT: '0',
      LOG_LEVEL: 'silent',
      ...testAuthEnv(db.roleUrl('audit_writer')),
    });
    app = await createApp(env, { logger: false }, { controllers: [DownController] });
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    await Promise.allSettled([db?.pg.stop(), redis?.stop()]);
  });

  it('nhận diện lỗi kết nối của driver (code mạng, AggregateError, message pg-pool)', () => {
    expect(isConnectionError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isConnectionError(new AggregateError([Object.assign(new Error('a'), { code: 'ECONNRESET' })]))).toBe(true);
    expect(isConnectionError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isConnectionError(Object.assign(new Error('x'), { code: 'EPIPE' }))).toBe(false);
    expect(isConnectionError(new Error('khác'))).toBe(false);
  });

  it('đọc và mutation khi DB vừa sập và sau đó: đều 503 DEPENDENCY_UNAVAILABLE', async () => {
    const http = () => request(app.getHttpServer());
    expect((await http().get(`/v1/_down/stores/${store}`)).status).toBe(200); // pool đã có kết nối
    await db.pg.stop();
    for (let round = 0; round < 2; round++) {
      const r = await http().get(`/v1/_down/stores/${store}`);
      expect({ round, status: r.status, code: r.body.code }).toEqual({
        round,
        status: 503,
        code: 'DEPENDENCY_UNAVAILABLE',
      });
      const w = await http().post(`/v1/_down/stores/${store}/rename`);
      expect({ round, status: w.status, code: w.body.code }).toEqual({
        round,
        status: 503,
        code: 'DEPENDENCY_UNAVAILABLE',
      });
      await new Promise((res) => setTimeout(res, 500));
    }
  });
});
