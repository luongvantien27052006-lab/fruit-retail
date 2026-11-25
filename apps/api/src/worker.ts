import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { loadEnv } from './config/env';
import { PrismaService } from './infra/prisma.service';
import { EVENT_CONSUMERS, type EventConsumer } from './infra/outbox/events';
import { OutboxWorker } from './infra/outbox/outbox-worker';
import { RedisService } from './infra/redis.service';
import { WorkerModule } from './worker.module';

const HEARTBEAT_MS = 30_000;
const BEAT_TIMEOUT_MS = 10_000;

/** Entry worker (ADR-002): heartbeat + outbox relay / consumer (CP03 lát 7 — ADR-025); projector, cron thêm sau. */
async function main(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(env), { bufferLogs: true });
  const log = app.get(Logger);
  app.useLogger(log);

  const prisma = app.get(PrismaService);
  const redis = app.get(RedisService);
  let running = false;
  const beat = async (): Promise<void> => {
    if (running) return; // không chạy chồng khi lần trước còn treo
    running = true;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => {
          await prisma.$queryRaw`SELECT 1`;
          await redis.ensureConnected();
          await redis.client.ping();
        })(),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(`heartbeat quá ${BEAT_TIMEOUT_MS} ms`)), BEAT_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      // Không nuốt lỗi: ghi error để giám sát thấy; process vẫn sống để tự hồi phục khi phụ thuộc quay lại.
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'worker heartbeat: phụ thuộc lỗi');
    } finally {
      clearTimeout(timer);
      running = false;
    }
  };
  await beat();
  const interval = setInterval(() => void beat(), HEARTBEAT_MS);
  const outbox = new OutboxWorker(prisma, app.get<EventConsumer[]>(EVENT_CONSUMERS), { redisUrl: env.REDIS_URL });
  await outbox.start();

  // Một cơ chế tắt duy nhất (không bật enableShutdownHooks song song).
  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.log(`worker nhận ${signal}, đang dừng`, 'Worker');
    clearInterval(interval);
    try {
      await outbox.stop();
      await app.close();
      process.exit(0);
    } catch (err) {
      console.error('[worker] dừng lỗi:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));
  log.log('worker đã khởi động (heartbeat 30 s, outbox relay + consumer)', 'Worker');
}

main().catch((err: unknown) => {
  console.error('[worker] khởi động thất bại:', err instanceof Error ? err.message : err);
  process.exit(1);
});
