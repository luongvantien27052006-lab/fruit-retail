import { Global, Module } from '@nestjs/common';
import { AuditOutboxService } from '../common/audit-outbox.service';
import { ENV, type Env } from '../config/env';
import { AuditWriterService } from '../infra/audit-writer.service';
import { AUTH_KEYS, type AuthKeys, loadAuthKeys } from './auth-config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PiiCipher } from './pii-cipher';
import { PRINCIPAL_RESOLVER, PrincipalResolver } from './principal.resolver';
import { AccessTokens } from './tokens';

/**
 * Xác thực (CP03 lát 3). Global để AccessGuard toàn cục lấy được PRINCIPAL_RESOLVER. Khóa đọc lúc khởi tạo module:
 * thiếu/sai ⇒ API không khởi động.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    { provide: AUTH_KEYS, useFactory: (env: Env) => loadAuthKeys(env), inject: [ENV] },
    { provide: PiiCipher, useFactory: (k: AuthKeys) => new PiiCipher(k), inject: [AUTH_KEYS] },
    { provide: AccessTokens, useFactory: (k: AuthKeys) => new AccessTokens(k), inject: [AUTH_KEYS] },
    AuditWriterService,
    AuditOutboxService,
    AuthService,
    PrincipalResolver,
    { provide: PRINCIPAL_RESOLVER, useExisting: PrincipalResolver },
  ],
  exports: [PRINCIPAL_RESOLVER, PiiCipher, AccessTokens, AuditWriterService],
})
export class AuthModule {}
