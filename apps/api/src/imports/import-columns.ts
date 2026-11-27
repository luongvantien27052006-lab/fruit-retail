import ExcelJS from 'exceljs';
import { z } from 'zod';
import { SALE_UNIT_TYPES } from '../catalog/catalog-rules';
import { optText, text } from '../org/org-fields';
import { SUPPLIER_TYPES } from '../org/suppliers.service';
import type { Cell } from './xlsx-safe';

export type ImportType = 'CATALOG' | 'SUPPLIER';

export interface Column {
  key: string;
  label: string;
  required: boolean;
  hint: string;
}

/** Cột file nhập danh mục — mỗi dòng một SKU (danh mục / sản phẩm tạo nếu chưa có). */
export const CATALOG_COLUMNS: readonly Column[] = [
  {
    key: 'category',
    label: 'Danh mục',
    required: true,
    hint: 'Đường dẫn cây, cách nhau bằng " > " — vd "Trái cây > Cam"',
  },
  { key: 'product', label: 'Sản phẩm', required: true, hint: 'Tên sản phẩm trong danh mục — vd "Cam sành"' },
  { key: 'sku_code', label: 'Mã SKU', required: true, hint: 'Chữ HOA/số/_.- (tối đa 32), duy nhất' },
  { key: 'name', label: 'Tên SKU', required: true, hint: 'Tên hiển thị khi bán' },
  { key: 'sale_unit_type', label: 'Kiểu bán', required: true, hint: SALE_UNIT_TYPES.join(' / ') },
  {
    key: 'retail_price',
    label: 'Giá lẻ (đồng)',
    required: false,
    hint: 'Số nguyên đồng; hàng cân / quả cân / gói cân: giá mỗi kg; kiểu khác: giá mỗi đơn vị',
  },
  { key: 'std_weight_g', label: 'Khối lượng chuẩn (g)', required: false, hint: 'Bắt buộc với quả cân / gói cố định' },
  { key: 'weight_min_g', label: 'Khối lượng tối thiểu (g)', required: false, hint: '' },
  { key: 'weight_max_g', label: 'Khối lượng tối đa (g)', required: false, hint: '' },
  { key: 'tare_g', label: 'Bì (g)', required: false, hint: '' },
  { key: 'scale_plu', label: 'PLU cân', required: false, hint: '5 chữ số, duy nhất' },
  { key: 'sold_by_scale', label: 'Bán qua cân', required: false, hint: 'có / không' },
  { key: 'barcode', label: 'Mã vạch', required: false, hint: 'Mã vạch đơn vị gốc, duy nhất' },
  { key: 'shelf_life_days', label: 'Hạn dùng (ngày)', required: false, hint: '' },
  { key: 'has_ripeness', label: 'Theo dõi độ chín', required: false, hint: 'có / không' },
  { key: 'is_high_value', label: 'Hàng giá trị cao', required: false, hint: 'có / không' },
  { key: 'cold_required', label: 'Cần bảo quản lạnh', required: false, hint: 'có / không' },
];

/** Cột file nhập NCC — SĐT / số tài khoản được mã hóa khi lưu; báo cáo nhập KHÔNG nhắc lại giá trị này. */
export const SUPPLIER_COLUMNS: readonly Column[] = [
  { key: 'code', label: 'Mã NCC', required: true, hint: 'Chữ HOA/số/_- (tối đa 32), duy nhất' },
  { key: 'name', label: 'Tên NCC', required: true, hint: '' },
  { key: 'type', label: 'Loại', required: true, hint: SUPPLIER_TYPES.join(' / ') },
  { key: 'contact_name', label: 'Người liên hệ', required: false, hint: '' },
  { key: 'phone', label: 'Số điện thoại', required: false, hint: 'Số Việt Nam (di động / cố định)' },
  { key: 'bank_name', label: 'Ngân hàng', required: false, hint: '' },
  { key: 'account_number', label: 'Số tài khoản', required: false, hint: '6–20 chữ số; đi cùng chủ tài khoản' },
  { key: 'account_holder', label: 'Chủ tài khoản', required: false, hint: '' },
  { key: 'payment_terms_days', label: 'Kỳ hạn thanh toán (ngày)', required: false, hint: '0–365' },
  { key: 'note', label: 'Ghi chú', required: false, hint: '' },
];

export const columnsOf = (t: ImportType) => (t === 'CATALOG' ? CATALOG_COLUMNS : SUPPLIER_COLUMNS);

// ───────── chuyển ô ⇒ giá trị ─────────

/**
 * ô ⇒ chuỗi; ô trống / cột không có trong file ⇒ undefined (review TS lát 5 C1). Dấu `'` mà file XUẤT thêm trước = + - @
 * (chống chèn công thức) được bỏ khi nhập lại.
 */
