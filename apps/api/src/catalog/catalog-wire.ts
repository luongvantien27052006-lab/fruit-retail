import type { Category, Product, Sku, SkuUnit, Unit } from '../generated/prisma/client';
import { type SaleUnitType, stockBase } from './catalog-rules';

/** Bản ghi DB ⇒ JSON hợp đồng (snake_case; tiền bigint ⇒ chuỗi ở SerializeInterceptor). Dùng cho cả response và audit. */

export const unitWire = (u: Unit) => ({
  code: u.code,
  name: u.name,
  kind: u.kind,
  fixed_g: u.fixedG,
  archived_at: u.archivedAt,
});

export const categoryWire = (c: Category) => ({
  id: c.id,
  parent_id: c.parentId,
  name: c.name,
  sort: c.sort,
  created_at: c.createdAt,
  updated_at: c.updatedAt,
  archived_at: c.archivedAt,
});

export const productWire = (p: Product) => ({
  id: p.id,
  category_id: p.categoryId,
  name: p.name,
  description: p.description,
  origin: p.origin,
  created_at: p.createdAt,
  updated_at: p.updatedAt,
  archived_at: p.archivedAt,
});

export const skuUnitWire = (u: SkuUnit) => ({
  id: u.id,
  sku_id: u.skuId,
  unit_code: u.unitCode,
  name: u.name,
  factor_g: u.factorG,
  factor_units: u.factorUnits,
  is_variable: u.isVariable,
  for_sale: u.forSale,
  for_purchase: u.forPurchase,
  barcode: u.barcode,
  price_per_unit: u.pricePerUnit,
  created_at: u.createdAt,
  updated_at: u.updatedAt,
  archived_at: u.archivedAt,
});

export const skuWire = (s: Sku, units: SkuUnit[]) => ({
  id: s.id,
  product_id: s.productId,
  sku_code: s.skuCode,
  name: s.name,
  sale_unit_type: s.saleUnitType,
  stock_base: stockBase(s.saleUnitType as SaleUnitType),
  std_weight_g: s.stdWeightG,
  weight_min_g: s.weightMinG,
  weight_max_g: s.weightMaxG,
  tare_g: s.tareG,
  retail_price_per_kg: s.retailPricePerKg,
  retail_price_per_unit: s.retailPricePerUnit,
  scale_plu: s.scalePlu,
  sold_by_scale: s.soldByScale,
  shelf_life_days: s.shelfLifeDays,
  storage_note: s.storageNote,
  has_ripeness: s.hasRipeness,
  shrink_norm_bps_week: s.shrinkNormBpsWeek,
  is_high_value: s.isHighValue,
  cold_required: s.coldRequired,
  alert_days_before_expiry: s.alertDaysBeforeExpiry,
  stop_app_days_before_expiry: s.stopAppDaysBeforeExpiry,
  version: s.version,
  created_at: s.createdAt,
  updated_at: s.updatedAt,
  archived_at: s.archivedAt,
  units: [...units]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .map(skuUnitWire),
});
