import { Module } from '@nestjs/common';
import { AuditOutboxService } from '../common/audit-outbox.service';
import { AdminAccountsController } from './admin-accounts.controller';
import { AdminAccountsService } from './admin-accounts.service';
import { AdminController } from './admin.controller';
import { StaffAdminService } from './staff-admin.service';

/** Quản trị nhân viên, vai trò theo phạm vi, hạn mức duyệt (CP03 lát 6 — ADR-024). */
@Module({
  controllers: [AdminController, AdminAccountsController],
  providers: [StaffAdminService, AdminAccountsService, AuditOutboxService],
})
export class AdminModule {}
