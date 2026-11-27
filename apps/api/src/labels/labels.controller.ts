import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { MasterOnly, NoAudit, RequirePermission } from '../common/access';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { optText, text, uuid } from '../org/org-fields';
import { LabelsService } from './labels.service';

const RULE_TYPES = ['WEIGHT', 'PRICE', 'PRODUCT', 'BATCH', 'ORDER', 'STAFF'] as const;
const CODE = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,15}$/, 'mã: chữ HOA/số/_- (tối đa 16)'));
const PATTERN = z.string().trim().min(1).max(64);
const SCALE = z.union([z.literal(1), z.literal(10), z.literal(100)]);
const RuleCreate = z
  .object({
    code: CODE,
    name: text(100),
    priority: z.number().int().min(1).max(10000),
    type: z.enum(RULE_TYPES),
    pattern: PATTERN,
    value_scale: SCALE.default(1),
    ean13_checksum: z.boolean(),
    enabled: z.boolean().default(false),
  })
  .strict();
const RuleUpdate = z
  .object({
    name: text(100).optional(),
    priority: z.number().int().min(1).max(10000).optional(),
    pattern: PATTERN.optional(),
    value_scale: SCALE.optional(),
    ean13_checksum: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'cần ít nhất một trường');
const Decode = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[0-9A-Z-]{1,64}$/, 'mã vạch: 1–64 ký tự số / chữ HOA / -'),
  })
  .strict();
const PluExport = z.object({ store_id: uuid.optional(), format: z.enum(['CSV', 'XLSX']).default('CSV') }).strict();
const BrandUpdate = z
  .object({
    brand_name: text(100).optional(),
    hotline: optText(30),
    display_address: optText(300),
    receipt_footer: optText(300),
    primary_color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'màu #RRGGBB')
      .nullable()
      .optional(),
    privacy_url: z
      .string()
      .max(500)
      .regex(/^https:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]{1,492}$/, 'đường dẫn https://… (ký tự URL hợp lệ)')
      .refine((v) => {
        try {
          const u = new URL(v);
          return u.protocol === 'https:' && u.hostname.includes('.') && !u.username && !u.password;
        } catch {
          return false;
        }
      }, 'đường dẫn https:// có tên miền')
      .nullable()
      .optional(),
    logo_mono_file_id: uuid.nullable().optional(),
    logo_color_file_id: uuid.nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'cần ít nhất một trường');
const ShelfLabels = z
  .object({
    sku_ids: z.array(uuid).min(1).max(500).optional(),
    category_id: uuid.optional(),
    store_id: uuid.optional(),
    layout: z.enum(['A4_24', 'A4_10']).default('A4_24'),
  })
  .strict()
  .refine(
    (q) => (q.sku_ids === undefined) !== (q.category_id === undefined),
    'cần đúng một trong sku_ids / category_id',
  );
/**
 * CSP trang tem: không script, không form, không nhúng vào trang khác, sandbox (origin riêng) — client phải hiển thị trong
 * `<iframe sandbox>` KHÔNG allow-scripts / allow-same-origin, không mở bằng blob: cùng origin (review bảo mật lát 6 N1).
 */
export const LABEL_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox";

/** Quy tắc mã vạch cân, file PLU, thương hiệu, tem giá kệ (CP04 lát 6, NC-26). */
@Controller('admin')
export class LabelsController {
  constructor(
    private readonly labels: LabelsService,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  @RequirePermission('catalog:read')
  @Get('barcode-rules')
  listRules() {
    return this.labels.listRules();
  }

  @RequirePermission('barcode_rule:write')
  @Post('barcode-rules')
  createRule(@Body(new ZodPipe(RuleCreate)) b: z.infer<typeof RuleCreate>) {
    return this.labels.createRule(b);
  }

  /** thử giải mã (khai báo TRƯỚC `:id`) */
  @RequirePermission('catalog:read')
  @Get('barcode-rules/decode')
  decode(@Query(new ZodPipe(Decode)) q: z.infer<typeof Decode>) {
    return this.labels.decode(q.code);
  }

  @RequirePermission('catalog:read')
  @Get('barcode-rules/:id')
  getRule(@Param('id', new ZodPipe(uuid)) id: string) {
    return this.labels.getRule(id);
  }

  @RequirePermission('barcode_rule:write')
  @Patch('barcode-rules/:id')
  updateRule(@Param('id', new ZodPipe(uuid)) id: string, @Body(new ZodPipe(RuleUpdate)) b: z.infer<typeof RuleUpdate>) {
    return this.labels.updateRule(id, b);
  }

  /** file PLU cho cân in tem — chỉ SKU bán qua cân; ghi export_logs */
  @RequirePermission('plu:export', { scope: 'store' })
  @HttpCode(201)
  @Post('plu-export')
  pluExport(@Body(new ZodPipe(PluExport)) b: z.infer<typeof PluExport>) {
    return this.labels.pluExport(b);
  }

  @RequirePermission('catalog:read')
  @Get('brand')
  getBrand() {
    return this.labels.getBrand();
  }

  @RequirePermission('settings:write')
  @MasterOnly()
  @Put('brand')
  updateBrand(@Body(new ZodPipe(BrandUpdate)) b: z.infer<typeof BrandUpdate>) {
    const p = this.cls.get('principal');
    if (!p) throw new AppError('AUTHENTICATION_REQUIRED', 'Cần đăng nhập');
    return this.labels.updateBrand(b, p.userId);
  }

  /** Trang HTML in tem giá kệ (A4). Không script; CSP chỉ cho style nội tuyến. */
  @RequirePermission('price:read', { scope: 'store' })
  @NoAudit('in tem chỉ đọc danh mục + giá, không ghi dữ liệu')
  @HttpCode(200)
  @Post('shelf-labels')
  async shelfLabels(@Body(new ZodPipe(ShelfLabels)) q: z.infer<typeof ShelfLabels>, @Res() res: Response) {
    const out = await this.labels.shelfLabels(q);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', LABEL_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Label-Count', String(out.count));
    res.end(out.html);
  }
}
