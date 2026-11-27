import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { v7 as uuidv7 } from 'uuid';
import { AuditOutboxService, type Tx } from '../common/audit-outbox.service';
import { AppError } from '../common/errors';
import type { Prisma, Sku, SkuUnit, Unit } from '../generated/prisma/client';
import { assertGs1Checksum, catalogWrite } from './catalog-db';
import {
  assertSkuShape,
  assertSkuUnitShape,
  baseUnitFor,
  rule,
  type SaleUnitType,
  type SkuShape,
} from './catalog-rules';
import { skuUnitWire, skuWire } from './catalog-wire';

export interface SkuUnitCreate {
  unit_code: string;
  name: string;
  factor_g?: number | null;
  factor_units?: number | null;
  is_variable?: boolean;
  for_sale: boolean;
  for_purchase: boolean;
  barcode?: string | null;
}
export interface SkuUnitUpdate {
  name?: string;
  for_sale?: boolean;
  for_purchase?: boolean;
  barcode?: string | null;
  archived?: boolean;
}

/** Trường SKU sửa được (không gồm mã, kiểu bán — bất biến; giá — lát 3 qua /admin/prices, quyền price:write). */
export interface SkuAttrs {
  name?: string;
  std_weight_g?: number | null;
  weight_min_g?: number | null;
  weight_max_g?: number | null;
  tare_g?: number | null;
  scale_plu?: string | null;
  sold_by_scale?: boolean;
  shelf_life_days?: number | null;
  storage_note?: string | null;
  has_ripeness?: boolean;
  shrink_norm_bps_week?: number | null;
  is_high_value?: boolean;
  cold_required?: boolean;
  alert_days_before_expiry?: number | null;
  stop_app_days_before_expiry?: number | null;
}
export interface SkuCreate extends SkuAttrs {
  product_id: string;
  sku_code: string;
  name: string;
  sale_unit_type: SaleUnitType;
  /** mã vạch của đơn vị gốc */
  barcode?: string | null;
  /** hàng đếm: đổi đơn vị gốc mặc định (PIECE / PACK / BASKET / SERVICE) */
  base_unit_code?: string;
  /** đơn vị bán/mua thêm (hộp 500 g, thùng danh nghĩa…) */
  units?: SkuUnitCreate[];
}
export interface SkuUpdate extends SkuAttrs {
  version: number;
  product_id?: string;
  archived?: boolean;
}
export interface SkuListQuery {
  product_id?: string;
  sale_unit_type?: SaleUnitType;
  q?: string;
  include_archived: boolean;
  limit: number;
  after?: string;
}

const notFound = () => new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy SKU');
const conflict = (field: string) =>
  new AppError('VERSION_CONFLICT', `Trùng ${field} với bản ghi đang dùng`, { reason: 'UNIQUE', field });

/** prisma data ← trường API (chỉ trường có mặt; undefined = giữ nguyên) */
function attrsData(b: SkuAttrs) {
  return {
    name: b.name,
    stdWeightG: b.std_weight_g,
    weightMinG: b.weight_min_g,
    weightMaxG: b.weight_max_g,
    tareG: b.tare_g,
    scalePlu: b.scale_plu,
    soldByScale: b.sold_by_scale,
    shelfLifeDays: b.shelf_life_days,
    storageNote: b.storage_note,
    hasRipeness: b.has_ripeness,
    shrinkNormBpsWeek: b.shrink_norm_bps_week,
    isHighValue: b.is_high_value,
    coldRequired: b.cold_required,
    alertDaysBeforeExpiry: b.alert_days_before_expiry,
    stopAppDaysBeforeExpiry: b.stop_app_days_before_expiry,
  };
}

function shapeOf(t: SaleUnitType, cur: Partial<SkuShape>, b: SkuAttrs): SkuShape {
  const pick = <T>(v: T | undefined, d: T | undefined, z: T): T => (v !== undefined ? v : d !== undefined ? d : z);
  return {
    saleUnitType: t,
    stdWeightG: pick(b.std_weight_g, cur.stdWeightG, null),
    weightMinG: pick(b.weight_min_g, cur.weightMinG, null),
    weightMaxG: pick(b.weight_max_g, cur.weightMaxG, null),
    tareG: pick(b.tare_g, cur.tareG, null),
    scalePlu: pick(b.scale_plu, cur.scalePlu, null),
    soldByScale: pick(b.sold_by_scale, cur.soldByScale, false),
    shelfLifeDays: pick(b.shelf_life_days, cur.shelfLifeDays, null),
    hasRipeness: pick(b.has_ripeness, cur.hasRipeness, false),
    shrinkNormBpsWeek: pick(b.shrink_norm_bps_week, cur.shrinkNormBpsWeek, null),
    isHighValue: pick(b.is_high_value, cur.isHighValue, false),
    coldRequired: pick(b.cold_required, cur.coldRequired, false),
    alertDaysBeforeExpiry: pick(b.alert_days_before_expiry, cur.alertDaysBeforeExpiry, null),
    stopAppDaysBeforeExpiry: pick(b.stop_app_days_before_expiry, cur.stopAppDaysBeforeExpiry, null),
  };
}

