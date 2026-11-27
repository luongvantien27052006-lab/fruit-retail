import { Module } from '@nestjs/common';
import { AuditOutboxService } from '../common/audit-outbox.service';
import { ImportsModule } from '../imports/imports.module';
import { LabelsController } from './labels.controller';
import { LabelsService } from './labels.service';

/** Quy tắc mã vạch cân, xuất PLU, thương hiệu, tem giá kệ (CP04 lát 6). */
@Module({
  imports: [ImportsModule],
  controllers: [LabelsController],
  providers: [LabelsService, AuditOutboxService],
})
export class LabelsModule {}
