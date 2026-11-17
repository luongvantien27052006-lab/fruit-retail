import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { ENV, type Env } from '../config/env';

/** Client Prisma cho role `app_rw` (ADR-003, ADR-011). Client của role khác thêm ở CP03. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    // Có timeout để DB treo không làm cạn pool / treo request vô hạn.
    super({
      adapter: new PrismaPg({
        connectionString: env.DATABASE_URL_APP,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 15_000,
        query_timeout: 20_000,
        idle_in_transaction_session_timeout: 30_000,
      }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
