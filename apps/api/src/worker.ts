import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { loadEnv } from './config/env';
import { PrismaService } from './infra/prisma.service';
import { RedisService } from './infra/redis.service';
import { WorkerModule } from './worker.module';

const HEARTBEAT_MS = 30_000;

/** Entry worker (ADR-002): outbox relay, projector, cron — thêm từ CP03. Hiện chỉ có heartbeat. */
async function main(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(env), { bufferLogs: true });
  const log = app.get(Logger);
  app.useLogger(log);
  app.enableShutdownHooks();

  const prisma = app.get(PrismaService);
  const redis = app.get(RedisService).client;
  const beat = async (): Promise<void> => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
      await redis.ping();
    } catch (err) {
      // Không nuốt lỗi: ghi error để giám sát thấy; process vẫn sống để tự hồi phục khi phụ thuộc quay lại.
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'worker heartbeat: phụ thuộc lỗi');
    }
  };
  await beat();
  const timer = setInterval(() => void beat(), HEARTBEAT_MS);
  const stop = async (): Promise<void> => {
    clearInterval(timer);
    await app.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  log.log('worker đã khởi động (heartbeat 30 s; CP03 thêm outbox relay)', 'Worker');
}

main().catch((err: unknown) => {
  console.error('[worker] khởi động thất bại:', err instanceof Error ? err.message : err);
  process.exit(1);
});
