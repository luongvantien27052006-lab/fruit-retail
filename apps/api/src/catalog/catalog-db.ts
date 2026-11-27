import { dbErrorDetails, findSqlState, isDbError } from '../common/db-errors';
import { AppError } from '../common/errors';
import { rule } from './catalog-rules';

/** Ràng buộc unique của danh mục ⇒ tên trường báo cho client (409). */
const UNIQUE_FIELDS: [RegExp, string][] = [
  [/sku_code/, 'sku_code'],
  [/scale_plu/, 'scale_plu'],
  [/barcode/, 'barcode'],
  [/sku_units_name_active/, 'name'],
  [/categories_sibling_name/, 'name'],
  [/units_pkey|"code"/, 'code'],
];

/** Thông điệp RAISE do dự án viết trong trigger danh mục (không chứa dữ liệu người dùng ngoài mã đơn vị/kiểu bán). */
const OWN_RAISE = /^(categories|sku_units|skus|products|units|sku_default_locations|locations): /;

function originalMessage(err: unknown): string | undefined {
  const m = (err as { meta?: { driverAdapterError?: { cause?: { originalMessage?: unknown } } } }).meta
    ?.driverAdapterError?.cause?.originalMessage;
  return typeof m === 'string' ? m : undefined;
}

/**
 * Lỗi DB của thao tác danh mục ⇒ mã nghiệp vụ: trùng (23505/P2002) ⇒ 409 kèm trường; CHECK / trigger quy tắc (23514) ⇒
 * 422 CATALOG_RULE_VIOLATION. Lỗi khác giữ nguyên (ErrorFilter ánh xạ chung).
 */
export function catalogDbError(err: unknown): unknown {
  if (!isDbError(err)) return err;
  const s = findSqlState(err);
  const code = (err as { code?: unknown }).code;
  const d = dbErrorDetails(err);
  const where = JSON.stringify([
    d['constraint'] ?? null,
    (err as { meta?: { target?: unknown } }).meta?.target ?? null,
  ]);
  if (s === '23505' || code === 'P2002') {
    const field = UNIQUE_FIELDS.find(([re]) => re.test(where))?.[1];
    return new AppError(
      'VERSION_CONFLICT',
      field ? `Trùng ${field} với bản ghi khác` : 'Dữ liệu trùng với bản ghi đã có',
      {
        reason: 'UNIQUE',
        ...(field ? { field } : {}),
      },
    );
  }
  if (s === '23514') {
    const msg = originalMessage(err);
    // CHECK: adapter không điền `constraint` — tên nằm trong thông điệp (chỉ tên, không có giá trị)
    const check = msg?.match(/violates check constraint "([a-z0-9_]+)"/)?.[1];
    const constraint = typeof d['constraint'] === 'string' ? d['constraint'] : check;
    return rule(msg && OWN_RAISE.test(msg) ? msg : 'Vi phạm quy tắc danh mục', constraint ? { constraint } : {});
  }
  return err;
}

/** Chạy thao tác ghi danh mục, đổi lỗi DB sang mã nghiệp vụ. */
export async function catalogWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw catalogDbError(e);
  }
}

/**
 * Kiểm số kiểm tra GS1 (mod 10) cho mã toàn số dài 8/12/13/14 (EAN-8, UPC-A, EAN-13, GTIN-14). Mã nội bộ có chữ hoặc độ
 * dài khác không kiểm. Sai ⇒ 422 BARCODE_CHECKSUM_INVALID (§13.1).
 */
export function assertGs1Checksum(barcode: string): void {
  if (!/^[0-9]+$/.test(barcode) || ![8, 12, 13, 14].includes(barcode.length)) return;
  const digits = [...barcode].map(Number);
  const check = digits.pop() as number;
  let sum = 0;
  digits.reverse().forEach((x, i) => (sum += x * (i % 2 === 0 ? 3 : 1)));
  if ((10 - (sum % 10)) % 10 !== check)
    throw new AppError('BARCODE_CHECKSUM_INVALID', 'Mã vạch sai số kiểm tra', { field: 'barcode' });
}
