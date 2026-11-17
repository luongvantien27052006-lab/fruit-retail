import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { ENV, type Env } from './config/env';
import { HealthController } from './health/health.controller';
import { PrismaService } from './infra/prisma.service';
import { RedisService } from './infra/redis.service';

// Log JSON có request_id; che dữ liệu nhạy cảm (§15, ADR-015, FR-INV-18).
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["idempotency-key"]',
  '*.phone',
  '*.address',
  '*.token',
  '*.otp',
  '*.pin',
  '*.password',
  '*.account_number',
];

export const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: env.LOG_LEVEL,
            // Chỉ nhận X-Request-Id đúng dạng; sai/thiếu thì tạo UUID mới (không để client làm rối truy vết).
            genReqId: (req) => {
              const h = req.headers['x-request-id'];
              return typeof h === 'string' && REQUEST_ID_RE.test(h) ? h : randomUUID();
            },
            redact: REDACT_PATHS,
          },
        }),
      ],
      controllers: [HealthController],
      providers: [{ provide: ENV, useValue: env }, PrismaService, RedisService],
    };
  }
}