/**
 * SKU + đơn vị bán/mua (CP04 lát 2, §4.3, §21.3.1). Mã SKU, kiểu bán, hệ số quy đổi, mã đơn vị bất biến (sai ⇒ lưu trữ +
 * tạo mới). Không xóa. Giá KHÔNG sửa ở đây (lát 3, quyền price:write) — chỉ đọc. Sửa SKU dùng `version` (409 khi lệch).
 * Thứ tự khóa (ERD §6.2): skus → sku_units; sản phẩm cha `FOR SHARE` khi gắn SKU vào.
 */
@Injectable()
export class SkusService {
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly ao: AuditOutboxService,
  ) {}

  private get tx() {
    return this.txHost.tx;
  }

  async list(q: SkuListQuery) {
    const where: Prisma.SkuWhereInput = {
      ...(q.include_archived ? {} : { archivedAt: null }),
      ...(q.product_id ? { productId: q.product_id } : {}),
      ...(q.sale_unit_type ? { saleUnitType: q.sale_unit_type } : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' as const } },
              { skuCode: { startsWith: q.q.toUpperCase() } },
              { scalePlu: q.q },
              { units: { some: { barcode: q.q.toUpperCase(), archivedAt: null } } },
            ],
          }
        : {}),
      ...(q.after ? { skuCode: { gt: q.after } } : {}),
    };
    const rows = await this.tx.sku.findMany({
      where,
      orderBy: { skuCode: 'asc' },
      take: q.limit + 1,
      include: { units: true },
    });
    const more = rows.length > q.limit;
    const page = more ? rows.slice(0, q.limit) : rows;
    return {
      items: page.map((s) => skuWire(s, s.units)),
      next_after: more ? (page[page.length - 1]?.skuCode ?? null) : null,
    };
  }

  async get(id: string) {
    const s = await this.tx.sku.findUnique({ where: { id }, include: { units: true } });
    if (!s) throw notFound();
    return skuWire(s, s.units);
  }

  private async shareActiveProduct(id: string): Promise<void> {
    const r = await this.tx.$queryRaw<{ archived: boolean }[]>`
      SELECT archived_at IS NOT NULL AS archived FROM core.products WHERE id = ${id}::uuid FOR SHARE`;
    if (!r.length) throw rule('Sản phẩm không tồn tại', { field: 'product_id' });
    if (r[0]?.archived) throw rule('Sản phẩm đã lưu trữ — không gắn thêm SKU', { field: 'product_id' });
  }

  private async lockSku(id: string): Promise<Sku> {
    const r = await this.tx.$queryRaw<{ id: string }[]>`SELECT id FROM core.skus WHERE id = ${id}::uuid FOR UPDATE`;
    if (!r.length) throw notFound();
    return this.tx.sku.findUniqueOrThrow({ where: { id } });
  }

  private async unitRow(code: string): Promise<Unit> {
    const u = await this.tx.unit.findUnique({ where: { code } });
    if (!u) throw rule(`Đơn vị ${code} không tồn tại`, { field: 'unit_code' });
    return u;
  }

  /** PLU duy nhất trong SKU đang dùng (index skus_scale_plu_active là chốt cuối). */
  private async assertPluFree(plu: string | null, exceptId?: string): Promise<void> {
    if (plu === null) return;
    const hit = await this.tx.sku.findFirst({
      where: { scalePlu: plu, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (hit) throw conflict('scale_plu');
  }

  /** Mã vạch duy nhất trong đơn vị đang dùng (index sku_units_barcode_active là chốt cuối). */
  private async assertBarcodeFree(barcode: string | null | undefined, exceptUnitId?: string): Promise<void> {
    if (!barcode) return;
    assertGs1Checksum(barcode);
    const hit = await this.tx.skuUnit.findFirst({
      where: { barcode, archivedAt: null, ...(exceptUnitId ? { id: { not: exceptUnitId } } : {}) },
      select: { id: true },
    });
    if (hit) throw conflict('barcode');
  }

  private async insertUnit(sku: Sku, u: SkuUnitCreate, seen: Set<string>): Promise<SkuUnit> {
    const conv = {
      factorG: u.factor_g ?? null,
      factorUnits: u.factor_units ?? null,
      isVariable: u.is_variable ?? false,
      forSale: u.for_sale,
      forPurchase: u.for_purchase,
    };
    assertSkuUnitShape(sku.saleUnitType as SaleUnitType, await this.unitRow(u.unit_code), conv);
    const nameKey = u.name.trim().toLowerCase();
    if (seen.has(`n:${nameKey}`)) throw conflict('name');
    if (u.barcode && seen.has(`b:${u.barcode}`)) throw conflict('barcode');
    seen.add(`n:${nameKey}`);
    if (u.barcode) seen.add(`b:${u.barcode}`);
    await this.assertBarcodeFree(u.barcode);
    return catalogWrite(() =>
      this.tx.skuUnit.create({
        data: { id: uuidv7(), skuId: sku.id, unitCode: u.unit_code, name: u.name, barcode: u.barcode ?? null, ...conv },
      }),
    );
  }

  async create(b: SkuCreate) {
    const t = b.sale_unit_type;
    assertSkuShape(shapeOf(t, {}, b));
    await this.shareActiveProduct(b.product_id);
    if (await this.tx.sku.findUnique({ where: { skuCode: b.sku_code }, select: { id: true } }))
      throw conflict('sku_code');
    await this.assertPluFree(b.scale_plu ?? null);
    const sku = await catalogWrite(() =>
      this.tx.sku.create({
        data: {
          ...attrsData(b),
          id: uuidv7(),
          productId: b.product_id,
          skuCode: b.sku_code,
          name: b.name,
          saleUnitType: t,
        },
      }),
    );
    const base = baseUnitFor(t, b.base_unit_code);
    const baseUnit = await this.unitRow(base.unitCode);
    if (baseUnit.kind !== (base.factorG !== null ? 'WEIGHT' : 'COUNT'))
      throw rule(`Đơn vị gốc ${base.unitCode} sai loại`, { field: 'base_unit_code' });
    const seen = new Set<string>();
    const units = [
      await this.insertUnit(
        sku,
        {
          unit_code: base.unitCode,
          name: baseUnit.name,
          factor_g: base.factorG,
          factor_units: base.factorUnits,
          for_sale: base.forSale,
          for_purchase: base.forPurchase,
          barcode: b.barcode ?? null,
        },
        seen,
      ),
    ];
    for (const u of b.units ?? []) units.push(await this.insertUnit(sku, u, seen));
    const out = skuWire(sku, units);
    await this.ao.recordAudit({ action: 'sku.create', resourceType: 'sku', resourceId: sku.id, after: out });
    return out;
  }

  async update(id: string, b: SkuUpdate) {
    const before = await this.lockSku(id);
    if (before.version !== b.version)
      throw new AppError('VERSION_CONFLICT', 'SKU đã được sửa bởi người khác — tải lại', {
        reason: 'VERSION',
        current_version: before.version,
      });
    const t = before.saleUnitType as SaleUnitType;
    assertSkuShape(shapeOf(t, before, b));
    const productId = b.product_id ?? before.productId;
    const willBeActive = b.archived === undefined ? before.archivedAt === null : !b.archived;
    if (willBeActive) {
      if (productId !== before.productId || before.archivedAt !== null) await this.shareActiveProduct(productId);
      const plu = b.scale_plu !== undefined ? b.scale_plu : before.scalePlu;
      if (plu !== before.scalePlu || before.archivedAt !== null) await this.assertPluFree(plu, id);
      if (before.archivedAt !== null) await this.assertUnitsFreeOnRestore(id);
    }
    const sku = await catalogWrite(() =>
      this.tx.sku.update({
        where: { id },
        data: {
          ...attrsData(b),
          productId: b.product_id,
          archivedAt: b.archived === undefined ? undefined : b.archived ? (before.archivedAt ?? new Date()) : null,
          version: { increment: 1 },
        },
      }),
    );
    const units = await this.tx.skuUnit.findMany({ where: { skuId: id } });
    if (willBeActive) this.assertSellable(units);
    const out = skuWire(sku, units);
    await this.ao.recordAudit({
      action: 'sku.update',
      resourceType: 'sku',
      resourceId: id,
      before: skuWire(before, units),
      after: out,
    });
    return out;
  }

  /** Mở lại SKU: mã vạch của các đơn vị đang dùng của nó không được trùng với đơn vị đang dùng khác. */
  private async assertUnitsFreeOnRestore(skuId: string): Promise<void> {
    const mine = await this.tx.skuUnit.findMany({
      where: { skuId, archivedAt: null, barcode: { not: null } },
      select: { id: true, barcode: true },
    });
    for (const u of mine) await this.assertBarcodeFree(u.barcode, u.id);
  }

  /** SKU đang dùng phải còn ít nhất một đơn vị bán đang dùng (POS/app luôn có đơn vị để ghi dòng bán). */
  private assertSellable(units: SkuUnit[]): void {
    if (!units.some((u) => u.archivedAt === null && u.forSale))
      throw rule('SKU đang dùng phải còn ít nhất một đơn vị bán', { field: 'for_sale' });
  }

  async createUnit(skuId: string, b: SkuUnitCreate) {
    const sku = await this.lockSku(skuId);
    if (sku.archivedAt) throw rule('SKU đã lưu trữ — không thêm đơn vị', { field: 'sku_id' });
    const existing = await this.tx.skuUnit.findMany({ where: { skuId, archivedAt: null }, select: { name: true } });
    if (existing.some((e) => e.name.trim().toLowerCase() === b.name.trim().toLowerCase())) throw conflict('name');
    const u = await this.insertUnit(sku, b, new Set());
    await this.ao.recordAudit({
      action: 'sku_unit.create',
      resourceType: 'sku_unit',
      resourceId: u.id,
      after: skuUnitWire(u),
    });
    return skuUnitWire(u);
  }

  async updateUnit(skuId: string, unitId: string, b: SkuUnitUpdate) {
    const sku = await this.lockSku(skuId);
    const r = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM core.sku_units WHERE id = ${unitId}::uuid AND sku_id = ${skuId}::uuid FOR UPDATE`;
    if (!r.length) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy đơn vị của SKU');
    const before = await this.tx.skuUnit.findUniqueOrThrow({ where: { id: unitId } });
    const willBeActive = b.archived === undefined ? before.archivedAt === null : !b.archived;
    const forSale = b.for_sale ?? before.forSale;
    const forPurchase = b.for_purchase ?? before.forPurchase;
    if (willBeActive) {
      if (sku.archivedAt && before.archivedAt !== null)
        throw rule('SKU đã lưu trữ — mở lại SKU trước', { field: 'archived' });
      const unit = await this.unitRow(before.unitCode);
      // đơn vị cũ đã lưu trữ vẫn dùng tiếp được cho dòng có sẵn; chỉ chặn khi MỞ LẠI đơn vị trên đơn vị tính đã lưu trữ
      assertSkuUnitShape(sku.saleUnitType as SaleUnitType, before.archivedAt ? unit : { ...unit, archivedAt: null }, {
        factorG: before.factorG,
        factorUnits: before.factorUnits,
        isVariable: before.isVariable,
        forSale,
        forPurchase,
      });
      if (!forSale && before.pricePerUnit !== null)
        throw rule('Đơn vị có giá riêng phải để bán — bỏ giá riêng trước (đổi giá: /admin/prices)', {
          field: 'for_sale',
        });
      const barcode = b.barcode !== undefined ? b.barcode : before.barcode;
      if (barcode !== before.barcode || before.archivedAt !== null) await this.assertBarcodeFree(barcode, unitId);
      if (b.name !== undefined || before.archivedAt !== null) {
        const name = (b.name ?? before.name).trim().toLowerCase();
        const others = await this.tx.skuUnit.findMany({
          where: { skuId, archivedAt: null, id: { not: unitId } },
          select: { name: true },
        });
        if (others.some((o) => o.name.trim().toLowerCase() === name)) throw conflict('name');
      }
    }
    const u = await catalogWrite(() =>
      this.tx.skuUnit.update({
        where: { id: unitId },
        data: {
          name: b.name,
          forSale: b.for_sale,
          forPurchase: b.for_purchase,
          barcode: b.barcode,
          archivedAt: b.archived === undefined ? undefined : b.archived ? (before.archivedAt ?? new Date()) : null,
        },
      }),
    );
    if (sku.archivedAt === null) this.assertSellable(await this.tx.skuUnit.findMany({ where: { skuId } }));
    await this.ao.recordAudit({
      action: 'sku_unit.update',
      resourceType: 'sku_unit',
      resourceId: unitId,
      before: skuUnitWire(before),
      after: skuUnitWire(u),
    });
    return skuUnitWire(u);
  }
}
