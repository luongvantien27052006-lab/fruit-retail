import { MoneyWeightError, type StockQuantity, toStockQuantity } from '@fruit/money_weight';
import { AppError } from '../common/errors';

/**
 * Quy tắc danh mục thuần (không DB) — §4.2, §4.3, §21.3.1. Cùng nội dung với CHECK/trigger của migration 0009: DB là chốt
 * chặn cuối (400/409), lớp này trả lỗi nghiệp vụ rõ ràng 422 `CATALOG_RULE_VIOLATION` trước khi chạm DB.
 */

export const SALE_UNIT_TYPES = [
  'WEIGHT',
  'PIECE_BY_WEIGHT',
  'PIECE_FIXED',
  'PACK_FIXED',
  'PACK_VARIABLE',
  'BUNDLE',
  'SERVICE',
] as const;
export type SaleUnitType = (typeof SALE_UNIT_TYPES)[number];

/** Tính tiền theo kg (giá/kg, PLU cân) */
export const WEIGHT_PRICED: ReadonlySet<SaleUnitType> = new Set(['WEIGHT', 'PIECE_BY_WEIGHT', 'PACK_VARIABLE']);
/** Tồn theo gram, KHÔNG có đơn vị đếm (quả theo cân tồn gram + số quả nên được cả hai) */
const GRAM_ONLY: ReadonlySet<SaleUnitType> = new Set(['WEIGHT', 'PACK_VARIABLE']);
/** Tồn theo số đơn vị */
const COUNTED: ReadonlySet<SaleUnitType> = new Set(['PIECE_FIXED', 'PACK_FIXED', 'BUNDLE', 'SERVICE']);
/** Không cân, không bì */
const NO_WEIGHT: ReadonlySet<SaleUnitType> = new Set(['BUNDLE', 'SERVICE']);

export type StockBase = 'GRAM' | 'COUNT' | 'NONE';

/** Đơn vị tồn chuẩn (§4.2, §21.3.1): dịch vụ không tồn kho. */
export function stockBase(t: SaleUnitType): StockBase {
  if (t === 'SERVICE') return 'NONE';
  return WEIGHT_PRICED.has(t) ? 'GRAM' : 'COUNT';
}

export const rule = (message: string, details: Record<string, unknown> = {}) =>
  new AppError('CATALOG_RULE_VIOLATION', message, details);

/** Các trường SKU mà kiểu bán ràng buộc (sau khi gộp bản cũ + bản sửa) */
export interface SkuShape {
  saleUnitType: SaleUnitType;
  stdWeightG: number | null;
  weightMinG: number | null;
  weightMaxG: number | null;
  tareG: number | null;
  scalePlu: string | null;
  soldByScale: boolean;
  shelfLifeDays: number | null;
  hasRipeness: boolean;
  shrinkNormBpsWeek: number | null;
  isHighValue: boolean;
  coldRequired: boolean;
  alertDaysBeforeExpiry: number | null;
  stopAppDaysBeforeExpiry: number | null;
}

/** Kiểm thuộc tính SKU theo kiểu bán; vi phạm ⇒ 422 (khớp CHECK skus_* của 0009). */
export function assertSkuShape(s: SkuShape): void {
  const t = s.saleUnitType;
  if (s.scalePlu !== null && !WEIGHT_PRICED.has(t))
    throw rule(`Kiểu bán ${t} không cân ⇒ không có PLU`, { field: 'scale_plu', sale_unit_type: t });
  if (s.soldByScale && s.scalePlu === null)
    throw rule('Bán qua cân cần mã PLU', { field: 'sold_by_scale', sale_unit_type: t });
  if (NO_WEIGHT.has(t) && [s.stdWeightG, s.weightMinG, s.weightMaxG, s.tareG].some((v) => v !== null))
    throw rule(`Kiểu bán ${t} không có trọng lượng / bì`, { field: 'std_weight_g', sale_unit_type: t });
  if (t === 'PACK_FIXED' && s.stdWeightG === null)
    throw rule('Hộp cố định phải ghi định lượng hộp (std_weight_g)', { field: 'std_weight_g', sale_unit_type: t });
  if (
    t === 'SERVICE' &&
    (s.shelfLifeDays !== null ||
      s.hasRipeness ||
      s.coldRequired ||
      s.isHighValue ||
      s.alertDaysBeforeExpiry !== null ||
      s.stopAppDaysBeforeExpiry !== null ||
      s.shrinkNormBpsWeek !== null)
  )
    throw rule('Dịch vụ không tồn kho ⇒ không hạn dùng, độ chín, giữ lạnh, hàng giá trị cao, hao hụt', {
      sale_unit_type: t,
    });
  const { stdWeightG: std, weightMinG: lo, weightMaxG: hi } = s;
  if (
    (lo !== null && hi !== null && lo > hi) ||
    (std !== null && lo !== null && lo > std) ||
    (std !== null && hi !== null && std > hi)
  )
    throw rule('Khoảng cân phải thỏa min ≤ chuẩn ≤ max', { field: 'weight_min_g' });
  const shelf = s.shelfLifeDays;
  if (
    shelf !== null &&
    ((s.alertDaysBeforeExpiry !== null && s.alertDaysBeforeExpiry > shelf) ||
      (s.stopAppDaysBeforeExpiry !== null && s.stopAppDaysBeforeExpiry > shelf))
  )
    throw rule('Số ngày cảnh báo / ngừng bán app không vượt hạn dùng', { field: 'alert_days_before_expiry' });
}

