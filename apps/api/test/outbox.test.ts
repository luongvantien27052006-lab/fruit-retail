import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { ConsumerRunner } from '../src/infra/outbox/consumer-runner';
import { type EventConsumer, OUTBOX_QUEUE } from '../src/infra/outbox/events';
import { OutboxRelay, RELAY_MAX_ATTEMPTS } from '../src/infra/outbox/outbox-relay';
import { OutboxWorker } from '../src/infra/outbox/outbox-worker';
import { PrismaService } from '../src/infra/prisma.service';
import { type MigratedDb, startMigratedDb } from './helpers/db';

// CP03 lát 7 — outbox relay + consumer idempotent (ADR-007, ADR-025) trên PostgreSQL + Redis thật.
// Kiểm chính: worker chết giữa chừng ⇒ không mất, không lặp tác dụng.

describe('outbox relay + consumer (CP03 lát 7)', () => {
  let db: MigratedDb;
  let redis: StartedRedisContainer;
  let prisma: PrismaService;
  let conn: Redis;
  let queue: Queue;
  const rows = (sql: string, p: unknown[] = []) => db.q(sql, p);

  async function event(type = 'auth.new_device_login'): Promise<string> {
    const id = randomUUID();
    await rows(
      `INSERT INTO integration.outbox (id, event_type, schema_version, aggregate_type, aggregate_id, payload, occurred_at)
       VALUES ($1, $2, 1, 'user', $3, $4, now())`,
      [id, type, randomUUID(), JSON.stringify({ k: id })],
    );
    return id;
  }
  const jobIds = async () =>
    (await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'])).map((j) => j.id);

  /** consumer thử: mỗi lần xử lý chèn một dòng vào bảng tác dụng (khóa chính event_id ⇒ lặp tác dụng sẽ lỗi lộ ra) */
  const effects = (name: string, failTimes = 0): EventConsumer & { calls: number } => {
    let left = failTimes;
    const c = {
      name,
      eventTypes: new Set(['auth.new_device_login']),
      calls: 0,
      async handle(ev: { event_id: string }, tx: Parameters<EventConsumer['handle']>[1]) {
        c.calls++;
        await tx.$executeRaw`INSERT INTO integration.zz_effects (consumer, event_id) VALUES (${name}, ${ev.event_id}::uuid)`;
        if (left-- > 0) throw new Error('lỗi tạm thời');
      },
    };
    return c;
  };

  beforeAll(async () => {
    [db, redis] = await Promise.all([startMigratedDb(), new RedisContainer('redis:7.4-alpine').start()]);
    await rows(`CREATE TABLE integration.zz_effects (consumer text, event_id uuid, PRIMARY KEY (consumer, event_id))`);
    await rows(`GRANT SELECT, INSERT ON integration.zz_effects TO app_rw`);
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL_APP: db.roleUrl('app_rw'),
      REDIS_URL: redis.getConnectionUrl(),
      PORT: '0',
      LOG_LEVEL: 'silent',
    });
    prisma = new PrismaService(env);
    conn = new Redis(redis.getConnectionUrl(), { maxRetriesPerRequest: 1 });
    queue = new Queue(OUTBOX_QUEUE, { connection: conn });
  });
  afterAll(async () => {
    await queue?.close();
    conn?.disconnect();
    await prisma?.$disconnect();
    await Promise.allSettled([db?.pg.stop(), redis?.stop()]);
  });

  it('relay đẩy sự kiện đến hạn vào BullMQ (jobId = id sự kiện), đánh dấu published_at; lượt sau không đẩy lại', async () => {
    await queue.obliterate({ force: true });
    const ids = [await event(), await event(), await event()];
    const relay = new OutboxRelay(prisma, queue);
    expect(await relay.relayOnce()).toBeGreaterThanOrEqual(3);
    for (const id of ids) {
      const [r] = await rows(`SELECT published_at, attempts FROM integration.outbox WHERE id = $1`, [id]);
      expect(r?.published_at).not.toBeNull();
      const job = await queue.getJob(id);
      expect(job?.data).toMatchObject({ event_id: id, event_type: 'auth.new_device_login', schema_version: 1 });
    }
    expect(await relay.relayOnce()).toBe(0);
  });

  it('hai relay chạy song song (SKIP LOCKED) ⇒ mỗi sự kiện đúng một job', async () => {
    await queue.obliterate({ force: true });
    const ids = await Promise.all(Array.from({ length: 30 }, () => event()));
    const a = new OutboxRelay(prisma, queue);
    const b = new OutboxRelay(prisma, queue);
    const [na, nb] = await Promise.all([a.relayOnce(10), b.relayOnce(10)]);
    expect(na + nb).toBe(20);
    while ((await a.relayOnce(10)) > 0);
    const got = await jobIds();
    expect(new Set(got).size).toBe(got.length);
    for (const id of ids) expect(got).toContain(id);
  });

  it('worker chết sau khi đẩy, trước khi commit ⇒ sự kiện vẫn chưa gửi; lần sau đẩy lại KHÔNG tạo job trùng; tác dụng một lần', async () => {
    await queue.obliterate({ force: true });
    const id = await event();
    const crash = new OutboxRelay(prisma, queue, () => Promise.reject(new Error('kill -9 giả lập')));
    await expect(crash.relayOnce()).rejects.toThrow(/kill/);
    const [r] = await rows(`SELECT published_at FROM integration.outbox WHERE id = $1`, [id]);
    expect(r?.published_at).toBeNull(); // không mất: chưa đánh dấu
    expect(await jobIds()).toContain(id); // job đã vào Redis
    await new OutboxRelay(prisma, queue).relayOnce();
    expect((await jobIds()).filter((j) => j === id)).toHaveLength(1); // không lặp job
    const c = effects(`c-${randomUUID()}`);
    const runner = new ConsumerRunner(prisma, [c]);
    const data = (await queue.getJob(id))?.data;
    // giao 3 lần (BullMQ thử lại / bộ quét / relay đẩy lại) ⇒ một tác dụng
    expect(await runner.process(data)).toEqual([c.name]);
    expect(await runner.process(data)).toEqual([]);
    expect(await runner.process(data)).toEqual([]);
    expect(await rows(`SELECT 1 FROM integration.zz_effects WHERE consumer = $1`, [c.name])).toHaveLength(1);
  });

  it('consumer lỗi ⇒ rollback cả processed_events lẫn tác dụng; lần sau làm lại; consumer khác không bị lặp', async () => {
    const id = await event();
    const bad = effects(`bad-${randomUUID()}`, 1);
    const good = effects(`good-${randomUUID()}`);
    const runner = new ConsumerRunner(prisma, [good, bad]);
    const ev = {
      event_id: id,
      event_type: 'auth.new_device_login',
      schema_version: 1,
      aggregate_type: 'user',
      aggregate_id: 'x',
      occurred_at: new Date().toISOString(),
      payload: {},
    };
    await expect(runner.process(ev)).rejects.toThrow(/consumer lỗi: bad-/);
    expect(await rows(`SELECT 1 FROM integration.processed_events WHERE consumer = $1`, [bad.name])).toEqual([]);
    expect(await rows(`SELECT 1 FROM integration.zz_effects WHERE consumer = $1`, [bad.name])).toEqual([]);
    expect(await runner.process(ev)).toEqual([bad.name]); // good đã xong, chỉ bad chạy lại
    expect(good.calls).toBe(1);
    expect(await rows(`SELECT 1 FROM integration.zz_effects WHERE event_id = $1`, [id])).toHaveLength(2);
    // sự kiện không quan tâm ⇒ không ghi processed_events
    expect(await runner.process({ ...ev, event_id: randomUUID(), event_type: 'other.event' })).toEqual([]);
  });

  it('Redis lỗi ⇒ attempts + 1, lùi dần, last_error; quá 10 lần ⇒ dead_at; lượt lỗi không treo', async () => {
    const id = await event();
    // các sự kiện khác chưa gửi (từ test trước) đẩy hết trước
    while ((await new OutboxRelay(prisma, queue).relayOnce()) > 0);
    await rows(`UPDATE integration.outbox SET published_at = NULL, next_attempt_at = now() WHERE id = $1`, [id]);
    const dead = new Redis('redis://127.0.0.1:1', {
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    const deadQ = new Queue(OUTBOX_QUEUE, { connection: dead });
    deadQ.on('error', () => undefined);
    const relay = new OutboxRelay(prisma, deadQ);
    const t0 = Date.now();
    expect(await relay.relayOnce()).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5_000);
    const [r] = await rows(
      `SELECT attempts, last_error, published_at, extract(epoch FROM next_attempt_at - now()) AS wait FROM integration.outbox WHERE id = $1`,
      [id],
    );
    expect(r).toMatchObject({ attempts: 1, published_at: null });
    expect(String(r?.last_error).length).toBeGreaterThan(0);
    expect(Number(r?.wait)).toBeGreaterThan(0);
    await rows(`UPDATE integration.outbox SET attempts = $2, next_attempt_at = now() WHERE id = $1`, [
      id,
      RELAY_MAX_ATTEMPTS - 1,
    ]);
    await relay.relayOnce();
    const [d] = await rows(`SELECT dead_at FROM integration.outbox WHERE id = $1`, [id]);
    expect(d?.dead_at).not.toBeNull();
    // dead ⇒ relay không lấy nữa
    await rows(`UPDATE integration.outbox SET next_attempt_at = now() WHERE id = $1`, [id]);
    await new OutboxRelay(prisma, queue).relayOnce();
    const [d2] = await rows(`SELECT published_at FROM integration.outbox WHERE id = $1`, [id]);
    expect(d2?.published_at).toBeNull();
    await deadQ.close().catch(() => undefined);
    dead.disconnect();
  });

  it('bộ quét: job mất khỏi Redis (AOF everysec) mà consumer chưa xử lý ⇒ đẩy lại; đã xử lý hoặc job còn ⇒ để yên', async () => {
    await queue.obliterate({ force: true });
    const c = effects(`sw-${randomUUID()}`);
    const lost = await event();
    const kept = await event();
    const done = await event();
    const relay = new OutboxRelay(prisma, queue);
    while ((await relay.relayOnce()) > 0);
    await rows(`UPDATE integration.outbox SET published_at = now() - interval '1 hour' WHERE id = ANY($1::uuid[])`, [
      [lost, kept, done],
    ]);
    await (await queue.getJob(lost))?.remove(); // mất trong Redis
    await (await queue.getJob(done))?.remove();
    await rows(`INSERT INTO integration.processed_events (consumer, event_id) VALUES ($1, $2)`, [c.name, done]);
    // các sự kiện cũ của test khác cũng chưa xử lý bởi consumer mới này ⇒ có thể bị đẩy lại; chỉ kiểm 3 sự kiện trên
    await relay.sweepOnce([c]);
    expect(await queue.getJob(lost)).toBeTruthy();
    expect(await queue.getJob(kept)).toBeTruthy();
    expect(await queue.getJob(done)).toBeFalsy();
  });

  it('OutboxWorker đầu-cuối: ghi outbox ⇒ relay ⇒ BullMQ ⇒ consumer chạy đúng một lần; dừng gọn', async () => {
    await queue.obliterate({ force: true });
    await rows(`UPDATE integration.outbox SET published_at = now() WHERE published_at IS NULL`); // dọn tồn của test trước
    const c = effects(`e2e-${randomUUID()}`);
    const w = new OutboxWorker(prisma, [c], { redisUrl: redis.getConnectionUrl(), idleMs: 50, sweepEveryMs: 60_000 });
    await w.start();
    try {
      const ids = [await event(), await event()];
      w.poke();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const got = await rows(`SELECT event_id::text FROM integration.zz_effects WHERE consumer = $1`, [c.name]);
        if (got.length >= 2) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const got = (
        await rows(`SELECT event_id::text AS e FROM integration.zz_effects WHERE consumer = $1`, [c.name])
      ).map((x) => x.e);
      expect(got.sort()).toEqual([...ids].sort());
    } finally {
      await w.stop();
    }
  });
});
