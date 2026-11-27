import { Module } from '@nestjs/common';
import { AUTH_KEYS, type AuthKeys, loadAuthKeys } from '../auth/auth-config';
import { PiiCipher } from '../auth/pii-cipher';
import { CatalogModule } from '../catalog/catalog.module';
import { CatalogService } from '../catalog/catalog.service';
import { PricesService } from '../catalog/prices.service';
import { SkusService } from '../catalog/skus.service';
import { AuditOutboxService } from '../common/audit-outbox.service';
import { ScopeService } from '../common/scope.service';
import { ENV, type Env } from '../config/env';
import { OrgModule } from '../org/org.module';
import { SuppliersService } from '../org/suppliers.service';
import { ImportProcessor } from './import-processor';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

/** Nhập / xuất Excel phía API (CP04 lát 5). ImportProcessor cũng có ở đây để test gọi trực tiếp. */
@Module({
  imports: [CatalogModule, OrgModule],
  controllers: [ImportsController],
  providers: [ImportsService, ImportProcessor, AuditOutboxService],
  exports: [ImportsService],
})
export class ImportsModule {}

/**
 * Worker (ADR-002/031): chỉ provider cần để chạy lượt nhập — không controller, không AuthModule (OTP / token không dùng ở
 * worker). Khóa PII đọc từ env như API (thiếu ⇒ worker không khởi động).
 */
@Module({
  providers: [
    { provide: AUTH_KEYS, useFactory: (env: Env) => loadAuthKeys(env), inject: [ENV] },
    { provide: PiiCipher, useFactory: (k: AuthKeys) => new PiiCipher(k), inject: [AUTH_KEYS] },
    ScopeService,
    AuditOutboxService,
    CatalogService,
    SkusService,
    PricesService,
    SuppliersService,
    ImportProcessor,
  ],
  exports: [ImportProcessor],
})
export class ImportsWorkerModule {}
