import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { REDACT_PATHS } from './app.module';
import { ENV, type Env } from './config/env';
import { PrismaService } from './infra/prisma.service';
import { RedisService } from './infra/redis.service';

@Module({})
export class WorkerModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: WorkerModule,
      imports: [LoggerModule.forRoot({ pinoHttp: { level: env.LOG_LEVEL, redact: REDACT_PATHS } })],
      providers: [{ provide: ENV, useValue: env }, PrismaService, RedisService],
    };
  }
}
