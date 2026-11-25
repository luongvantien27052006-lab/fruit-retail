import { Global, Module } from '@nestjs/common';
import { AuditOutboxService } from '../common/audit-outbox.service';
import { ENV, type Env } from '../config/env';
import { AuditWriterService } from '../infra/audit-writer.service';
import { AUTH_KEYS, type AuthKeys, loadAuthKeys } from './auth-config';
import { AuthAttempts } from './auth-attempts';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PiiCipher } from './pii-cipher';
import { PosDeviceController } from './pos-device.controller';
import { PosDeviceService } from './pos-device.service';
import { PRINCIPAL_RESOLVER, PrincipalResolver } from './principal.resolver';
import { StaffAuthService } from './staff-auth.service';
import { AccessTokens } from './tokens';

/**
 * Xác thực (CP03 lát 3 Master/Viewer, lát 4 nhân viên POS + thiết bị). Global để AccessGuard toàn cục lấy được PRINCIPAL_RESOLVER. Khóa đọc lúc khởi tạo module:
 * thiếu/sai ⇒ API không khởi động.
 */
@Global()
@Module({
  controllers: [AuthController, PosDeviceController],
  providers: [
    { provide: AUTH_KEYS, useFactory: (env: Env) => loadAuthKeys(env), inject: [ENV] },
    { provide: PiiCipher, useFactory: (k: AuthKeys) => new PiiCipher(k), inject: [AUTH_KEYS] },
    { provide: AccessTokens, useFactory: (k: AuthKeys) => new AccessTokens(k), inject: [AUTH_KEYS] },
    AuditWriterService,
    AuditOutboxService,
    AuthAttempts,
    AuthService,
    PosDeviceService,
    StaffAuthService,
    PrincipalResolver,
    { provide: PRINCIPAL_RESOLVER, useExisting: PrincipalResolver },
  ],
  exports: [PRINCIPAL_RESOLVER, PiiCipher, AccessTokens, AuditWriterService],
})
export class AuthModule {}