const str = (v: Cell | undefined): string | undefined => {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const t = v.trim();
  const s = /^'[=+\-@]/.test(t) ? t.slice(1) : t;
  return s === '' ? undefined : s;
};
/** lỗi dùng chung khi ô kiểu SỐ không chuyển an toàn được (số thập phân / vượt 2^53 / mất số 0 đầu) */
const NUMERIC = 'ô kiểu số không dùng được — định dạng cột là Chữ (Text) rồi nhập lại';
/** cột mã (số tài khoản, SĐT…): ô kiểu số luôn bị từ chối (Excel đã bỏ số 0 đầu / làm tròn số dài) */
const codeText = (v: unknown) => (typeof v === 'number' ? NUMERIC_MARK : str(v as Cell));
const NUMERIC_MARK = '\u0000numeric';
/** số nguyên: ô số phải là số nguyên an toàn; ô chữ chỉ bỏ dấu phân cách NGHÌN đúng mẫu (1.000 / 1,000 / 1 000) */
const toInt = (v: unknown): number | undefined | typeof Number.NaN => {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : Number.NaN;
  const s = str(v as Cell);
  if (s === undefined) return undefined;
  const d = /^-?\d{1,3}([.,\s]\d{3})+$/.test(s) ? s.replace(/[.,\s]/g, '') : s;
  return /^-?\d{1,15}$/.test(d) ? Number(d) : Number.NaN;
};
const cellText = z.preprocess((v) => str(v as Cell), text(200));
const cellOptText = (max: number) => z.preprocess((v) => str(v as Cell) ?? null, optText(max));
const cellCode = (re: RegExp, msg: string) =>
  z.preprocess((v) => str(v as Cell)?.toUpperCase(), z.string().regex(re, msg));
const cellInt = (lo: number, hi: number) =>
  z.preprocess(toInt, z.number({ error: 'phải là số nguyên' }).int('phải là số nguyên').min(lo).max(hi).optional());
const TRUE = new Set(['có', 'co', 'x', 'true', '1', 'yes', 'y']);
const FALSE = new Set(['không', 'khong', 'false', '0', 'no', 'n']);
const cellBool = z.preprocess(
  (v) => {
    const s = str(v as Cell)?.toLowerCase();
    if (s === undefined) return undefined;
    return TRUE.has(s) ? true : FALSE.has(s) ? false : 'sai';
  },
  z.boolean({ error: 'có / không' }).optional(),
);
/** tiền: số nguyên đồng (ô số nguyên, hoặc chữ "45.000" / "45,000" / "45.000 đ") ⇒ bigint; 45000.5 ⇒ lỗi (C2) */
const cellVnd = z.preprocess(
  (v) => {
    if (typeof v === 'string') v = v.replace(/\s*(đ|₫|vnd)$/i, '');
    const n = toInt(v);
    if (n === undefined) return undefined;
    return Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) < 1e13 ? String(n) : 'sai';
  },
  z
    .string()
    .regex(/^\d+$/, 'giá: số nguyên đồng')
    .transform((d) => BigInt(d))
    .optional(),
);

export const CatalogRow = z.object({
  category: z.preprocess(
    (v) => str(v as Cell),
    z
      .string()
      .max(500)
      .transform((s) =>
        s
          .split('>')
          .map((p) => p.trim())
          .filter(Boolean),
      )
      .pipe(z.array(text(100)).min(1, 'danh mục trống').max(5, 'tối đa 5 cấp')),
  ),
  product: cellText,
  sku_code: cellCode(/^[A-Z0-9][A-Z0-9_.-]{0,31}$/, 'mã SKU: chữ HOA/số/_.- (tối đa 32)'),
  name: cellText,
  sale_unit_type: z.preprocess((v) => str(v as Cell)?.toUpperCase(), z.enum(SALE_UNIT_TYPES)),
  retail_price: cellVnd,
  std_weight_g: cellInt(1, 100_000),
  weight_min_g: cellInt(1, 100_000),
  weight_max_g: cellInt(1, 100_000),
  tare_g: cellInt(0, 100_000),
  scale_plu: z.preprocess(
    (v) => {
      const s = str(v as Cell);
      return s === undefined ? undefined : /^\d{1,5}$/.test(s) ? s.padStart(5, '0') : s;
    },
    z
      .string()
      .regex(/^[0-9]{5}$/, 'PLU 5 chữ số')
      .refine((x) => x !== '00000', 'PLU khác 00000')
      .optional(),
  ),
  sold_by_scale: cellBool,
  // ô số: chỉ nhận số nguyên an toàn dài 8 / 13 / 14 (EAN-8 / EAN-13 / GTIN-14 không mất số 0 đầu); khác ⇒ lỗi (C2)
  barcode: z.preprocess(
    (v) =>
      typeof v === 'number'
        ? Number.isSafeInteger(v) && [8, 13, 14].includes(String(v).length)
          ? String(v)
          : NUMERIC_MARK
        : str(v as Cell)?.toUpperCase(),
    z
      .string()
      .refine((x) => x !== NUMERIC_MARK, NUMERIC)
      .pipe(z.string().regex(/^[0-9A-Z-]{4,32}$/, 'mã vạch: 4–32 ký tự số/chữ HOA/-'))
      .refine((x) => !/^2[0-9]{12}$/.test(x), 'mã 13 số bắt đầu bằng 2 dành cho tem cân')
      .optional(),
  ),
  shelf_life_days: cellInt(0, 3650),
  has_ripeness: cellBool,
  is_high_value: cellBool,
  cold_required: cellBool,
});
export type CatalogRowT = z.infer<typeof CatalogRow>;