export interface UnitRow {
  code: string;
  kind: 'WEIGHT' | 'COUNT';
  fixedG: number | null;
  archivedAt: Date | null;
}
export interface UnitConversionInput {
  factorG: number | null;
  factorUnits: number | null;
  isVariable: boolean;
  forSale: boolean;
  forPurchase: boolean;
}

/** Đơn vị bán/mua khớp kiểu bán của SKU và loại đơn vị (khớp trigger sku_units_kind_guard + CHECK sku_units_*). */
export function assertSkuUnitShape(t: SaleUnitType, unit: UnitRow, u: UnitConversionInput): void {
  const d = { unit_code: unit.code, sale_unit_type: t };
  const n = (u.factorG !== null ? 1 : 0) + (u.factorUnits !== null ? 1 : 0) + (u.isVariable ? 1 : 0);
  if (n !== 1) throw rule('Đơn vị phải có đúng một cách quy đổi: factor_g, factor_units hoặc is_variable', d);
  if (!u.forSale && !u.forPurchase) throw rule('Đơn vị phải dùng để bán hoặc để mua', d);
  if (unit.archivedAt) throw rule(`Đơn vị ${unit.code} đã lưu trữ`, d);
  if (unit.kind === 'WEIGHT' && u.factorG !== unit.fixedG)
    throw rule(`Đơn vị ${unit.code} phải quy đổi đúng ${unit.fixedG ?? '?'} g`, d);
  if (GRAM_ONLY.has(t) && u.factorUnits !== null)
    throw rule(`SKU ${t} tồn theo gram — đơn vị phải quy đổi ra gram hoặc là danh nghĩa`, d);
  if (COUNTED.has(t) && u.factorG !== null)
    throw rule(`SKU ${t} tồn theo đơn vị đếm — đơn vị phải quy đổi ra số đơn vị`, d);
  if (u.isVariable && !WEIGHT_PRICED.has(t))
    throw rule('Đơn vị danh nghĩa (cân thực khi nhận) chỉ dùng cho hàng tồn theo gram', d);
  if (u.isVariable && u.forSale) throw rule('Đơn vị danh nghĩa chỉ để mua — bán phải quy đổi cứng được', d);
  if ((t === 'SERVICE' || t === 'BUNDLE') && u.forPurchase) throw rule(`SKU ${t} không mua/nhập từ NCC`, d);
}

/** Đơn vị gốc tạo kèm SKU: hàng cân ⇒ kg (1000 g); hàng đếm ⇒ 1 đơn vị (mặc định theo kiểu bán, cho đổi mã). */
export function baseUnitFor(
  t: SaleUnitType,
  overrideCode?: string,
): { unitCode: string; factorG: number | null; factorUnits: number | null; forSale: boolean; forPurchase: boolean } {
  if (WEIGHT_PRICED.has(t)) {
    if (overrideCode !== undefined && overrideCode !== 'KG')
      throw rule('Hàng cân dùng đơn vị gốc kg', { field: 'base_unit_code', sale_unit_type: t });
    return { unitCode: 'KG', factorG: 1000, factorUnits: null, forSale: true, forPurchase: true };
  }
  const def = { PIECE_FIXED: 'PIECE', PACK_FIXED: 'PACK', BUNDLE: 'BASKET', SERVICE: 'SERVICE' } as const;
  const noBuy = t === 'BUNDLE' || t === 'SERVICE';
  return {
    unitCode: overrideCode ?? def[t as keyof typeof def],
    factorG: null,
    factorUnits: 1,
    forSale: true,
    forPurchase: !noBuy,
  };
}

/**
 * Quy đổi số lượng theo một đơn vị của SKU về đơn vị tồn (qua `@fruit/money_weight` — một helper cho TS/Dart):
 * hộp 500 g × 1 ⇒ 500 g; thùng danh nghĩa ⇒ 422 (cân thực khi nhận, §5.3); dịch vụ ⇒ không tồn kho (null).
 */
export function stockQuantityOf(
  t: SaleUnitType,
  u: { factorG: number | null; factorUnits: number | null; isVariable: boolean },
  qty: number,
): StockQuantity | null {
  try {
    const q = toStockQuantity(u, qty);
    return t === 'SERVICE' ? null : q;
  } catch (e) {
    if (e instanceof MoneyWeightError && e.code === 'VARIABLE_UNIT')
      throw rule('Đơn vị danh nghĩa không quy đổi cứng — phải cân thực khi nhận', { reason: 'VARIABLE_UNIT' });
    if (e instanceof MoneyWeightError) throw new AppError('INVALID_REQUEST', e.message, { reason: e.code });
    throw e;
  }
}
