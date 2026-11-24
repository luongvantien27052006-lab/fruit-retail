import {
  Body,
  Controller,
  Get,
  Injectable,
  type INestApplication,
  Module,
  type MiddlewareConsumer,
  type NestMiddleware,
  Param,
  Post,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { createApp } from '../src/bootstrap';
import { Authenticated, NoAudit, type Principal, Public, RequirePermission } from '../src/common/access';
import { AuditOutboxService, type Tx } from '../src/common/audit-outbox.service';
import { AppError, ERROR_HTTP_STATUS } from '../src/common/errors';
import { isSensitiveKey, toJsonSafe } from '../src/common/json-safe';
import type { RequestStore } from '../src/common/request-context';
import { listRoutes } from '../src/common/route-access';
import { ZodPipe } from '../src/common/zod.pipe';
import { loadEnv } from '../src/config/env';
import { type MigratedDb, startMigratedDb } from './helpers/db';

// CP03 lát 2 — khung request trên PostgreSQL + Redis THẬT: transaction theo request, audit + outbox cùng transaction,
// deny-by-default, envelope lỗi, validation, bigint → chuỗi.

/** Chỉ trong test: header x-test-principal (JSON) → principal trong CLS (thay cho tầng xác thực lát 3–5). */
@Injectable()
class TestPrincipalMiddleware implements NestMiddleware {
  constructor(private readonly cls: ClsService<RequestStore>) {}
  use(req: Request, _res: Response, next: NextFunction): void {
    const h = req.headers['x-test-principal'];
    if (typeof h === 'string') {
      const p = JSON.parse(h) as Omit<Principal, 'permissions'> & { permissions: string[] };
      this.cls.set('principal', { ...p, permissions: new Set(p.permissions) });
    }
    next();
  }
}

const renameBody = z.object({ name: z.string().min(1).max(100) }).strict();

@Controller('_test')
class TestController {
  constructor(
    private readonly txHost: TransactionHost,
    private readonly ao: AuditOutboxService,
  ) {}
  private get tx() {
    return (this.txHost as unknown as Tx).tx;
  }

  @RequirePermission('store:write')
  @Post('stores/:id/rename')
  async rename(@Param('id') id: string, @Body(new ZodPipe(renameBody)) body: z.infer<typeof renameBody>) {
    const before = await this.tx.store.findUniqueOrThrow({ where: { id } });
    const after = await this.tx.store.update({ where: { id }, data: { name: body.name } });
    await this.ao.recordAudit({
      action: 'store.rename',
      resourceType: 'store',
      resourceId: id,
      before: { name: before.name },
      after: { name: after.name, password_hash: 'không được lộ' },
    });
    await this.ao.emitEvent({
      eventType: 'store.renamed',
      schemaVersion: 1,
      aggregateType: 'store',
      aggregateId: id,
      payload: { store_id: id, name: after.name, amount: 1_250_000n },
    });
    return { id, name: after.name, total_amount: 9_007_199_254_740_993n };
  }

  @RequirePermission('store:write')
  @Post('stores/:id/fail-after-write')
  async failAfterWrite(@Param('id') id: string) {
    await this.tx.store.update({ where: { id }, data: { name: 'KHÔNG ĐƯỢC LƯU' } });
    await this.ao.recordAudit({ action: 'store.rename', resourceType: 'store', resourceId: id });
    await this.ao.emitEvent({
      eventType: 'store.renamed',
      schemaVersion: 1,
      aggregateType: 'store',
      aggregateId: id,
      payload: {},
    });
    throw new AppError('INVALID_STATE_TRANSITION', 'Thử rollback');
  }

  @RequirePermission('store:write')
  @Post('stores/:id/no-audit')
  async noAudit(@Param('id') id: string) {
    await this.tx.store.update({ where: { id }, data: { name: 'QUÊN AUDIT' } });
    return { ok: true };
  }

  @NoAudit('route thử nghiệm không ghi dữ liệu nghiệp vụ')
  @Authenticated()
  @Post('ping')
  ping() {
    return { ok: true };
  }

  @Public()
  @Get('audit-outside-tx')
  async auditOutsideTx() {
    await this.ao.recordAudit({ action: 'store.rename', resourceType: 'store' });
    return { ok: true };
  }

  @Public()
  @Get('boom')
  boom(): never {
    throw new Error('chi tiết nội bộ: password=abc');
  }

  // ───── thêm theo kiểm thử agent lần 1 ─────

  @RequirePermission('store:write')
  @Post('stores/:id/audit-body')
  async auditBody(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    await this.ao.recordAudit({ action: 'store.probe', resourceType: 'store', resourceId: id, after: body });
    return { ok: true };
  }

  @RequirePermission('store:write')
  @Post('stores/:id/event-with-phone')
  async eventWithPhone(@Param('id') id: string) {
    await this.tx.store.update({ where: { id }, data: { name: 'SỰ KIỆN CÓ SĐT' } });
    await this.ao.recordAudit({ action: 'store.rename', resourceType: 'store', resourceId: id });
    await this.ao.emitEvent({
      eventType: 'store.renamed',
      schemaVersion: 1,
      aggregateType: 'store',
      aggregateId: id,
      payload: { store_id: id, customer_phone: '0901234567' },
    });
    return { ok: true };
  }

  @RequirePermission('store:write')
  @Post('stores/:id/rename-missing')
  async renameMissing() {
    await this.ao.recordAudit({ action: 'store.rename', resourceType: 'store' });
    await this.tx.store.findUniqueOrThrow({ where: { id: randomUUID() } });
    return { ok: true };
  }

  @RequirePermission('store:write')
  @Post('stores/create')
  async createStore(@Body() body: { code: string }) {
    await this.ao.recordAudit({ action: 'store.create', resourceType: 'store' });
    await this.tx.store.create({ data: { id: randomUUID(), code: body.code, name: 'x' } });
    return { ok: true };
  }

  @RequirePermission('store:write')
  @Post('stores/:id/bad-response')
  async badResponse(@Param('id') id: string) {
    await this.tx.store.update({ where: { id }, data: { name: 'SAU ĐÓ LỖI TUẦN TỰ' } });
    await this.ao.recordAudit({ action: 'store.rename', resourceType: 'store', resourceId: id });
    return { n: Number.NaN };
  }

  @RequirePermission('store:write')
  @Post('stores/:id/rename-to')
  async renameTo(@Param('id') id: string, @Body() body: { name: string }) {
    await this.tx.store.update({ where: { id }, data: { name: body.name } });
    await this.ao.recordAudit({ action: 'store.rename', resourceType: 'store', resourceId: id });
    return { ok: true };
  }

  @Public()
  @Get('stores/:id/write-in-get')
  async writeInGet(@Param('id') id: string) {
    await this.tx.store.update({ where: { id }, data: { name: 'GHI TRONG GET' } });
    return { ok: true };
  }

  @RequirePermission('store:write')
  @Post('stores/:id/fire-and-forget')
  async fireAndForget(@Param('id') id: string) {
    await this.ao.recordAudit({ action: 'store.rename', resourceType: 'store', resourceId: id });
    lateWrite = new Promise((res) => setTimeout(res, 200)).then(() =>
      this.tx.store.update({ where: { id }, data: { name: 'GHI SAU RESPONSE' } }),
    );
    return { ok: true };
  }
}

let lateWrite: Promise<unknown> | undefined;

@Module({ providers: [TestPrincipalMiddleware] })
class TestPrincipalModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TestPrincipalMiddleware).forRoutes('*');
  }
}

