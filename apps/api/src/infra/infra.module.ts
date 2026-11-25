import { type DynamicModule, Global, Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ENV, type Env } from '../config/env';
import { PrismaService } from './prisma.service';
import { RateLimiter } from './rate-limiter.service';
import { RedisService } from './redis.service';
import { guardedPrisma, TX_PRISMA } from './tx-prisma';

/**
 * Hạ tầng dùng chung (env, Prisma app_rw, Redis) — global để plugin transaction và module nghiệp vụ cùng dùng.
 * Nghiệp vụ truy cập DB qua `TransactionHost` (client TX_PRISMA có chặn ghi ngoài transaction); `PrismaService` thô chỉ
 * cho hạ tầng (health, kết nối) — lint cấm import ngoài src/infra, src/health.
 */
@Global()
@Module({})
export class InfraModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: InfraModule,
      providers: [
        { provide: ENV, useValue: env },
        PrismaService,
        RedisService,
        RateLimiter,
        {
          provide: TX_PRISMA,
          // TransactionHost của plugin cần TX_PRISMA ⇒ lấy lười qua ModuleRef (tránh phụ thuộc vòng)
          useFactory: (p: PrismaService, ref: ModuleRef) => {
            let host: TransactionHost | undefined;
            return guardedPrisma(p, () => {
              const h: TransactionHost = host ?? ref.get(TransactionHost, { strict: false });
              host = h;
              return h;
            });
          },
          inject: [PrismaService, ModuleRef],
        },
      ],
      exports: [ENV, PrismaService, RedisService, RateLimiter, TX_PRISMA],
    };
  }
}
