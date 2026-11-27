import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { AppError } from '../src/common/errors';
import type { EventConsumer } from '../src/infra/outbox/events';
import { OutboxWorker } from '../src/infra/outbox/outbox-worker';
import { PrismaService } from '../src/infra/prisma.service';
import { RateLimiter } from '../src/infra/rate-limiter.service';
import { RedisService } from '../src/infra/redis.service';
import { type MigratedDb, startMigratedDb } from './helpers/db';

// CP03 lát 10 — Redis ACL theo user (ADR-029, đóng giới hạn ADR-019): chạy Redis THẬT bằng chính infra/redis/start.sh.
// api chỉ rl:*, worker chỉ bull:*; không ai trong hai user chạy được lệnh nguy hiểm; default tắt.

const pw = () => randomBytes(18).toString('base64url');

describe('Redis ACL theo user (CP03 lát 10)', () => {
  let redis: StartedTestContainer;
  let db: MigratedDb;
  const P = { ops: pw(), api: pw(), worker: pw() };
  let base = '';
  const url = (user: string, pass: string) => `redis://${user}:${pass}@${base}`;
  const clients: Redis[] = [];
  const client = (user: string, pass: string) => {
    const c = new Redis(url(user, pass), { maxRetriesPerRequest: 1, lazyConnect: true });
    clients.push(c);
    return c;
  };

  beforeAll(async () => {
    [redis, db] = await Promise.all([
      new GenericContainer('redis:7.4-alpine')
        .withCopyFilesToContainer([
          {
            source: resolve(process.cwd(), '../../infra/redis/start.sh'),
            target: '/usr/local/bin/fruit-redis-start.sh',
            mode: 0o755,
          },
        ])
        .withEnvironment({ REDIS_PASSWORD: P.ops, REDIS_API_PASSWORD: P.api, REDIS_WORKER_PASSWORD: P.worker })
        .withEntrypoint(['/usr/local/bin/fruit-redis-start.sh'])
        .withCommand(['--appendonly', 'no', '--maxmemory-policy', 'noeviction'])
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
        .start(),
      startMigratedDb(),
    ]);
    base = `${redis.getHost()}:${redis.getMappedPort(6379)}`;
    await db.q(`CREATE TABLE integration.zz_acl (event_id uuid PRIMARY KEY)`);
    await db.q(`GRANT SELECT, INSERT ON integration.zz_acl TO app_rw`);
  });
  afterAll(async () => {
    for (const c of clients) c.disconnect();
    await Promise.allSettled([redis?.stop(), db?.pg.stop()]);
  });

  it('default tắt: không mật khẩu / mật khẩu cũ kiểu requirepass ⇒ bị từ chối', async () => {
    const anon = new Redis(`redis://${base}`, { maxRetriesPerRequest: 1, lazyConnect: true });
    clients.push(anon);
    await expect(anon.connect().then(() => anon.ping())).rejects.toThrow(
      /NOAUTH|NOPERM|disabled|WRONGPASS|Connection is closed/i,
    );
    const legacy = new Redis(`redis://:${P.ops}@${base}`, { maxRetriesPerRequest: 1, lazyConnect: true });
    clients.push(legacy);
    await expect(legacy.connect().then(() => legacy.ping())).rejects.toThrow(
      /WRONGPASS|NOPERM|disabled|Connection is closed/i,
    );
    // và chính cấu hình: user default bị tắt
    const opsC = client('ops', P.ops);
    await opsC.connect();
    const d = (await opsC.call('ACL', 'GETUSER', 'default')) as unknown[];
    expect(d[d.indexOf('flags') + 1]).toContain('off');
  });

  it('api: RateLimiter thật (Lua EVAL) chạy được trên rl:*; health PING được', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL_APP: db.roleUrl('app_rw'),
      REDIS_URL: url('api', P.api),
      PORT: '0',
      LOG_LEVEL: 'silent',
    });
    const rs = new RedisService(env);
    try {
      await rs.ensureConnected();
      expect(await rs.client.ping()).toBe('PONG');
      const rl = new RateLimiter(rs);
      const lim = [{ name: 'acl.test', id: randomUUID(), max: 2, windowS: 60 }];
      await rl.apply(lim, { failOpen: false });
      await rl.apply(lim, { failOpen: false });
      const third = await rl.apply(lim, { failOpen: false }).catch((e: unknown) => e);
      // failOpen=false: lỗi Redis sẽ là DEPENDENCY_UNAVAILABLE — phải là RATE_LIMITED mới chứng minh EVAL chạy thật
      expect(third).toBeInstanceOf(AppError);
      expect((third as AppError).code).toBe('RATE_LIMITED');
    } finally {
      rs.client.disconnect();
    }
  });

  it('worker: OutboxWorker thật (BullMQ trên bull:*) đẩy và xử lý sự kiện', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL_APP: db.roleUrl('app_rw'),
      REDIS_URL: url('worker', P.worker),
      PORT: '0',
      LOG_LEVEL: 'silent',
    });
    const prisma = new PrismaService(env);
    const consumer: EventConsumer = {
      name: `acl-${randomUUID()}`,
      eventTypes: new Set(['auth.new_device_login']),
      async handle(ev, tx) {
        await tx.$executeRaw`INSERT INTO integration.zz_acl (event_id) VALUES (${ev.event_id}::uuid)`;
      },
    };
    const w = new OutboxWorker(prisma, [consumer], { redisUrl: env.REDIS_URL, idleMs: 50, sweepEveryMs: 60_000 });
    await w.start();
    try {
      const id = randomUUID();
      await db.q(
        `INSERT INTO integration.outbox (id, event_type, schema_version, aggregate_type, aggregate_id, payload, occurred_at)
         VALUES ($1, 'auth.new_device_login', 1, 'user', $2, $3, now())`,
        [id, randomUUID(), JSON.stringify({ k: id })],
      );
      w.poke();
      const deadline = Date.now() + 15_000;
      let done = false;
      while (!done && Date.now() < deadline) {
        done = (await db.q(`SELECT 1 FROM integration.zz_acl WHERE event_id = $1`, [id])).length === 1;
        if (!done) await new Promise((r) => setTimeout(r, 100));
      }
      expect(done).toBe(true);
    } finally {
      await w.stop();
      await prisma.$disconnect();
    }
  });

  it('api/worker không chạy được lệnh nguy hiểm, không đụng khóa của nhau; ops toàn quyền', async () => {
    const api = client('api', P.api);
    const worker = client('worker', P.worker);
    const ops = client('ops', P.ops);
    await Promise.all([api.connect(), worker.connect(), ops.connect()]);
    for (const c of [api, worker]) {
      await expect(c.flushall()).rejects.toThrow(/NOPERM/);
      await expect(c.flushdb()).rejects.toThrow(/NOPERM/);
      await expect(c.call('CONFIG', 'GET', 'dir')).rejects.toThrow(/NOPERM/);
      await expect(c.call('CONFIG', 'SET', 'dir', '/tmp')).rejects.toThrow(/NOPERM/);
      await expect(c.call('DEBUG', 'SLEEP', '0')).rejects.toThrow(/NOPERM|not allowed/);
      await expect(c.keys('*')).rejects.toThrow(/NOPERM/);
      await expect(c.call('SHUTDOWN', 'NOSAVE')).rejects.toThrow(/NOPERM/);
      await expect(c.call('CLIENT', 'KILL', 'TYPE', 'normal')).rejects.toThrow(/NOPERM/);
      await expect(c.call('SCRIPT', 'FLUSH')).rejects.toThrow(/NOPERM/);
      await expect(c.call('ACL', 'LIST')).rejects.toThrow(/NOPERM/);
      await expect(c.call('MONITOR')).rejects.toThrow(/NOPERM/);
      // review cổng CP03: treo Redis / thư viện dùng chung / lộ tên khóa tiền tố khác
      await expect(c.call('SCRIPT', 'DEBUG', 'SYNC')).rejects.toThrow(/NOPERM/);
      await expect(
        c.call('FUNCTION', 'LOAD', "#!lua name=x\nredis.register_function('f', function() return 1 end)"),
      ).rejects.toThrow(/NOPERM/);
      await expect(c.call('FCALL', 'f', '0')).rejects.toThrow(/NOPERM/);
      await expect(c.call('SCAN', '0')).rejects.toThrow(/NOPERM/);
      await expect(c.call('RANDOMKEY')).rejects.toThrow(/NOPERM/);
      await expect(c.call('DBSIZE')).rejects.toThrow(/NOPERM/);
      await expect(c.call('CLIENT', 'TRACKING', 'on', 'BCAST')).rejects.toThrow(/NOPERM/);
      await expect(c.eval(`return redis.call('SCAN', '0')`, 0)).rejects.toThrow(/NOPERM|permission/i);
      // Lua không vượt được ACL: lệnh trong script vẫn bị kiểm
      await expect(c.eval(`return redis.call('FLUSHALL')`, 0)).rejects.toThrow(/NOPERM|permission/i);
    }
    await expect(api.set('bull:x', '1')).rejects.toThrow(/NOPERM/);
    await expect(worker.set('rl:x', '1')).rejects.toThrow(/NOPERM/);
    await expect(api.set('other:x', '1')).rejects.toThrow(/NOPERM/);
    await expect(api.eval(`return redis.call('SET', KEYS[1], '1')`, 1, 'bull:y')).rejects.toThrow(/NOPERM|permission/i);
    expect(await api.set('rl:ok', '1')).toBe('OK');
    expect(await worker.set('bull:ok', '1')).toBe('OK');
    expect(await ops.call('CONFIG', 'GET', 'maxmemory-policy')).toEqual(['maxmemory-policy', 'noeviction']);
    expect(String(await ops.call('ACL', 'WHOAMI'))).toBe('ops');
    // file ACL không chứa mật khẩu rõ (chỉ SHA-256)
    const f = await redis.exec(['cat', '/tmp/redis-users.acl']);
    for (const v of Object.values(P)) expect(f.output).not.toContain(v);
    expect(f.output).toMatch(/user api on #[0-9a-f]{64} /);
  });
});

