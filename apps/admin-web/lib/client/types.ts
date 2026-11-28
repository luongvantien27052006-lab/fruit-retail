/** Kiểu dữ liệu API (khớp packages/contracts/openapi.yaml) dùng ở các màn CP04 + nhãn tiếng Việt. */

export type SaleUnitType =
  'WEIGHT' | 'PIECE_BY_WEIGHT' | 'PIECE_FIXED' | 'PACK_FIXED' | 'PACK_VARIABLE' | 'BUNDLE' | 'SERVICE';

export const SALE_TYPE_VI: Record<SaleUnitType, string> = {
  WEIGHT: 'Bán cân (giá/kg)',
  PIECE_BY_WEIGHT: 'Theo quả, tính tiền theo cân',
  PIECE_FIXED: 'Theo cái/quả, giá cố định',
  PACK_FIXED: 'Hộp/gói định lượng',
  PACK_VARIABLE: 'Gói cân sẵn (giá/kg)',
  BUNDLE: 'Combo',
  SERVICE: 'Dịch vụ',
};

export const WEIGHT_PRICED: ReadonlySet<SaleUnitType> = new Set(['WEIGHT', 'PIECE_BY_WEIGHT', 'PACK_VARIABLE']);

export interface Unit {
  code: string;
  name: string;
  kind: 'WEIGHT' | 'COUNT';
  fixed_g: number | null;
  archived_at: string | null;
}

export interface Category {
  id: string;
  parent_id: string | null;
  name: string;
  sort: number;
  archived_at: string | null;
}

export interface Product {
  id: string;
  category_id: string;
  name: string;
  description: string | null;
  origin: string | null;
  archived_at: string | null;
}

export interface SkuUnit {
  id: string;
  sku_id: string;
  unit_code: string;
  name: string;
  factor_g: number | null;
  factor_units: number | null;
  is_variable: boolean;
  for_sale: boolean;
  for_purchase: boolean;
  barcode: string | null;
  price_per_unit: string | null;
  archived_at: string | null;
}

export interface Sku {
  id: string;
  product_id: string;
  sku_code: string;
  name: string;
  sale_unit_type: SaleUnitType;
  stock_base: 'GRAM' | 'COUNT' | 'NONE';
  std_weight_g: number | null;
  weight_min_g: number | null;
  weight_max_g: number | null;
  tare_g: number | null;
  scale_plu: string | null;
  sold_by_scale: boolean;
  shelf_life_days: number | null;
  storage_note: string | null;
  has_ripeness: boolean;
  shrink_norm_bps_week: number | null;
  is_high_value: boolean;
  cold_required: boolean;
  alert_days_before_expiry: number | null;
  stop_app_days_before_expiry: number | null;
  retail_price_per_kg: string | null;
  retail_price_per_unit: string | null;
  version: number;
  updated_at: string;
  archived_at: string | null;
  units: SkuUnit[];
}

export interface SkuPrices {
  sku_id: string;
  sale_unit_type: SaleUnitType;
  price_field: 'PER_KG' | 'PER_UNIT';
  version: number;
  global: string | null;
  stores: { store_id: string; price: string | null; updated_at: string }[];
  units: { sku_unit_id: string; name: string; for_sale: boolean; archived_at: string | null; price: string | null }[];
}

export interface PriceChangeLog {
  id: string;
  scope: 'GLOBAL' | 'STORE';
  field: 'PER_KG' | 'PER_UNIT' | 'SKU_UNIT';
  store_id: string | null;
  sku_unit_id: string | null;
  old_value: string | null;
  new_value: string | null;
  reason: string;
  changed_by: string;
  changed_at: string;
}

export type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type OpeningHours = Partial<Record<Day, [string, string][]>>;
export const DAYS: { key: Day; vi: string }[] = [
  { key: 'mon', vi: 'Thứ 2' },
  { key: 'tue', vi: 'Thứ 3' },
  { key: 'wed', vi: 'Thứ 4' },
  { key: 'thu', vi: 'Thứ 5' },
  { key: 'fri', vi: 'Thứ 6' },
  { key: 'sat', vi: 'Thứ 7' },
  { key: 'sun', vi: 'Chủ nhật' },
];

export interface Store {
  id: string;
  code: string;
  name: string;
  address: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  lat: number | null;
  lng: number | null;
  opening_hours: OpeningHours | null;
  pos_status: 'OPEN' | 'CLOSED';
  app_status: 'ONLINE' | 'PAUSED';
  app_capacity_per_hour: number | null;
  archived_at: string | null;
}

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  address: string | null;
  archived_at: string | null;
}

export type LocationType = 'STORAGE' | 'COLD_ROOM' | 'SHELF' | 'CHILLER' | 'RIPENING' | 'IN_TRANSIT';
export const LOCATION_VI: Record<LocationType, string> = {
  STORAGE: 'Kho chứa',
  COLD_ROOM: 'Phòng lạnh',
  SHELF: 'Kệ bán',
  CHILLER: 'Tủ mát',
  RIPENING: 'Khu ủ chín',
  IN_TRANSIT: 'Đang vận chuyển',
};

export interface Location {
  id: string;
  store_id: string | null;
  warehouse_id: string | null;
  type: LocationType;
  code: string;
  name: string;
  sort: number;
  archived_at: string | null;
}

export interface Register {
  id: string;
  store_id: string;
  code: string;
  name: string | null;
  archived_at: string | null;
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  type: string;
  contact_name: string | null;
  phone: string | null;
  phone_masked: string | null;
  bank_name: string | null;
  bank_account_masked: string | null;
  payment_terms_days: number | null;
  note: string | null;
  archived_at: string | null;
}

export interface ImportReportRow {
  row: number;
  status: 'CREATED' | 'UPDATED' | 'SKIPPED' | 'ERROR';
  key?: string;
  field?: string;
  duplicate_of?: string;
  message?: string;
}

export interface ImportJob {
  id: string;
  type: 'CATALOG' | 'SUPPLIER';
  file_id: string;
  mode_on_duplicate: 'SKIP' | 'UPDATE' | 'STOP';
  dry_run: boolean;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  total_rows: number | null;
  ok_rows: number | null;
  skipped_rows: number | null;
  error_rows: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  report?: {
    dry_run?: boolean;
    created?: number;
    updated?: number;
    skipped?: number;
    errors?: number;
    stopped_at_row?: number;
    reason?: string;
    rows?: ImportReportRow[];
  } | null;
}

export interface BarcodeRule {
  id: string;
  code: string;
  name: string;
  priority: number;
  type: string;
  pattern: string;
  value_scale: number;
  ean13_checksum: boolean;
  enabled: boolean;
}

export interface Brand {
  brand_name: string;
  hotline: string | null;
  display_address: string | null;
  receipt_footer: string | null;
  primary_color: string | null;
  privacy_url: string | null;
  logo_mono_file_id: string | null;
  logo_color_file_id: string | null;
  updated_at: string;
}
