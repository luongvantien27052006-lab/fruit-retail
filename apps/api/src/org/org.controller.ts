import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../common/access';
import { ZodPipe } from '../common/zod.pipe';
import { flag, minOne, optText, text, uuid } from './org-fields';
import { OrgService } from './org.service';

// ───────── kiểu dùng chung ─────────

/** mã cửa hàng / kho / quầy (CHECK 0001: tối đa 16) */
const CODE16 = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,15}$/, 'mã: chữ HOA/số/_- (tối đa 16)'));
/** mã vị trí (CHECK 0009: tối đa 32); 'IN_TRANSIT' dành cho vị trí hệ thống */
const CODE32 = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(
    z
      .string()
      .regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/, 'mã: chữ HOA/số/_- (tối đa 32)')
      .refine((v) => !v.startsWith('IN_TRANSIT'), 'mã IN_TRANSIT… dành cho vị trí "đang vận chuyển"'),
  );

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HHMM_END = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
/** khung giờ trong ngày: bắt đầu < kết thúc, tăng dần, không chồng nhau, tối đa 3 khung */
const dayHours = z
  .array(z.tuple([z.string().regex(HHMM, 'giờ HH:MM'), z.string().regex(HHMM_END, 'giờ HH:MM (tối đa 24:00)')]))
  .max(3)
  .refine((iv) => iv.every(([a, b], i) => a < b && (i === 0 || (iv[i - 1]?.[1] ?? '') <= a)), {
    message: 'khung giờ: bắt đầu < kết thúc, tăng dần, không chồng nhau',
  });
const OpeningHours = z.partialRecord(z.enum(DAYS), dayHours);
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
/** tọa độ đi cặp (CHECK stores_latlng) */
const latLngPair = (b: { lat?: number | null; lng?: number | null }) =>
  (b.lat === undefined) === (b.lng === undefined) && (b.lat === null) === (b.lng === null);

// ───────── cửa hàng / kho ─────────

const StoreCreate = z
  .object({
    code: CODE16,
    name: text(100),
    address: optText(300),
    lat: lat.nullable().optional(),
    lng: lng.nullable().optional(),
    opening_hours: OpeningHours.nullable().optional(),
    app_capacity_per_hour: z.number().int().min(0).max(10000).nullable().optional(),
  })
  .strict()
  .refine(latLngPair, { message: 'lat và lng đi cặp', path: ['lat'] });
