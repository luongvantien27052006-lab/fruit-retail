import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../common/access';
import { ZodPipe } from '../common/zod.pipe';
import { SALE_UNIT_TYPES } from './catalog-rules';
import { CatalogService } from './catalog.service';
import { SkusService } from './skus.service';

// ───────── kiểu dùng chung ─────────

/** chuỗi có nội dung; bỏ khoảng trắng hai đầu */
const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));
const flag = z.enum(['true', 'false']).transform((v) => v === 'true');
const minOne = (b: object) => Object.keys(b).length > 0;
const intIn = (lo: number, hi: number) => z.number().int().min(lo).max(hi);

const UNIT_CODE = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z][A-Z0-9_]{0,15}$/, 'mã đơn vị: chữ HOA/số/_ (tối đa 16), bắt đầu bằng chữ'));
const SKU_CODE = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_.-]{0,31}$/, 'mã SKU: chữ HOA/số/_.- (tối đa 32)'));
const BARCODE = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(
    z
      .string()
      .regex(/^[0-9A-Z-]{4,32}$/, 'mã vạch: 4–32 ký tự số/chữ HOA/-')
      .refine((v) => !/^2[0-9]{12}$/.test(v), 'mã 13 số bắt đầu bằng 2 dành cho tem cân / tem nội bộ'),
  );
const PLU = z
  .string()
  .regex(/^[0-9]{5}$/, 'PLU 5 chữ số')
  .refine((v) => v !== '00000', 'PLU khác 00000');

// ───────── đơn vị tính ─────────

const UnitCreate = z
  .object({
    code: UNIT_CODE,
    name: text(50),
    kind: z.enum(['WEIGHT', 'COUNT']),
    fixed_g: intIn(1, 1_000_000).nullable().optional(),
  })
  .strict();
const UnitUpdate = z
  .object({ name: text(50).optional(), archived: z.boolean().optional() })
  .strict()
  .refine(minOne, 'cần ít nhất một trường');
const ListArchived = z.object({ include_archived: flag.default(false) }).strict();

// ───────── danh mục / sản phẩm ─────────

const CategoryCreate = z
  .object({ parent_id: z.string().uuid().nullable().optional(), name: text(100), sort: intIn(0, 1_000_000).optional() })
  .strict();
