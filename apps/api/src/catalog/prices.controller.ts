import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { MasterOnly, RequirePermission, RequireStepUp } from '../common/access';
import { ZodPipe } from '../common/zod.pipe';
import { PricesService } from './prices.service';

/** Tiền trên dây là chuỗi số nguyên (ADR-016); âm / 0 / quá trần ⇒ service trả 422 (cổng lát 3). Số JSON ⇒ 400. */
const vnd = z
  .string()
  .regex(/^-?[0-9]{1,18}$/, 'tiền: chuỗi số nguyên đồng')
  .transform((v) => BigInt(v));
/** ký tự điều khiển (C0 trừ tab / xuống dòng, DEL, C1), ký tự đảo chiều chữ, ngắt dòng/đoạn Unicode */
const isControl = (c: string) => {
  const n = c.charCodeAt(0);
  return (
    (n < 32 && n !== 9 && n !== 10 && n !== 13) ||
    (n >= 0x7f && n <= 0x9f) || // DEL + C1
    (n >= 0x202a && n <= 0x202e) || // điều khiển chiều chữ (bidi) — review bảo mật G7
    (n >= 0x2066 && n <= 0x2069) ||
    n === 0x2028 ||
    n === 0x2029
  );
};
/** chữ tự do: cấm ký tự điều khiển (NUL ⇒ PostgreSQL lỗi 500 — review bảo mật lát 3 G1) */
const reason = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((v) => ![...v].some(isControl), 'không chứa ký tự điều khiển');
/** UUID chuẩn hóa chữ thường (so trùng / so khớp id — G2) */
const uuid = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
/** Trần tổng số khóa giá trong một yêu cầu (giá chung + cửa hàng + đơn vị) — giữ transaction ngắn (G3, N1) */
export const MAX_PRICE_KEYS = 2000;
const keys = (i: { global?: unknown; stores?: unknown[]; units?: unknown[] }) =>
  (i.global !== undefined ? 1 : 0) + (i.stores?.length ?? 0) + (i.units?.length ?? 0);
const PriceChange = {
  version: z.number().int().min(0),
  /** null = không đặt (client sinh mã gửi null cho trường trống; giá chung không bỏ được) */
  global: vnd.nullish().transform((v) => v ?? undefined),
  stores: z
    .array(z.object({ store_id: uuid, price: vnd.nullable() }).strict())
    .max(200)
    .nullish()
    .transform((v) => v ?? undefined),
  units: z
    .array(z.object({ sku_unit_id: uuid, price: vnd.nullable() }).strict())
    .max(20)
    .nullish()
    .transform((v) => v ?? undefined),
};
const PutPrices = z
  .object({ reason, ...PriceChange })
  .strict()
  .refine((b) => keys(b) <= MAX_PRICE_KEYS, `tối đa ${MAX_PRICE_KEYS} giá mỗi yêu cầu`);
const PutPricesBulk = z
  .object({
    reason,
    items: z
      .array(z.object({ sku_id: uuid, ...PriceChange }).strict())
      .min(1)
      .max(500),
  })
  .strict()
  .refine((b) => b.items.reduce((n, i) => n + keys(i), 0) <= MAX_PRICE_KEYS, `tối đa ${MAX_PRICE_KEYS} giá mỗi lô`);
const History = z
  .object({
    store_id: uuid.optional(),
    field: z.enum(['PER_KG', 'PER_UNIT', 'SKU_UNIT']).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    before: uuid.optional(),
  })
  .strict();
const Effective = z
  .object({
    store_id: uuid.optional(),
    sku_unit_id: uuid.optional(),
    // năm 2000–9999: PostgreSQL không có năm 0 (22008 ⇒ 500 — review TS lát 3 vòng 2)
    at: z.iso
      .datetime({ offset: true })
      .refine((v) => /^[2-9]\d{3}-/.test(v), 'năm từ 2000 đến 9999')
      .optional(),
  })
  .strict();

/** /v1/admin/prices — giá lẻ chung / theo cửa hàng / theo đơn vị + lịch sử (CP04 lát 3, §4.4). */
@Controller('admin/prices')
export class PricesController {
  constructor(private readonly prices: PricesService) {}

  /** Đổi giá hàng loạt (nhiều SKU một lần) — x-step-up (kế hoạch CP04 lát 3) */
  @RequirePermission('price:write')
  @MasterOnly()
  @RequireStepUp()
  @Put()
  putMany(@Body(new ZodPipe(PutPricesBulk)) b: z.infer<typeof PutPricesBulk>) {
    return this.prices.setMany(b.items, b.reason);
  }

  @RequirePermission('price:read', { scope: 'store' })
  @Get(':sku_id')
  current(@Param('sku_id', new ZodPipe(uuid)) id: string) {
    return this.prices.current(id);
  }

  /** SPEC §2.2: chỉ Master sửa giá bán lẻ (vai trò khác chỉ xem) — chặn cả mã price:write cấp riêng (review bảo mật N2) */
  @RequirePermission('price:write')
  @MasterOnly()
  @Put(':sku_id')
  put(@Param('sku_id', new ZodPipe(uuid)) id: string, @Body(new ZodPipe(PutPrices)) b: z.infer<typeof PutPrices>) {
    const { reason: r, ...change } = b;
    return this.prices.set(id, change, r);
  }

  /** lịch sử có lý do (chữ tự do) + người đổi ⇒ chỉ Master (màn A10) — review bảo mật N3 */
  @RequirePermission('price:read')
  @MasterOnly()
  @Get(':sku_id/history')
  history(@Param('sku_id', new ZodPipe(uuid)) id: string, @Query(new ZodPipe(History)) q: z.infer<typeof History>) {
    return this.prices.history(id, q);
  }

  /** Giá hiệu lực tại thời điểm (mặc định bây giờ) — nguồn giá cho dòng bán POS/app; dựng lại từ lịch sử */
  @RequirePermission('price:read', { scope: 'store' })
  @Get(':sku_id/effective')
  effective(
    @Param('sku_id', new ZodPipe(uuid)) id: string,
    @Query(new ZodPipe(Effective)) q: z.infer<typeof Effective>,
  ) {
    return this.prices.effectiveAt(id, q);
  }
}