describe('khung request (CP03 lát 2)', () => {
  let db: MigratedDb;
  let redis: StartedRedisContainer;
  let app: INestApplication;
  let env: ReturnType<typeof loadEnv>;
  const store = randomUUID();
  const principal = (permissions: string[]) =>
    JSON.stringify({
      userId: randomUUID(),
      userType: 'MASTER',
      sessionId: randomUUID(),
      role: 'MASTER_ADMIN',
      permissions,
    });

  beforeAll(async () => {
    [db, redis] = await Promise.all([startMigratedDb(), new RedisContainer('redis:7.4-alpine').start()]);
    await db.q(`INSERT INTO core.stores (id, code, name) VALUES ($1, 'RF-1', 'Cửa hàng gốc')`, [store]);
    env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL_APP: db.roleUrl('app_rw'),
      REDIS_URL: redis.getConnectionUrl(),
      PORT: '0',
      LOG_LEVEL: 'silent',
    });
    app = await createApp(env, { logger: false }, { imports: [TestPrincipalModule], controllers: [TestController] });
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    await Promise.allSettled([db?.pg.stop(), redis?.stop()]);
  });

  const http = () => request(app.getHttpServer());
  const rows = (sql: string, p: unknown[] = []) => db.q(sql, p);

  it('mutation thành công: nghiệp vụ + audit + outbox cùng commit; bigint → chuỗi; bí mật trong audit bị che', async () => {
    const res = await http()
      .post(`/v1/_test/stores/${store}/rename`)
      .set('x-test-principal', principal(['store:write']))
      .set('X-Request-Id', 'req-rename-0001')
      .set('X-Device-Id', 'browser-abc-123')
      .send({ name: 'Tên mới' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: store, name: 'Tên mới', total_amount: '9007199254740993' });
    const [s] = await rows(`SELECT name FROM core.stores WHERE id = $1`, [store]);
    expect(s?.name).toBe('Tên mới');
    const audits = await rows(`SELECT * FROM audit.logs WHERE request_id = 'req-rename-0001'`);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'store.rename',
      resource_type: 'store',
      resource_id: store,
      actor_type: 'MASTER',
      role: 'MASTER_ADMIN',
      device_id: null, // X-Device-Id client tự khai không ghi vào audit (chỉ thiết bị POS đã xác minh)
      before: { name: 'Cửa hàng gốc' },
      after: { name: 'Tên mới', password_hash: '[REDACTED]' },
    });
    expect(audits[0]?.ip).toBeTruthy();
    const ev = await rows(`SELECT * FROM integration.outbox WHERE aggregate_id = $1 AND event_type = 'store.renamed'`, [
      store,
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toEqual({ store_id: store, name: 'Tên mới', amount: '1250000' });
    expect(String(ev[0]?.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/); // UUID v7
  });

  it('lỗi sau khi đã ghi ⇒ rollback toàn phần (nghiệp vụ + audit + outbox cùng mất) — ADR-016', async () => {
    const before = await rows(`SELECT count(*)::int AS n FROM integration.outbox`);
    const res = await http()
      .post(`/v1/_test/stores/${store}/fail-after-write`)
      .set('x-test-principal', principal(['store:write']))
      .set('X-Request-Id', 'req-fail-00001');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: 'INVALID_STATE_TRANSITION',
      message: 'Thử rollback',
      request_id: 'req-fail-00001',
    });
    const [s] = await rows(`SELECT name FROM core.stores WHERE id = $1`, [store]);
    expect(s?.name).toBe('Tên mới');
    expect(await rows(`SELECT 1 FROM audit.logs WHERE request_id = 'req-fail-00001'`)).toEqual([]);
    expect(await rows(`SELECT count(*)::int AS n FROM integration.outbox`)).toEqual(before);
  });

  it('mutation quên ghi audit ⇒ 500 + rollback (không âm thầm thành công)', async () => {
    const res = await http()
      .post(`/v1/_test/stores/${store}/no-audit`)
      .set('x-test-principal', principal(['store:write']));
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    const [s] = await rows(`SELECT name FROM core.stores WHERE id = $1`, [store]);
    expect(s?.name).toBe('Tên mới');
  });

  it('@NoAudit có lý do: mutation không ghi audit vẫn chạy', async () => {
    const res = await http().post('/v1/_test/ping').set('x-test-principal', principal([]));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });

  it('recordAudit ngoài transaction ⇒ lỗi (không ghi lẻ)', async () => {
    const res = await http().get('/v1/_test/audit-outside-tx');
    expect(res.status).toBe(500);
    expect(await rows(`SELECT 1 FROM audit.logs WHERE request_id = $1`, [res.body.request_id])).toEqual([]);
  });

  it('chưa đăng nhập ⇒ 401; thiếu mã quyền ⇒ 403 kèm mã quyền cần', async () => {
    const a = await http().post(`/v1/_test/stores/${store}/rename`).send({ name: 'x' });
    expect(a.status).toBe(401);
    expect(a.body.code).toBe('AUTHENTICATION_REQUIRED');
    const b = await http()
      .post(`/v1/_test/stores/${store}/rename`)
      .set('x-test-principal', principal(['catalog:read']))
      .send({ name: 'x' });
    expect(b.status).toBe(403);
    expect(b.body).toMatchObject({ code: 'ACTION_FORBIDDEN', details: { permission: 'store:write' } });
  });

  it('body sai ⇒ 400 INVALID_REQUEST kèm đường dẫn lỗi; trường lạ bị từ chối', async () => {
    const p = principal(['store:write']);
    const a = await http().post(`/v1/_test/stores/${store}/rename`).set('x-test-principal', p).send({ name: '' });
    expect(a.status).toBe(400);
    expect(a.body.code).toBe('INVALID_REQUEST');
    expect(a.body.details.issues[0].path).toBe('name');
    const b = await http()
      .post(`/v1/_test/stores/${store}/rename`)
      .set('x-test-principal', p)
      .send({ name: 'ok', is_admin: true });
    expect(b.status).toBe(400);
    const c = await http()
      .post(`/v1/_test/stores/${store}/rename`)
      .set('x-test-principal', p)
      .set('Content-Type', 'application/json')
      .send('{hỏng');
    expect(c.status).toBe(400);
    expect(c.body.code).toBe('INVALID_REQUEST');
  });

  it('route không tồn tại ⇒ 404 envelope chuẩn; lỗi bất ngờ ⇒ 500 không lộ chi tiết', async () => {
    const a = await http().get('/v1/khong-co').set('X-Request-Id', 'req-notfound-1');
    expect(a.status).toBe(404);
    expect(a.body).toEqual({ code: 'RESOURCE_NOT_FOUND', message: 'Không tìm thấy', request_id: 'req-notfound-1' });
    const b = await http().get('/v1/_test/boom');
    expect(b.status).toBe(500);
    expect(b.body).toEqual({ code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống', request_id: expect.any(String) });
    expect(JSON.stringify(b.body)).not.toMatch(/password|stack|chi tiết nội bộ/);
  });

  it('request đồng thời: mỗi request giữ ngữ cảnh riêng (CLS) — audit đúng request_id', async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `req-par-${String(i).padStart(4, '0')}`);
    const res = await Promise.all(
      ids.map((rid, i) =>
        http()
          .post(`/v1/_test/stores/${store}/rename`)
          .set('x-test-principal', principal(['store:write']))
          .set('X-Request-Id', rid)
          .send({ name: `Song song ${i}` }),
      ),
    );
    expect(res.map((r) => r.status)).toEqual(Array(6).fill(201));
    const got = await rows(
      `SELECT request_id, after->>'name' AS n FROM audit.logs WHERE request_id LIKE 'req-par-%' ORDER BY request_id`,
    );
    expect(got.map((r) => r.request_id)).toEqual(ids);
    expect(got.map((r) => r.n)).toEqual(ids.map((_, i) => `Song song ${i}`));
  });

  it('quyền khai báo ở route thật khớp x-permission của OpenAPI (không lệch hợp đồng)', () => {
    const spec = parse(readFileSync(resolve(process.cwd(), '../../packages/contracts/openapi.yaml'), 'utf8')) as {
      paths: Record<string, Record<string, { 'x-permission'?: string }>>;
    };
    const real = listRoutes(app).filter((r) => !r.path.startsWith('/_test'));
    expect(real.length).toBeGreaterThan(0);
    for (const r of real) {
      const op = spec.paths[r.path]?.[r.method.toLowerCase()];
      expect({ route: `${r.method} ${r.path}`, inSpec: !!op }).toEqual({
        route: `${r.method} ${r.path}`,
        inSpec: true,
      });
      const declared =
        r.access?.kind === 'public' ? 'public' : r.access?.kind === 'authenticated' ? 'auth:*' : r.access?.code;
      expect({ route: `${r.method} ${r.path}`, perm: declared }).toEqual({
        route: `${r.method} ${r.path}`,
        perm: op?.['x-permission'],
      });
    }
  });

  it('bảng mã lỗi khớp OpenAPI (ErrorCode enum + x-http-status)', () => {
    const spec = parse(readFileSync(resolve(process.cwd(), '../../packages/contracts/openapi.yaml'), 'utf8')) as {
      components: { schemas: { ErrorCode: { enum: string[]; 'x-http-status': Record<string, number> } } };
    };
    const ec = spec.components.schemas.ErrorCode;
    expect(Object.keys(ERROR_HTTP_STATUS).sort()).toEqual([...ec.enum].sort());
    expect(ERROR_HTTP_STATUS).toEqual(ec['x-http-status']);
  });

  // ───── theo kiểm thử agent lần 1 ─────

  it('H1 — audit che đúng khóa bí mật/PII theo token, KHÔNG che nhầm dữ liệu nghiệp vụ', async () => {
    const rid = 'req-redact-0001';
    const res = await http()
      .post(`/v1/_test/stores/${store}/audit-body`)
      .set('x-test-principal', principal(['store:write']))
      .set('X-Request-Id', rid)
      .send({
        shipping_fee: '15000',
        address: '12 Lê Lợi',
        opinion: 'tốt',
        mapping: 'x',
        customer_phone: '0901234567',
        receiverPhone: '0909',
        account_number: '123456789',
        api_key: 'sk',
        shipping_address: '99 Nguyễn Huệ',
        pin_hash: 'h',
        nested: { refreshToken: 't', note: 'n' },
      });
    expect(res.status).toBe(201);
    const [a] = await rows(`SELECT after FROM audit.logs WHERE request_id = $1`, [rid]);
    expect(a?.after).toEqual({
      shipping_fee: '15000',
      address: '12 Lê Lợi',
      opinion: 'tốt',
      mapping: 'x',
      customer_phone: '[REDACTED]',
      receiverPhone: '[REDACTED]',
      account_number: '[REDACTED]',
      api_key: '[REDACTED]',
      shipping_address: '[REDACTED]',
      pin_hash: '[REDACTED]',
      nested: { refreshToken: '[REDACTED]', note: 'n' },
    });
  });

  it('H1 — sự kiện chứa khóa nhạy cảm ⇒ lỗi + rollback (không che âm thầm làm hỏng dữ liệu sự kiện)', async () => {
    const res = await http()
      .post(`/v1/_test/stores/${store}/event-with-phone`)
      .set('x-test-principal', principal(['store:write']));
    expect(res.status).toBe(500);
    const [s] = await rows(`SELECT name FROM core.stores WHERE id = $1`, [store]);
    expect(s?.name).not.toBe('SỰ KIỆN CÓ SĐT');
  });

  it('M5 — toJsonSafe từ chối Set/Map/class (không làm mất dữ liệu âm thầm); isSensitiveKey theo token', () => {
    expect(() => toJsonSafe({ s: new Set([1]) })).toThrow(/object thuần/);
    expect(() => toJsonSafe({ m: new Map() })).toThrow(/object thuần/);
    class Decimalish {
      v = 1;
      toJSON() {
        return '1';
      }
    }
    expect(() => toJsonSafe({ d: new Decimalish() })).toThrow(/Decimalish/);
    expect(toJsonSafe({ a: [1n, new Date(0)], b: Object.create(null) as object })).toEqual({
      a: ['1', '1970-01-01T00:00:00.000Z'],
      b: {},
    });
    for (const k of ['shipping_fee', 'opinion', 'mapping', 'address', 'spinner', 'tokenizer_mode'])
      expect({ k, s: isSensitiveKey(k) }).toEqual({ k, s: false });
    for (const k of [
      'password',
      'pinHash',
      'phone_enc',
      'customerPhone',
      'api_key',
      'accountNumber',
      'deliveryAddress',
      'otp',
    ])
      expect({ k, s: isSensitiveKey(k) }).toEqual({ k, s: true });
  });

  it('M2 — lỗi parser/body quá lớn/URI hỏng: envelope có request_id, thông báo cố định, mã HTTP khớp hợp đồng', async () => {
    const p = principal(['store:write']);
    const a = await http()
      .post(`/v1/_test/stores/${store}/rename`)
      .set('x-test-principal', p)
      .set('X-Request-Id', 'req-badjson-01')
      .set('Content-Type', 'application/json')
      .send('{"name": "x", hỏng');
    expect(a.status).toBe(400);
    expect(a.body).toEqual({ code: 'INVALID_REQUEST', message: 'Yêu cầu không hợp lệ', request_id: 'req-badjson-01' });
    const b = await http()
      .post(`/v1/_test/stores/${store}/rename`)
      .set('x-test-principal', p)
      .set('X-Request-Id', 'req-toolarge-1')
      .send({ name: 'x'.repeat(3 * 1024 * 1024) });
    expect(b.status).toBe(400);
    expect(b.body).toEqual({
      code: 'INVALID_REQUEST',
      message: 'Dữ liệu gửi lên quá lớn',
      request_id: 'req-toolarge-1',
    });
    const c = await http().get('/v1/_test/stores/%E0%A4%A/write-in-get').set('X-Request-Id', 'req-baduri-001');
    expect(c.status).toBe(400);
    expect(c.body.request_id).toBe('req-baduri-001');
    expect(c.body.message).toBe('Yêu cầu không hợp lệ');
  });

  it('M3 — lỗi DB ánh xạ đúng mã: P2025 → 404, trùng khóa → 409, vi phạm CHECK → 400; đều rollback', async () => {
    const p = principal(['store:write']);
    const a = await http().post(`/v1/_test/stores/${store}/rename-missing`).set('x-test-principal', p);
    expect(a.status).toBe(404);
    expect(a.body.code).toBe('RESOURCE_NOT_FOUND');
    const b = await http().post('/v1/_test/stores/create').set('x-test-principal', p).send({ code: 'RF-1' });
    expect(b.status).toBe(409);
    expect(b.body).toMatchObject({ code: 'VERSION_CONFLICT', details: { reason: 'UNIQUE' } });
    const c = await http().post('/v1/_test/stores/create').set('x-test-principal', p).send({ code: 'sai định dạng' });
    expect(c.status).toBe(400);
    expect(c.body).toMatchObject({ code: 'INVALID_REQUEST', details: { reason: '23514' } });
    expect(
      await rows(`SELECT 1 FROM audit.logs WHERE request_id = ANY($1)`, [
        [a.body.request_id, b.body.request_id, c.body.request_id],
      ]),
    ).toEqual([]);
  });

  it('M6 — ghi DB ngoài transaction bị chặn: GET ghi dữ liệu ⇒ 500; ghi "fire-and-forget" sau response ⇒ lỗi', async () => {
    const a = await http().get(`/v1/_test/stores/${store}/write-in-get`);
    expect(a.status).toBe(500);
    const b = await http()
      .post(`/v1/_test/stores/${store}/fire-and-forget`)
      .set('x-test-principal', principal(['store:write']));
    expect(b.status).toBe(201);
    await expect(lateWrite).rejects.toThrow(/Ghi DB ngoài transaction bị chặn/);
    const [s] = await rows(`SELECT name FROM core.stores WHERE id = $1`, [store]);
    expect(s?.name).not.toMatch(/GHI TRONG GET|GHI SAU RESPONSE/);
  });

  it('L6 — lỗi tuần tự hóa response ⇒ rollback; lỗi lúc COMMIT (trigger trì hoãn) ⇒ 500 + rollback', async () => {
    const p = principal(['store:write']);
    const a = await http().post(`/v1/_test/stores/${store}/bad-response`).set('x-test-principal', p);
    expect(a.status).toBe(500);
    const [s1] = await rows(`SELECT name FROM core.stores WHERE id = $1`, [store]);
    expect(s1?.name).not.toBe('SAU ĐÓ LỖI TUẦN TỰ');
    await db.q(`CREATE FUNCTION core._commit_fail() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN IF NEW.name = 'COMMIT-FAIL' THEN RAISE EXCEPTION 'lỗi lúc commit'; END IF; RETURN NULL; END $$;
                CREATE CONSTRAINT TRIGGER _commit_fail AFTER UPDATE ON core.stores DEFERRABLE INITIALLY DEFERRED
                FOR EACH ROW EXECUTE FUNCTION core._commit_fail();`);
    try {
      const b = await http()
        .post(`/v1/_test/stores/${store}/rename-to`)
        .set('x-test-principal', p)
        .set('X-Request-Id', 'req-commitfail')
        .send({ name: 'COMMIT-FAIL' });
      expect(b.status).toBe(500);
      expect(await rows(`SELECT 1 FROM audit.logs WHERE request_id = 'req-commitfail'`)).toEqual([]);
      const [s2] = await rows(`SELECT name FROM core.stores WHERE id = $1`, [store]);
      expect(s2?.name).not.toBe('COMMIT-FAIL');
    } finally {
      await db.q(`DROP TRIGGER _commit_fail ON core.stores; DROP FUNCTION core._commit_fail()`);
    }
  });
});
