import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission, RequireStepUp } from '../common/access';
import { ZodPipe } from '../common/zod.pipe';
import { PricesService } from './prices.service';

/** Tiền trên dây là chuỗi số nguyên (ADR-016); âm / 0 / quá trần ⇒ service trả 422 (cổng lát 3). Số JSON ⇒ 400. */
const vnd = z
  .string()
  .regex(/^-?[0-9]{1,18}$/, 'tiền: chuỗi số nguyên đồng')
  .transform((v) => BigInt(v));
const reason = z.string().trim().min(1).max(500);
const PriceChange = {
  version: z.number().int().min(0),
  global: vnd.optional(),
  stores: z
    .array(z.object({ store_id: z.string().uuid(), price: vnd.nullable() }).strict())
    .max(200)
    .optional(),
  units: z
    .array(z.object({ sku_unit_id: z.string().uuid(), price: vnd.nullable() }).strict())
    .max(20)
    .optional(),
};
const PutPrices = z.object({ reason, ...PriceChange }).strict();
const PutPricesBulk = z
  .object({
    reason,
    items: z
      .array(z.object({ sku_id: z.string().uuid(), ...PriceChange }).strict())
      .min(1)
      .max(500),
  })
  .strict();
const History = z
  .object({
    store_id: z.string().uuid().optional(),
    field: z.enum(['PER_KG', 'PER_UNIT', 'SKU_UNIT']).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    before: z.string().uuid().optional(),
  })
  .strict();
const Effective = z
  .object({
    store_id: z.string().uuid().optional(),
    sku_unit_id: z.string().uuid().optional(),
    at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

/** /v1/admin/prices — giá lẻ chung / theo cửa hàng / theo đơn vị + lịch sử (CP04 lát 3, §4.4). */
@Controller('admin/prices')
export class PricesController {
  constructor(private readonly prices: PricesService) {}

  /** Đổi giá hàng loạt (nhiều SKU một lần) — x-step-up (kế hoạch CP04 lát 3) */
  @RequirePermission('price:write')
  @RequireStepUp()
  @Put()
  putMany(@Body(new ZodPipe(PutPricesBulk)) b: z.infer<typeof PutPricesBulk>) {
    return this.prices.setMany(b.items, b.reason);
  }

  @RequirePermission('price:read')
  @Get(':sku_id')
  current(@Param('sku_id', new ParseUUIDPipe()) id: string) {
    return this.prices.current(id);
  }

  @RequirePermission('price:write')
  @Put(':sku_id')
  put(@Param('sku_id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(PutPrices)) b: z.infer<typeof PutPrices>) {
    const { reason: r, ...change } = b;
    return this.prices.set(id, change, r);
  }

  @RequirePermission('price:read')
  @Get(':sku_id/history')
  history(@Param('sku_id', new ParseUUIDPipe()) id: string, @Query(new ZodPipe(History)) q: z.infer<typeof History>) {
    return this.prices.history(id, q);
  }

  /** Giá hiệu lực tại thời điểm (mặc định bây giờ) — nguồn giá cho dòng bán POS/app; dựng lại từ lịch sử */
  @RequirePermission('price:read')
  @Get(':sku_id/effective')
  effective(
    @Param('sku_id', new ParseUUIDPipe()) id: string,
    @Query(new ZodPipe(Effective)) q: z.infer<typeof Effective>,
  ) {
    return this.prices.effectiveAt(id, { ...q, at: q.at ? new Date(q.at) : undefined });
  }
}
