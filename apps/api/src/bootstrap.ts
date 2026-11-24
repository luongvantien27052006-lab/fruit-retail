import 'reflect-metadata';
import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { type AppExtras, AppModule } from './app.module';
import { assertRoutesDeclareAccess } from './common/route-access';
import type { Env } from './config/env';

/** Tạo app HTTP với tiền tố /v1 (§13.1). Dùng chung cho main.ts và test. */
export async function createApp(
  env: Env,
  opts: NestApplicationOptions = {},
  extras: AppExtras = {},
): Promise<INestApplication> {
  const quiet = opts.logger === false;
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env, extras), {
    bufferLogs: !quiet,
    ...opts,
  });
  if (!quiet) app.useLogger(app.get(Logger));
  // Không lộ framework qua header (X-Powered-By: Express).
  app.disable('x-powered-by');
  // IP client: chỉ tin X-Forwarded-For từ proxy trong mạng nội bộ (Caddy ghi đè XFF — Caddyfile, ADR-019)
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.setGlobalPrefix('v1');
  app.enableShutdownHooks();
  // Deny-by-default: route thiếu khai báo quyền ⇒ không khởi động (CP03)
  assertRoutesDeclareAccess(app);
  return app;
}
