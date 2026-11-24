import { type DynamicModule, Global, Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';

/** Hạ tầng dùng chung (env, Prisma app_rw, Redis) — global để plugin transaction và module nghiệp vụ cùng dùng. */
@Global()
@Module({})
export class InfraModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: InfraModule,
      providers: [{ provide: ENV, useValue: env }, PrismaService, RedisService],
      exports: [ENV, PrismaService, RedisService],
    };
  }
}
