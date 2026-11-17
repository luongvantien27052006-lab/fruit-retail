import 'reflect-metadata';
import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { Env } from './config/env';

/** Tạo app HTTP với tiền tố /v1 (§13.1). Dùng chung cho main.ts và test. */
export async function createApp(env: Env, opts: NestApplicationOptions = {}): Promise<INestApplication> {
  const quiet = opts.logger === false;
  const app = await NestFactory.create(AppModule.forRoot(env), { bufferLogs: !quiet, ...opts });
  if (!quiet) app.useLogger(app.get(Logger));
  app.setGlobalPrefix('v1');
  app.enableShutdownHooks();
  return app;
}
