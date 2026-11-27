import { type DynamicModule, Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { REDACT_PATHS, transactionalPlugin } from './app.module';
import type { Env } from './config/env';
import { ImportConsumer } from './imports/import-consumer';
import { ImportProcessor } from './imports/import-processor';
import { ImportsWorkerModule } from './imports/imports.module';
import { InfraModule } from './infra/infra.module';
import { EVENT_CONSUMERS, type EventConsumer } from './infra/outbox/events';

@Module({})
export class WorkerModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        LoggerModule.forRoot({ pinoHttp: { level: env.LOG_LEVEL, redact: REDACT_PATHS } }),
        // env, Prisma, Redis, S3 như API (InfraModule global)
        InfraModule.forRoot(env),
        // CLS + transaction như API (không middleware HTTP) — consumer nhập file dùng lại service nghiệp vụ (CP04 lát 5)
        ClsModule.forRoot({ global: true, plugins: [transactionalPlugin()] }),
        ImportsWorkerModule,
      ],
      providers: [
        // consumer sự kiện: nhập Excel (CP04 lát 5); projection (CP12), thông báo… đăng ký sau (ADR-025)
        {
          provide: EVENT_CONSUMERS,
          useFactory: (p: ImportProcessor): EventConsumer[] => [new ImportConsumer(p)],
          inject: [ImportProcessor],
        },
      ],
    };
  }
}
