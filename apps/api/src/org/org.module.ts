import { Module } from '@nestjs/common';
import { AuditOutboxService } from '../common/audit-outbox.service';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

/** Tổ chức (cửa hàng, kho, vị trí, quầy, vị trí mặc định) + danh bạ nhà cung cấp (CP04 lát 4). */
@Module({
  controllers: [OrgController, SuppliersController],
  providers: [OrgService, SuppliersService, AuditOutboxService],
})
export class OrgModule {}
