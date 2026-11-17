import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { loadEnv } from './config/env';
import { WorkerModule } from './worker.module';

/** Entry worker (ADR-002): outbox relay, projector, cron — thêm từ CP03. */
async function main(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(env), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.get(Logger).log('worker đã khởi động (chưa có job — CP03 thêm outbox relay)', 'Worker');
}

main().catch((err: unknown) => {
  console.error('[worker] khởi động thất bại:', err instanceof Error ? err.message : err);
  process.exit(1);
});
