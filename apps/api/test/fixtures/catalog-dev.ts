/**
 * Danh mục MẪU nhãn DEV (CP04 lát 8, NC-28) — KHÔNG phải dữ liệu thật của Tiến. Dùng diễn tập luồng nạp danh mục
 * (tải file → chạy thử → chạy thật) trước khi có bảng SKU + giá + PLU thật. Giá / PLU / mã vạch là giá trị giả.
 */

/** EAN-13 hợp lệ tiền tố 893 (Việt Nam) từ số thứ tự — mã giả */
export function devEan(n: number): string {
  const body = `893${String(n).padStart(9, '0')}`;
  const s = [...body].reduce((a, d, i) => a + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${body}${(10 - (s % 10)) % 10}`;
}

export interface DevRow {
  category: string;
  product: string;
  sku_code: string;
  name: string;
  sale_unit_type: string;
  retail_price: number;
  std_weight_g?: number;
  weight_min_g?: number;
  weight_max_g?: number;
  scale_plu?: string;
  sold_by_scale?: string;
  barcode?: string;
  shelf_life_days?: number;
  has_ripeness?: string;
  cold_required?: string;
}

const C = 'DEV > Trái cây';
/** 25 SKU: 14 bán cân (có PLU), 3 quả theo cân, 4 quả / cái giá cố định, 3 hộp định lượng, 1 combo */
export const DEV_CATALOG: DevRow[] = [
  ...(
    [
      ['Cam', 'Cam sành', 'DEV-CAM-SANH', 'Cam sành (DEV)', 45000],
      ['Cam', 'Cam Vinh', 'DEV-CAM-VINH', 'Cam Vinh (DEV)', 65000],
      ['Quýt', 'Quýt đường', 'DEV-QUYT-DUONG', 'Quýt đường (DEV)', 55000],
      ['Táo', 'Táo Envy', 'DEV-TAO-ENVY', 'Táo Envy (DEV)', 150000],
      ['Táo', 'Táo Gala', 'DEV-TAO-GALA', 'Táo Gala (DEV)', 85000],
      ['Lê', 'Lê Hàn', 'DEV-LE-HAN', 'Lê Hàn (DEV)', 120000],
      ['Nho', 'Nho xanh không hạt', 'DEV-NHO-XANH', 'Nho xanh không hạt (DEV)', 180000],
      ['Nho', 'Nho đen', 'DEV-NHO-DEN', 'Nho đen (DEV)', 160000],
      ['Xoài', 'Xoài cát Hòa Lộc', 'DEV-XOAI-HL', 'Xoài cát Hòa Lộc (DEV)', 90000],
      ['Ổi', 'Ổi lê', 'DEV-OI-LE', 'Ổi lê (DEV)', 30000],
      ['Thanh long', 'Thanh long ruột đỏ', 'DEV-TL-DO', 'Thanh long ruột đỏ (DEV)', 40000],
      ['Chuối', 'Chuối già', 'DEV-CHUOI-GIA', 'Chuối già (DEV)', 25000],
      ['Mận', 'Mận hậu', 'DEV-MAN-HAU', 'Mận hậu (DEV)', 70000],
      ['Vải', 'Vải thiều', 'DEV-VAI', 'Vải thiều (DEV)', 60000],
    ] as const
  ).map(([g, product, sku_code, name, price], i): DevRow => ({
    category: `${C} > ${g}`,
    product,
    sku_code,
    name,
    sale_unit_type: 'WEIGHT',
    retail_price: price,
    scale_plu: String(90001 + i),
    sold_by_scale: 'có',
    shelf_life_days: 10,
    has_ripeness: g === 'Xoài' || g === 'Chuối' ? 'có' : 'không',
  })),
  {
    category: `${C} > Bưởi`,
    product: 'Bưởi da xanh',
    sku_code: 'DEV-BUOI-DX',
    name: 'Bưởi da xanh (DEV)',
    sale_unit_type: 'PIECE_BY_WEIGHT',
    retail_price: 60000,
    std_weight_g: 1500,
    weight_min_g: 1100,
    weight_max_g: 2200,
    scale_plu: '90021',
    sold_by_scale: 'có',
  },
  {
    category: `${C} > Dưa`,
    product: 'Dưa hấu',
    sku_code: 'DEV-DUA-HAU',
    name: 'Dưa hấu (DEV)',
    sale_unit_type: 'PIECE_BY_WEIGHT',
    retail_price: 20000,
    std_weight_g: 3000,
    weight_min_g: 2000,
    weight_max_g: 5000,
    scale_plu: '90022',
    sold_by_scale: 'có',
  },
  {
    category: `${C} > Dưa`,
    product: 'Dưa lưới',
    sku_code: 'DEV-DUA-LUOI',
    name: 'Dưa lưới (DEV)',
    sale_unit_type: 'PIECE_BY_WEIGHT',
    retail_price: 80000,
    std_weight_g: 1500,
    weight_min_g: 1000,
    weight_max_g: 2500,
    scale_plu: '90023',
    sold_by_scale: 'có',
  },
  ...(
    [
      ['Dừa', 'Dừa xiêm', 'DEV-DUA-XIEM', 'Dừa xiêm (DEV) — quả', 25000],
      ['Bơ', 'Bơ 034', 'DEV-BO-034', 'Bơ 034 (DEV) — quả', 35000],
      ['Sầu riêng', 'Sầu riêng Ri6 (múi)', 'DEV-SR-RI6', 'Sầu riêng Ri6 (DEV) — hộp múi', 250000],
      ['Măng cụt', 'Măng cụt', 'DEV-MC', 'Măng cụt (DEV) — túi', 75000],
    ] as const
  ).map(([g, product, sku_code, name, price], i): DevRow => ({
    category: `${C} > ${g}`,
    product,
    sku_code,
    name,
    sale_unit_type: 'PIECE_FIXED',
    retail_price: price,
    barcode: devEan(9_100 + i),
  })),
  ...(
    [
      ['Dâu', 'Dâu tây Đà Lạt', 'DEV-DAU-250', 'Dâu tây Đà Lạt (DEV) — hộp 250 g', 85000, 250],
      ['Việt quất', 'Việt quất', 'DEV-VQ-125', 'Việt quất (DEV) — hộp 125 g', 95000, 125],
      ['Cherry', 'Cherry đỏ', 'DEV-CHERRY-500', 'Cherry đỏ (DEV) — hộp 500 g', 320000, 500],
    ] as const
  ).map(([g, product, sku_code, name, price, g0], i): DevRow => ({
    category: `${C} > ${g}`,
    product,
    sku_code,
    name,
    sale_unit_type: 'PACK_FIXED',
    retail_price: price,
    std_weight_g: g0,
    barcode: devEan(9_200 + i),
    cold_required: 'có',
    shelf_life_days: 5,
  })),
  {
    category: `${C} > Quà tặng`,
    product: 'Giỏ quà',
    sku_code: 'DEV-GIO-QUA',
    name: 'Giỏ quà trái cây (DEV)',
    sale_unit_type: 'BUNDLE',
    retail_price: 500000,
    barcode: devEan(9_300),
  },
];