describe('start.sh từ chối cấu hình yếu', () => {
  it.each([
    [
      { REDIS_PASSWORD: 'a'.repeat(20), REDIS_API_PASSWORD: '', REDIS_WORKER_PASSWORD: 'b'.repeat(20) },
      /thiếu REDIS_API_PASSWORD/,
    ],
    [
      { REDIS_PASSWORD: 'a'.repeat(20), REDIS_API_PASSWORD: 'short', REDIS_WORKER_PASSWORD: 'b'.repeat(20) },
      /ít nhất 16/,
    ],
    [
      { REDIS_PASSWORD: 'a'.repeat(20), REDIS_API_PASSWORD: 'a'.repeat(20), REDIS_WORKER_PASSWORD: 'b'.repeat(20) },
      /phải khác nhau/,
    ],
    [
      { REDIS_PASSWORD: 'a'.repeat(20), REDIS_API_PASSWORD: 'c c'.repeat(8), REDIS_WORKER_PASSWORD: 'b'.repeat(20) },
      /khoảng trắng/,
    ],
  ])('%#', async (env, re) => {
    const c = await new GenericContainer('redis:7.4-alpine')
      .withCopyFilesToContainer([
        {
          source: resolve(process.cwd(), '../../infra/redis/start.sh'),
          target: '/usr/local/bin/fruit-redis-start.sh',
          mode: 0o755,
        },
      ])
      .withEnvironment(env)
      .withEntrypoint(['sh', '-c', 'sleep 3600'])
      .start();
    try {
      const r = await c.exec(['/usr/local/bin/fruit-redis-start.sh']);
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toMatch(re);
    } finally {
      await c.stop();
    }
  });
});