export const SupplierRow = z
  .object({
    code: cellCode(/^[A-Z0-9][A-Z0-9_-]{0,31}$/, 'mã NCC: chữ HOA/số/_- (tối đa 32)'),
    name: cellText,
    type: z.preprocess((v) => str(v as Cell)?.toUpperCase(), z.enum(SUPPLIER_TYPES)),
    contact_name: cellOptText(100),
    phone: z.preprocess(
      codeText,
      z
        .string()
        .refine((x) => x !== NUMERIC_MARK, NUMERIC)
        .pipe(z.string().max(20))
        .optional(),
    ),
    bank_name: cellOptText(100),
    account_number: z.preprocess(
      (v) => {
        const s = codeText(v);
        return s === NUMERIC_MARK ? s : s?.replace(/[\s.-]/g, '');
      },
      z
        .string()
        .refine((x) => x !== NUMERIC_MARK, NUMERIC)
        .pipe(z.string().regex(/^[0-9]{6,20}$/, 'số tài khoản: 6–20 chữ số'))
        .optional(),
    ),
    account_holder: z.preprocess((v) => str(v as Cell)?.toUpperCase(), text(100).optional()),
    payment_terms_days: cellInt(0, 365),
    note: cellOptText(2000),
  })
  .refine((r) => (r.account_number === undefined) === (r.account_holder === undefined), {
    message: 'số tài khoản và chủ tài khoản đi cùng nhau',
    path: ['account_number'],
  });
export type SupplierRowT = z.infer<typeof SupplierRow>;

/** Lỗi zod của một dòng ⇒ thông điệp ngắn KHÔNG chứa giá trị ô (cột SĐT / số tài khoản không được lặp lại trong báo cáo). */
export function rowIssues(e: z.ZodError): { field: string; message: string }[] {
  return e.issues.map((i) => ({ field: String(i.path[0] ?? ''), message: i.message.slice(0, 200) }));
}

// ───────── file mẫu ─────────

const SAMPLE: Record<ImportType, Record<string, string | number>[]> = {
  CATALOG: [
    {
      category: 'Trái cây > Cam',
      product: 'Cam sành',
      sku_code: 'CAM-SANH-KG',
      name: 'Cam sành (kg)',
      sale_unit_type: 'WEIGHT',
      retail_price: 45000,
      scale_plu: '00101',
      sold_by_scale: 'có',
    },
    {
      category: 'Trái cây > Táo',
      product: 'Táo Envy',
      sku_code: 'TAO-ENVY-QUA',
      name: 'Táo Envy (quả)',
      sale_unit_type: 'PIECE_FIXED',
      retail_price: 35000,
      barcode: '8938505970011',
    },
  ],
  SUPPLIER: [{ code: 'NCC-MAU', name: 'Vườn mẫu (DEV)', type: 'FARM', payment_terms_days: 7 }],
};

/** File mẫu .xlsx: sheet dữ liệu (tiêu đề "Tên (khoa)", 1–2 dòng mẫu) + sheet hướng dẫn. */
export async function templateXlsx(t: ImportType): Promise<Buffer> {
  const cols = columnsOf(t);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'fruit-retail';
  const ws = wb.addWorksheet(t === 'CATALOG' ? 'SKU' : 'NCC');
  ws.columns = cols.map((c) => ({ header: `${c.label} (${c.key})${c.required ? ' *' : ''}`, key: c.key, width: 22 }));
  ws.getRow(1).font = { bold: true };
  for (const r of SAMPLE[t]) ws.addRow(r);
  // mã vạch / PLU / SĐT / số TK là CHUỖI (Excel tự bỏ số 0 đầu nếu để kiểu số)
  for (const k of ['scale_plu', 'barcode', 'phone', 'account_number', 'sku_code', 'code'])
    if (cols.some((c) => c.key === k)) ws.getColumn(k).numFmt = '@';
  const help = wb.addWorksheet('Hướng dẫn');
  help.columns = [
    { header: 'Cột', key: 'col', width: 32 },
    { header: 'Bắt buộc', key: 'req', width: 10 },
    { header: 'Ghi chú', key: 'hint', width: 80 },
  ];
  help.getRow(1).font = { bold: true };
  for (const c of cols) help.addRow({ col: `${c.label} (${c.key})`, req: c.required ? 'có' : '', hint: c.hint });
  help.addRow({});
  help.addRow({ col: 'Lưu ý', hint: 'Không dùng công thức (file có công thức bị từ chối). Tối đa 5.000 dòng, 5 MB.' });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
