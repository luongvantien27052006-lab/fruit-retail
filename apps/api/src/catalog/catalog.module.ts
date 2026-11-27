import { Module } from '@nestjs/common';
import { AuditOutboxService } from '../common/audit-outbox.service';
import { CatalogController, SkusController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { PricesController } from './prices.controller';
import { PricesService } from './prices.service';
import { SkusService } from './skus.service';

/** Danh mục: đơn vị tính, cây danh mục, sản phẩm, SKU + đơn vị bán/mua (CP04 lát 2). Giá + lịch sử giá: lát 3. */
@Module({
  controllers: [CatalogController, SkusController, PricesController],
  providers: [CatalogService, SkusService, PricesService, AuditOutboxService],
  exports: [CatalogService, SkusService, PricesService],
})
export class CatalogModule {}
