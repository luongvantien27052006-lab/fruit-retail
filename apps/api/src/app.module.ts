import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import type { IncomingMessage } from 'node:http';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { OrgModule } from './org/org.module';
import { ImportsModule } from './imports/imports.module';
import { FilesModule } from './files/files.controller';
import { AccessGuard } from './common/access.guard';
import { AuditOutboxService } from './common/audit-outbox.service';
import { ErrorFilter } from './common/error.filter';
import { MutationInterceptor } from './common/mutation.interceptor';
import { DEFAULT_RATE_POLICIES, RATE_POLICIES, RateLimitGuard } from './common/rate-limit';
import { DEVICE_ID_RE, type RequestStore, resolveRequestId } from './common/request-context';
import { SerializeInterceptor } from './common/serialize.interceptor';
import type { Env } from './config/env';
import { HealthController } from './health/health.controller';
import { InfraModule } from './infra/infra.module';
import { TX_PRISMA } from './infra/tx-prisma';

// Log JSON có request_id; che dữ liệu nhạy cảm (§15, ADR-015, FR-INV-18).
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-device-id"]',
  'req.headers["idempotency-key"]',
  '*.phone',
  '*.address',
  '*.token',
  '*.temporary_password',
  '*.otp',
  '*.pin',
  '*.password',
  '*.account_number',
  '*.accountNumber',
  '*.secret',
  '*.api_key',
  '*.totp_secret',
  '*.access_token',
  '*.refresh_token',
  '*.*.phone',
  '*.*.password',
  '*.*.token',
  '*.*.temporary_password',
  '*.refresh_token',
  '*.mfa_challenge',
  '*.recovery_code',
  '*.recovery_codes',
  '*.code',
];

export { REQUEST_ID_RE, resolveRequestId } from './common/request-context';

/** Plugin transaction CLS dùng chung API + worker (ADR-016) */
export const transactionalPlugin = () =>
  new ClsPluginTransactional({
    imports: [InfraModule],
    adapter: new TransactionalAdapterPrisma({
      prismaInjectionToken: TX_PRISMA,
      // Khớp timeout của pg (statement_timeout 15 s, PrismaService): transaction tối đa 20 s, chờ kết nối 5 s
      defaultTxOptions: { timeout: 20_000, maxWait: 5_000, isolationLevel: 'ReadCommitted' },
    }),
  });

export interface AppExtras {
  /** chỉ dùng trong test: module/controller bổ sung */
  imports?: (Type | DynamicModule)[];
  controllers?: Type[];
  providers?: Provider[];
}

@Module({})
export class AppModule {
  static forRoot(env: Env, extras: AppExtras = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: env.LOG_LEVEL,
            // Chỉ nhận X-Request-Id đúng dạng; sai/thiếu thì tạo UUID mới (không để client làm rối truy vết).
            genReqId: (req) => resolveRequestId(req),
            redact: REDACT_PATHS,
          },
        }),
        InfraModule.forRoot(env),
        ClsModule.forRoot({
          global: true,
          middleware: {
            mount: true,
            setup: (cls, req: IncomingMessage & { id?: unknown; ip?: string }) => {
              const store = cls as unknown as { set<K extends keyof RequestStore>(k: K, v: RequestStore[K]): void };
              store.set('requestId', resolveRequestId(req));
              if (req.ip) store.set('ip', req.ip);
              const dev = req.headers['x-device-id'];
              if (typeof dev === 'string' && DEVICE_ID_RE.test(dev)) store.set('deviceId', dev);
              const ua = req.headers['user-agent'];
              if (typeof ua === 'string' && ua) store.set('userAgent', ua.slice(0, 512));
              store.set('auditCount', 0);
            },
          },
          plugins: [transactionalPlugin()],
        }),
        DiscoveryModule,
        AuthModule,
        AdminModule,
        CatalogModule,
        OrgModule,
        FilesModule,
        ImportsModule,
        ...(extras.imports ?? []),
      ],
      controllers: [HealthController, ...(extras.controllers ?? [])],
      providers: [
        AuditOutboxService,
        { provide: APP_FILTER, useClass: ErrorFilter },
        { provide: RATE_POLICIES, useValue: DEFAULT_RATE_POLICIES },
        // giới hạn tần suất TRƯỚC xác thực: request vượt ngưỡng không chạm DB
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_GUARD, useClass: AccessGuard },
        // Thứ tự: Mutation (ngoài, mở transaction) → Serialize (trong) — lỗi tuần tự hóa cũng rollback
        { provide: APP_INTERCEPTOR, useClass: MutationInterceptor },
        { provide: APP_INTERCEPTOR, useClass: SerializeInterceptor },
        ...(extras.providers ?? []),
      ],
      exports: [AuditOutboxService],
    };
  }
}