const CategoryUpdate = z
  .object({
    parent_id: z.string().uuid().nullable().optional(),
    name: text(100).optional(),
    sort: intIn(0, 1_000_000).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine(minOne, 'cần ít nhất một trường');
const ProductCreate = z
  .object({
    category_id: z.string().uuid(),
    name: text(200),
    description: optText(2000),
    origin: optText(100),
  })
  .strict();
const ProductUpdate = z
  .object({
    category_id: z.string().uuid().optional(),
    name: text(200).optional(),
    description: optText(2000),
    origin: optText(100),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine(minOne, 'cần ít nhất một trường');
const ProductList = z
  .object({
    category_id: z.string().uuid().optional(),
    include_archived: flag.default(false),
    q: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

// ───────── SKU ─────────

const grams = intIn(1, 100_000).nullable().optional();
const days = (lo: number) => intIn(lo, 3650).nullable().optional();
const SkuAttrs = {
  std_weight_g: grams,
  weight_min_g: grams,
  weight_max_g: grams,
  tare_g: intIn(0, 20_000).nullable().optional(),
  scale_plu: PLU.nullable().optional(),
  sold_by_scale: z.boolean().optional(),
  shelf_life_days: days(1),
  storage_note: optText(500),
  has_ripeness: z.boolean().optional(),
  shrink_norm_bps_week: intIn(0, 10_000).nullable().optional(),
  is_high_value: z.boolean().optional(),
  cold_required: z.boolean().optional(),
  alert_days_before_expiry: days(0),
  stop_app_days_before_expiry: days(0),
};
const SkuUnitCreate = z
  .object({
    unit_code: UNIT_CODE,
    name: text(100),
    factor_g: intIn(1, 1_000_000).nullable().optional(),
    factor_units: intIn(1, 100_000).nullable().optional(),
    is_variable: z.boolean().optional(),
    for_sale: z.boolean(),
    for_purchase: z.boolean(),
    barcode: BARCODE.nullable().optional(),
  })
  .strict();
const SkuCreate = z
  .object({
    product_id: z.string().uuid(),
    sku_code: SKU_CODE,
    name: text(200),
    sale_unit_type: z.enum(SALE_UNIT_TYPES),
    barcode: BARCODE.nullable().optional(),
    base_unit_code: UNIT_CODE.optional(),
    units: z.array(SkuUnitCreate).max(20).optional(),
    ...SkuAttrs,
  })
  .strict();
const SkuUpdate = z
  .object({
    version: z.number().int().min(0),
    product_id: z.string().uuid().optional(),
    name: text(200).optional(),
    archived: z.boolean().optional(),
    ...SkuAttrs,
  })
  .strict()
  .refine((b) => Object.keys(b).length > 1, 'cần ít nhất một trường ngoài version');
const SkuUnitUpdate = z
  .object({
    name: text(100).optional(),
    for_sale: z.boolean().optional(),
    for_purchase: z.boolean().optional(),
    barcode: BARCODE.nullable().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine(minOne, 'cần ít nhất một trường');
const SkuList = z
  .object({
    product_id: z.string().uuid().optional(),
    sale_unit_type: z.enum(SALE_UNIT_TYPES).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    include_archived: flag.default(false),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    after: SKU_CODE.optional(),
  })
  .strict();

/** /v1/admin/units, /admin/categories, /admin/products — CP04 lát 2 (§4.1, §21.3.1). Danh mục dùng chung toàn chuỗi. */
@Controller('admin')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @RequirePermission('catalog:read')
  @Get('units')
  listUnits(@Query(new ZodPipe(ListArchived)) q: z.infer<typeof ListArchived>) {
    return this.catalog.listUnits(q.include_archived);
  }

  @RequirePermission('unit:write')
  @Post('units')
  @HttpCode(201)
  createUnit(@Body(new ZodPipe(UnitCreate)) b: z.infer<typeof UnitCreate>) {
    return this.catalog.createUnit(b);
  }

  @RequirePermission('catalog:read')
  @Get('units/:code')
  getUnit(@Param('code', new ZodPipe(UNIT_CODE)) code: string) {
    return this.catalog.getUnit(code);
  }

  @RequirePermission('unit:write')
  @Patch('units/:code')
  updateUnit(
    @Param('code', new ZodPipe(UNIT_CODE)) code: string,
    @Body(new ZodPipe(UnitUpdate)) b: z.infer<typeof UnitUpdate>,
  ) {
    return this.catalog.updateUnit(code, b);
  }

  @RequirePermission('catalog:read')
  @Get('categories')
  listCategories(@Query(new ZodPipe(ListArchived)) q: z.infer<typeof ListArchived>) {
    return this.catalog.listCategories(q.include_archived);
  }

  @RequirePermission('catalog:write')
  @Post('categories')
  @HttpCode(201)
  createCategory(@Body(new ZodPipe(CategoryCreate)) b: z.infer<typeof CategoryCreate>) {
    return this.catalog.createCategory(b);
  }

  @RequirePermission('catalog:read')
  @Get('categories/:id')
  getCategory(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.catalog.getCategory(id);
  }

  @RequirePermission('catalog:write')
  @Patch('categories/:id')
  updateCategory(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(CategoryUpdate)) b: z.infer<typeof CategoryUpdate>,
  ) {
    return this.catalog.updateCategory(id, b);
  }

  @RequirePermission('catalog:read')
  @Get('products')
  listProducts(@Query(new ZodPipe(ProductList)) q: z.infer<typeof ProductList>) {
    return this.catalog.listProducts(q);
  }

  @RequirePermission('catalog:write')
  @Post('products')
  @HttpCode(201)
  createProduct(@Body(new ZodPipe(ProductCreate)) b: z.infer<typeof ProductCreate>) {
    return this.catalog.createProduct(b);
  }

  @RequirePermission('catalog:read')
  @Get('products/:id')
  getProduct(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.catalog.getProduct(id);
  }

  @RequirePermission('catalog:write')
  @Patch('products/:id')
  updateProduct(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(ProductUpdate)) b: z.infer<typeof ProductUpdate>,
  ) {
    return this.catalog.updateProduct(id, b);
  }
}

/** /v1/admin/skus (+ đơn vị bán/mua của SKU — NC-29, ngoài §13.2) — CP04 lát 2 (§4.3, §21.3.1). */
@Controller('admin/skus')
export class SkusController {
  constructor(private readonly skus: SkusService) {}

  @RequirePermission('catalog:read')
  @Get()
  list(@Query(new ZodPipe(SkuList)) q: z.infer<typeof SkuList>) {
    return this.skus.list(q);
  }

  @RequirePermission('catalog:write')
  @Post()
  @HttpCode(201)
  create(@Body(new ZodPipe(SkuCreate)) b: z.infer<typeof SkuCreate>) {
    return this.skus.create(b);
  }

  @RequirePermission('catalog:read')
  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.skus.get(id);
  }

  @RequirePermission('catalog:write')
  @Patch(':id')
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(SkuUpdate)) b: z.infer<typeof SkuUpdate>) {
    return this.skus.update(id, b);
  }

  @RequirePermission('catalog:write')
  @Post(':id/units')
  @HttpCode(201)
  createUnit(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(SkuUnitCreate)) b: z.infer<typeof SkuUnitCreate>,
  ) {
    return this.skus.createUnit(id, b);
  }

  @RequirePermission('catalog:write')
  @Patch(':id/units/:unit_id')
  updateUnit(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('unit_id', new ParseUUIDPipe()) unitId: string,
    @Body(new ZodPipe(SkuUnitUpdate)) b: z.infer<typeof SkuUnitUpdate>,
  ) {
    return this.skus.updateUnit(id, unitId, b);
  }
}