const StoreUpdate = z
  .object({
    name: text(100).optional(),
    address: optText(300),
    lat: lat.nullable().optional(),
    lng: lng.nullable().optional(),
    opening_hours: OpeningHours.nullable().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    pos_status: z.enum(['OPEN', 'CLOSED']).optional(),
    app_status: z.enum(['ONLINE', 'PAUSED']).optional(),
    app_capacity_per_hour: z.number().int().min(0).max(10000).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine(minOne, 'cần ít nhất một trường')
  .refine(latLngPair, { message: 'lat và lng đi cặp', path: ['lat'] });
const WarehouseCreate = z.object({ code: CODE16, name: text(100), address: optText(300) }).strict();
const WarehouseUpdate = z
  .object({ name: text(100).optional(), address: optText(300), archived: z.boolean().optional() })
  .strict()
  .refine(minOne, 'cần ít nhất một trường');
const ListArchived = z.object({ include_archived: flag.default(false) }).strict();

// ───────── vị trí / quầy / vị trí mặc định ─────────

const LOCATION_KINDS = ['STORAGE', 'COLD_ROOM', 'SHELF', 'CHILLER', 'RIPENING'] as const;
const oneOwner = (b: { store_id?: string; warehouse_id?: string }) =>
  (b.store_id === undefined) !== (b.warehouse_id === undefined);
const LocationList = z
  .object({
    store_id: uuid.optional(),
    warehouse_id: uuid.optional(),
    type: z.enum([...LOCATION_KINDS, 'IN_TRANSIT']).optional(),
    include_archived: flag.default(false),
  })
  .strict()
  .refine(oneOwner, 'cần đúng một trong store_id / warehouse_id');
const LocationCreate = z
  .object({
    store_id: uuid.optional(),
    warehouse_id: uuid.optional(),
    type: z.enum(LOCATION_KINDS),
    code: CODE32,
    name: text(100),
    sort: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict()
  .refine(oneOwner, 'cần đúng một trong store_id / warehouse_id');
const LocationUpdate = z
  .object({
    name: text(100).optional(),
    sort: z.number().int().min(0).max(1_000_000).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine(minOne, 'cần ít nhất một trường');
const RegisterCreate = z.object({ code: CODE16, name: optText(100) }).strict();
const RegisterUpdate = z
  .object({ code: CODE16.optional(), name: optText(100), archived: z.boolean().optional() })
  .strict()
  .refine(minOne, 'cần ít nhất một trường');
const DefaultList = z.object({ sku_id: uuid.optional() }).strict();
const DefaultSet = z.object({ location_id: uuid.nullable() }).strict();

/** /v1/admin/stores, /warehouses, /locations, /registers — tổ chức (CP04 lát 4, §4.6, §21.3.19). */
@Controller('admin')
export class OrgController {
  constructor(private readonly org: OrgService) {}

  // ── cửa hàng ──
  @RequirePermission('report:read', { scope: 'store' })
  @Get('stores')
  listStores(@Query(new ZodPipe(ListArchived)) q: z.infer<typeof ListArchived>) {
    return this.org.listStores(q.include_archived);
  }

  /** tạo cửa hàng: cần phạm vi ALL của store:write (service kiểm) */
  @RequirePermission('store:write', { scope: 'store' })
  @Post('stores')
  createStore(@Body(new ZodPipe(StoreCreate)) b: z.infer<typeof StoreCreate>) {
    return this.org.createStore(b);
  }

  @RequirePermission('report:read', { scope: 'store' })
  @Get('stores/:id')
  getStore(@Param('id', new ZodPipe(uuid)) id: string) {
    return this.org.getStore(id);
  }

  @RequirePermission('store:write', { scope: 'store' })
  @Patch('stores/:id')
  updateStore(
    @Param('id', new ZodPipe(uuid)) id: string,
    @Body(new ZodPipe(StoreUpdate)) b: z.infer<typeof StoreUpdate>,
  ) {
    return this.org.updateStore(id, b);
  }

  // ── quầy ──
  @RequirePermission('report:read', { scope: 'store' })
  @Get('stores/:id/registers')
  listRegisters(
    @Param('id', new ZodPipe(uuid)) id: string,
    @Query(new ZodPipe(ListArchived)) q: z.infer<typeof ListArchived>,
  ) {
    return this.org.listRegisters(id, q.include_archived);
  }

  @RequirePermission('store:write', { scope: 'store' })
  @Post('stores/:id/registers')
  createRegister(
    @Param('id', new ZodPipe(uuid)) id: string,
    @Body(new ZodPipe(RegisterCreate)) b: z.infer<typeof RegisterCreate>,
  ) {
    return this.org.createRegister(id, b);
  }

  @RequirePermission('store:write', { scope: 'store' })
  @Patch('registers/:id')
  updateRegister(
    @Param('id', new ZodPipe(uuid)) id: string,
    @Body(new ZodPipe(RegisterUpdate)) b: z.infer<typeof RegisterUpdate>,
  ) {
    return this.org.updateRegister(id, b);
  }

  // ── vị trí mặc định theo SKU ──
  @RequirePermission('stock:read', { scope: 'store' })
  @Get('stores/:id/default-locations')
  listDefaults(
    @Param('id', new ZodPipe(uuid)) id: string,
    @Query(new ZodPipe(DefaultList)) q: z.infer<typeof DefaultList>,
  ) {
    return this.org.listDefaultLocations(id, q.sku_id);
  }

  @RequirePermission('store:write', { scope: 'store' })
  @Put('stores/:id/default-locations/:sku_id')
  setDefault(
    @Param('id', new ZodPipe(uuid)) id: string,
    @Param('sku_id', new ZodPipe(uuid)) skuId: string,
    @Body(new ZodPipe(DefaultSet)) b: z.infer<typeof DefaultSet>,
  ) {
    return this.org.setDefaultLocation(id, skuId, b.location_id);
  }

  // ── kho ──
  @RequirePermission('stock:read')
  @Get('warehouses')
  listWarehouses(@Query(new ZodPipe(ListArchived)) q: z.infer<typeof ListArchived>) {
    return this.org.listWarehouses(q.include_archived);
  }

  @RequirePermission('store:write')
  @Post('warehouses')
  createWarehouse(@Body(new ZodPipe(WarehouseCreate)) b: z.infer<typeof WarehouseCreate>) {
    return this.org.createWarehouse(b);
  }

  @RequirePermission('stock:read')
  @Get('warehouses/:id')
  getWarehouse(@Param('id', new ZodPipe(uuid)) id: string) {
    return this.org.getWarehouse(id);
  }

  @RequirePermission('store:write')
  @Patch('warehouses/:id')
  updateWarehouse(
    @Param('id', new ZodPipe(uuid)) id: string,
    @Body(new ZodPipe(WarehouseUpdate)) b: z.infer<typeof WarehouseUpdate>,
  ) {
    return this.org.updateWarehouse(id, b);
  }

  // ── vị trí ──
  @RequirePermission('stock:read', { scope: 'store' })
  @Get('locations')
  listLocations(@Query(new ZodPipe(LocationList)) q: z.infer<typeof LocationList>) {
    return this.org.listLocations(q);
  }

  @RequirePermission('store:write', { scope: 'store' })
  @Post('locations')
  createLocation(@Body(new ZodPipe(LocationCreate)) b: z.infer<typeof LocationCreate>) {
    return this.org.createLocation(b);
  }

  @RequirePermission('store:write', { scope: 'store' })
  @Patch('locations/:id')
  updateLocation(
    @Param('id', new ZodPipe(uuid)) id: string,
    @Body(new ZodPipe(LocationUpdate)) b: z.infer<typeof LocationUpdate>,
  ) {
    return this.org.updateLocation(id, b);
  }
}
