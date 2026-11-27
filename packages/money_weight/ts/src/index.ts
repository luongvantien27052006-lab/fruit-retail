/**
 * Tiền và cân — helper DUY NHẤT của dự án (ADR-004, ADR-016, FR-INV-01…03).
 * Tiền: bigint VND (đồng). Khối lượng: số nguyên gram. Không dùng number cho tiền.
 */

export type MoneyWeightErrorCode =
  'NEGATIVE' | 'NOT_INTEGER' | 'INVALID_WIRE' | 'OUT_OF_RANGE' | 'INVALID_UNIT' | 'VARIABLE_UNIT';

export class MoneyWeightError extends Error {
  constructor(
    public readonly code: MoneyWeightErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MoneyWeightError';
  }
}

/** Giới hạn int64 có dấu — khớp BIGINT PostgreSQL và int Dart. */
const INT64_MAX = 9_223_372_036_854_775_807n;
const INT64_MIN = -9_223_372_036_854_775_808n;
/** Chuỗi truyền qua API: số nguyên, tối đa 18 chữ số (an toàn trong int64), không khoảng trắng, không mũ. */
const WIRE_RE = /^(0|-?[1-9][0-9]{0,17})$/;
/** Gram tối đa = INTEGER (int32) PostgreSQL (FR-INV-02). */
const GRAMS_MAX = 2_147_483_647;

function assertGrams(grams: number): bigint {
  if (!Number.isSafeInteger(grams))
    throw new MoneyWeightError('NOT_INTEGER', `Khối lượng phải là số nguyên gram: ${grams}`);
  if (grams < 0) throw new MoneyWeightError('NEGATIVE', `Khối lượng âm: ${grams}`);
  if (grams > GRAMS_MAX) throw new MoneyWeightError('OUT_OF_RANGE', `Khối lượng vượt int32: ${grams}`);
  return BigInt(grams);
}

function assertNonNegative(amount: bigint, label: string): void {
  if (typeof amount !== 'bigint') throw new MoneyWeightError('NOT_INTEGER', `${label} phải là bigint`);
  if (amount < 0n) throw new MoneyWeightError('NEGATIVE', `${label} âm: ${amount}`);
  if (amount > INT64_MAX) throw new MoneyWeightError('OUT_OF_RANGE', `${label} vượt int64`);
}

function assertRange(v: bigint): bigint {
  if (v > INT64_MAX || v < INT64_MIN) throw new MoneyWeightError('OUT_OF_RANGE', `Vượt int64: ${v}`);
  return v;
}

/**
 * Thành tiền hàng cân = round_half_up(pricePerKg × grams / 1000), chính xác 1 đồng (FR-INV-03).
 * Đầu vào không âm; đảo/hoàn dùng số đã ghi, không tính lại.
 */
export function lineAmount(pricePerKg: bigint, grams: number): bigint {
  assertNonNegative(pricePerKg, 'Đơn giá/kg');
  const g = assertGrams(grams);
  return assertRange((pricePerKg * g + 500n) / 1000n);
}

/** Thành tiền hàng đếm = đơn giá × số lượng. */
export function unitsAmount(pricePerUnit: bigint, units: number): bigint {
  assertNonNegative(pricePerUnit, 'Đơn giá');
  const u = assertGrams(units);
  return assertRange(pricePerUnit * u);
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Hiển thị VND kiểu Việt Nam: 1.250.000đ (§15). */
export function formatVnd(amount: bigint): string {
  if (typeof amount !== 'bigint') throw new MoneyWeightError('NOT_INTEGER', 'Số tiền phải là bigint');
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  return `${neg ? '-' : ''}${groupThousands(abs.toString())}đ`;
}

/** Hiển thị khối lượng: 0,845 kg — luôn 3 chữ số thập phân, dấu phẩy (§15). */
export function formatKg(grams: number): string {
  const g = assertGrams(grams);
  const kg = g / 1000n;
  const rest = (g % 1000n).toString().padStart(3, '0');
  return `${groupThousands(kg.toString())},${rest} kg`;
}

/** Chuỗi API → bigint (ADR-016). Từ chối số thực, mũ, khoảng trắng, quá 18 chữ số. */
export function fromWire(wire: string): bigint {
  if (typeof wire !== 'string' || !WIRE_RE.test(wire))
    throw new MoneyWeightError('INVALID_WIRE', `Chuỗi tiền không hợp lệ: "${String(wire)}"`);
  return BigInt(wire);
}

/** bigint → chuỗi API (ADR-016). */
export function toWire(amount: bigint): string {
  if (typeof amount !== 'bigint') throw new MoneyWeightError('NOT_INTEGER', 'Số tiền phải là bigint');
  const s = assertRange(amount).toString();
  if (!WIRE_RE.test(s)) throw new MoneyWeightError('OUT_OF_RANGE', `Quá 18 chữ số: ${s}`);
  return s;
}

/** Cách quy đổi của một đơn vị bán/mua (`sku_units`, §21.3.1): đúng MỘT trong factorG / factorUnits / isVariable. */
export interface UnitConversion {
  factorG: number | null;
  factorUnits: number | null;
  isVariable: boolean;
}

/** Số lượng theo đơn vị tồn chuẩn của SKU: gram (hàng cân) hoặc số đơn vị (hàng đếm). */
export interface StockQuantity {
  base: 'GRAM' | 'COUNT';
  amount: number;
}

/**
 * Quy đổi `qty` đơn vị bán/mua về đơn vị tồn (§21.3.1): hộp 500 g × 2 ⇒ 1000 g; thùng 24 quả × 2 ⇒ 48.
 * Đơn vị danh nghĩa (thùng/sọt "~5 kg") KHÔNG quy đổi cứng ⇒ `VARIABLE_UNIT` (phải cân thực khi nhận — §5.3).
 */
export function toStockQuantity(conv: UnitConversion, qty: number): StockQuantity {
  const set = (conv.factorG !== null ? 1 : 0) + (conv.factorUnits !== null ? 1 : 0) + (conv.isVariable ? 1 : 0);
  if (set !== 1) throw new MoneyWeightError('INVALID_UNIT', 'Đơn vị phải có đúng một cách quy đổi');
  if (conv.isVariable)
    throw new MoneyWeightError('VARIABLE_UNIT', 'Đơn vị danh nghĩa không quy đổi cứng — cân thực khi nhận');
  const factor = (conv.factorG ?? conv.factorUnits) as number;
  if (!Number.isSafeInteger(factor) || factor < 1 || factor > GRAMS_MAX)
    throw new MoneyWeightError('INVALID_UNIT', `Hệ số quy đổi không hợp lệ: ${factor}`);
  const q = assertGrams(qty);
  const amount = q * BigInt(factor);
  if (amount > BigInt(GRAMS_MAX)) throw new MoneyWeightError('OUT_OF_RANGE', `Số lượng quy đổi vượt int32: ${amount}`);
  return { base: conv.factorG !== null ? 'GRAM' : 'COUNT', amount: Number(amount) };
}
