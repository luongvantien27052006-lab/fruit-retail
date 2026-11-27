import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { MasterOnly, RequirePermission, RequireStepUp } from '../common/access';
import { ZodPipe } from '../common/zod.pipe';
import { flag, minOne, optText, text, uuid } from './org-fields';
import { SUPPLIER_TYPES, SuppliersService } from './suppliers.service';

const CODE = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/, 'mã NCC: chữ HOA/số/_- (tối đa 32)'));
/** SĐT: kiểm định dạng VN ở service (chuẩn hóa E.164) */
const Phone = z
  .string()
  .trim()
  .min(9)
  .max(20)
  .regex(/^[+\d .()-]+$/, 'số điện thoại');
const BankAccount = z
  .object({
    account_number: z
      .string()
      .transform((v) => v.replace(/[\s.-]/g, ''))
      .pipe(z.string().regex(/^[0-9]{6,20}$/, 'số tài khoản: 6–20 chữ số')),
    account_holder: text(100).transform((v) => v.toUpperCase()),
  })
  .strict();
const fields = {
  name: text(200),
  type: z.enum(SUPPLIER_TYPES),
  contact_name: optText(100),
  phone: Phone.nullable().optional(),
  bank_name: optText(100),
  bank_account: BankAccount.nullable().optional(),
  payment_terms_days: z.number().int().min(0).max(365).nullable().optional(),
  note: optText(2000),
};
const SupplierCreate = z.object({ code: CODE, ...fields }).strict();
const SupplierUpdate = z
  .object({
    ...fields,
    name: fields.name.optional(),
    type: fields.type.optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine(minOne, 'cần ít nhất một trường');
const SupplierList = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    type: z.enum(SUPPLIER_TYPES).optional(),
    include_archived: flag.default(false),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    after: CODE.optional(),
  })
  .strict();
const SkuLink = z.object({ supplier_sku_code: optText(64).transform((v) => v ?? null) }).strict();

/** /v1/admin/suppliers — danh bạ nhà cung cấp (CP04 lát 4, §4.5, NC-27). Công nợ / phiếu nhận / giá NCC: CP05. */
@Controller('admin/suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @RequirePermission('supplier:read')
  @Get()
  list(@Query(new ZodPipe(SupplierList)) q: z.infer<typeof SupplierList>) {
    return this.suppliers.list(q);
  }

  @RequirePermission('supplier:write')
  @Post()
  create(@Body(new ZodPipe(SupplierCreate)) b: z.infer<typeof SupplierCreate>) {
    return this.suppliers.create(b);
  }

  @RequirePermission('supplier:read')
  @Get(':id')
  get(@Param('id', new ZodPipe(uuid)) id: string) {
    return this.suppliers.get(id);
  }

  @RequirePermission('supplier:write')
  @Patch(':id')
  update(
    @Param('id', new ZodPipe(uuid)) id: string,
    @Body(new ZodPipe(SupplierUpdate)) b: z.infer<typeof SupplierUpdate>,
  ) {
    return this.suppliers.update(id, b);
  }

  /** số tài khoản đầy đủ — chỉ Master, cần step-up; ghi audit `supplier.bank_reveal` */
  @RequirePermission('supplier:write')
  @MasterOnly()
  @RequireStepUp()
  @HttpCode(200)
  @Post(':id/bank-account/reveal')
  revealBank(@Param('id', new ZodPipe(uuid)) id: string) {
    return this.suppliers.revealBank(id);
  }

  @RequirePermission('supplier:read')
  @Get(':id/skus')
  listSkus(@Param('id', new ZodPipe(uuid)) id: string) {
    return this.suppliers.listSkus(id);
  }

  @RequirePermission('supplier:write')
  @Put(':id/skus/:sku_id')
  setSku(
    @Param('id', new ZodPipe(uuid)) id: string,
    @Param('sku_id', new ZodPipe(uuid)) skuId: string,
    @Body(new ZodPipe(SkuLink)) b: z.infer<typeof SkuLink>,
  ) {
    return this.suppliers.setSku(id, skuId, b.supplier_sku_code);
  }

  @RequirePermission('supplier:write')
  @Delete(':id/skus/:sku_id')
  removeSku(@Param('id', new ZodPipe(uuid)) id: string, @Param('sku_id', new ZodPipe(uuid)) skuId: string) {
    return this.suppliers.removeSku(id, skuId);
  }
}
