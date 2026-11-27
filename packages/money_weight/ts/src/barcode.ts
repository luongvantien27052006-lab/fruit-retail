/**
 * Mã vạch theo quy tắc (§6.5, §21.3.8, Phụ lục B) — DÙNG CHUNG TS/Dart (vector `vectors/barcode.vectors.json`).
 * Mẫu: hằng (số / chữ HOA / -) và token {PLU:n} {W:n} {P:n} {C} {ID} {CODE}; khớp CHECK `barcode_rules_pattern` (0009).
 * W = khối lượng nhúng (× value_scale gram), P = tiền nhúng (× value_scale đồng), C = số kiểm EAN-13 (cuối mẫu),
 * {ID} / {CODE} = phần biến đổi (tối đa một, không đi cùng {C}).
 */

export type BarcodeRuleType = 'WEIGHT' | 'PRICE' | 'PRODUCT' | 'BATCH' | 'ORDER' | 'STAFF';
export type BarcodeErrorCode = 'INVALID_PATTERN' | 'INVALID_VALUE';

export class BarcodeError extends Error {
  constructor(
    public readonly code: BarcodeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BarcodeError';
  }
}

export type Segment =
  | { kind: 'lit'; text: string }
  | { kind: 'plu'; len: number }
  | { kind: 'w'; len: number }
  | { kind: 'p'; len: number }
  | { kind: 'c' }
  | { kind: 'id' }
  | { kind: 'code' };

export interface BarcodeRuleDef {
  code: string;
  type: BarcodeRuleType;
  pattern: string;
  /** 1 | 10 | 100 */
  valueScale: number;
  ean13Checksum: boolean;
}

export interface Decoded {
  rule: string;
  type: BarcodeRuleType;
  plu?: string;
  /** gram (W × value_scale) */
  grams?: number;
  /** đồng (P × value_scale) */
  amount?: bigint;
  /** phần biến đổi {ID} / {CODE} */
  value?: string;
}

export type DecodeResult =
  { ok: true; decoded: Decoded } | { ok: false; reason: 'NO_MATCH' | 'CHECKSUM'; rule?: string };

const TOKEN_RE = /\{(PLU|W|P):([1-9])\}|\{C\}|\{ID\}|\{CODE\}|[0-9A-Z-]/g;
const VARIABLE_RE = /^[0-9A-Z-]{1,64}$/;

/** Phân tích mẫu; sai cú pháp / tổ hợp không hợp lệ ⇒ BarcodeError('INVALID_PATTERN'). */
export function parsePattern(
  pattern: string,
  opts: { type?: BarcodeRuleType; ean13Checksum?: boolean } = {},
): Segment[] {
  const bad = (m: string) => new BarcodeError('INVALID_PATTERN', m);
  if (pattern.length === 0 || pattern.length > 64) throw bad('Mẫu dài 1–64 ký tự');
  const segs: Segment[] = [];
  let consumed = 0;
  for (const m of pattern.matchAll(TOKEN_RE)) {
    if (m.index !== consumed) throw bad(`Ký tự không hợp lệ ở vị trí ${consumed + 1}`);
    consumed += m[0].length;
    const t = m[0];
    if (m[1]) segs.push({ kind: m[1] === 'PLU' ? 'plu' : m[1] === 'W' ? 'w' : 'p', len: Number(m[2]) });
    else if (t === '{C}') segs.push({ kind: 'c' });
    else if (t === '{ID}') segs.push({ kind: 'id' });
    else if (t === '{CODE}') segs.push({ kind: 'code' });
    else {
      const last = segs.at(-1);
      if (last?.kind === 'lit') last.text += t;
      else segs.push({ kind: 'lit', text: t });
    }
  }
  if (consumed !== pattern.length) throw bad(`Ký tự không hợp lệ ở vị trí ${consumed + 1}`);
  const count = (k: Segment['kind']) => segs.filter((s) => s.kind === k).length;
  if (count('plu') > 1 || count('w') > 1 || count('p') > 1 || count('c') > 1) throw bad('Mỗi token tối đa một lần');
  if (count('w') && count('p')) throw bad('Không nhúng cả khối lượng và tiền');
  const variable = count('id') + count('code');
  if (variable > 1) throw bad('Tối đa một phần biến đổi {ID} / {CODE}');
  if (count('c') && segs.at(-1)?.kind !== 'c') throw bad('{C} phải ở cuối mẫu');
  if (variable && count('c')) throw bad('Phần biến đổi không đi cùng số kiểm {C}');
  if (opts.type === 'WEIGHT' && !(count('plu') && count('w'))) throw bad('Quy tắc WEIGHT cần {PLU:n} và {W:n}');
  if (opts.type === 'PRICE' && !(count('plu') && count('p'))) throw bad('Quy tắc PRICE cần {PLU:n} và {P:n}');
  // tem cân nội bộ: tiền tố 20–29 (§6.5, GS1 dành cho dùng nội bộ) — không thì mã hàng đóng gói bị đọc nhầm thành hàng cân
  if ((opts.type === 'WEIGHT' || opts.type === 'PRICE') && !/^2[0-9]/.test(segs[0]?.kind === 'lit' ? segs[0].text : ''))
    throw bad('Tem cân (WEIGHT / PRICE) phải bắt đầu bằng tiền tố 20–29');
  // PLU của SKU đúng 5 chữ số (CHECK skus_plu) — {PLU:n} n > 5 không bao giờ khớp
  if (segs.some((s) => s.kind === 'plu' && s.len > 5)) throw bad('{PLU:n} tối đa 5 chữ số');
  if (count('c') && !opts.ean13Checksum) throw bad('{C} chỉ dùng khi bật kiểm số EAN-13');
  if (opts.ean13Checksum) {
    if (!count('c')) throw bad('Kiểm số EAN-13 cần {C} ở cuối');
    if (fixedLength(segs) !== 13) throw bad('Mẫu EAN-13 phải dài đúng 13 ký tự');
    if (segs.some((s) => s.kind === 'lit' && !/^[0-9]+$/.test(s.text))) throw bad('Mẫu EAN-13 chỉ gồm chữ số');
  }
  return segs;
}

function fixedLength(segs: Segment[]): number | null {
  let n = 0;
  for (const s of segs) {
    if (s.kind === 'lit') n += s.text.length;
    else if (s.kind === 'c') n += 1;
    else if (s.kind === 'id' || s.kind === 'code') return null;
    else n += s.len;
  }
  return n;
}

/** Số kiểm EAN-13 cho 12 chữ số đầu (Phụ lục B): S = lẻ × 1 + chẵn × 3; C = (10 − S mod 10) mod 10. */
export function ean13CheckDigit(first12: string): number {
  if (!/^[0-9]{12}$/.test(first12)) throw new BarcodeError('INVALID_VALUE', 'Cần đúng 12 chữ số');
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (s % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^[0-9]{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/** Giải một mã theo MỘT quy tắc: không khớp ⇒ NO_MATCH; khớp mẫu nhưng sai số kiểm ⇒ CHECKSUM. */
export function decodeWith(rule: BarcodeRuleDef, barcode: string): DecodeResult {
  const segs = parsePattern(rule.pattern, { type: rule.type, ean13Checksum: rule.ean13Checksum });
  const fixed = fixedLength(segs);
  if (fixed !== null && barcode.length !== fixed) return { ok: false, reason: 'NO_MATCH' };
  // phần biến đổi chiếm phần còn lại (độ dài = tổng − phần cố định)
  const fixedPart = segs.reduce(
    (n, s) =>
      n + (s.kind === 'lit' ? s.text.length : s.kind === 'c' ? 1 : s.kind === 'id' || s.kind === 'code' ? 0 : s.len),
    0,
  );
  const varLen = barcode.length - fixedPart;
  if (fixed === null && varLen < 1) return { ok: false, reason: 'NO_MATCH' };
  const d: Decoded = { rule: rule.code, type: rule.type };
  let i = 0;
  for (const s of segs) {
    if (s.kind === 'lit') {
      if (barcode.slice(i, i + s.text.length) !== s.text) return { ok: false, reason: 'NO_MATCH' };
      i += s.text.length;
    } else if (s.kind === 'c') {
      if (!/^[0-9]$/.test(barcode[i] ?? '')) return { ok: false, reason: 'NO_MATCH' };
      i += 1;
    } else if (s.kind === 'id' || s.kind === 'code') {
      const v = barcode.slice(i, i + varLen);
      if (!VARIABLE_RE.test(v)) return { ok: false, reason: 'NO_MATCH' };
      d.value = v;
      i += varLen;
    } else {
      const v = barcode.slice(i, i + s.len);
      if (!new RegExp(`^[0-9]{${s.len}}$`).test(v)) return { ok: false, reason: 'NO_MATCH' };
      if (s.kind === 'plu') d.plu = v;
      else if (s.kind === 'w') d.grams = Number(v) * rule.valueScale;
      else d.amount = BigInt(v) * BigInt(rule.valueScale);
      i += s.len;
    }
  }
  if (rule.ean13Checksum && !isValidEan13(barcode)) return { ok: false, reason: 'CHECKSUM', rule: rule.code };
  return { ok: true, decoded: d };
}

/**
 * Thử các quy tắc theo thứ tự (đã sắp theo priority, chỉ quy tắc đang bật): khớp đầu tiên thắng. Quy tắc khớp CẤU TRÚC mà
 * sai số kiểm ⇒ dừng, CHECKSUM (tem in lỗi / quét sai) — không rơi xuống quy tắc sau (vd `{CODE}` khớp mọi mã).
 */
export function decodeBarcode(rules: readonly BarcodeRuleDef[], barcode: string): DecodeResult {
  for (const r of rules) {
    const res = decodeWith(r, barcode);
    if (res.ok || res.reason === 'CHECKSUM') return res;
  }
  return { ok: false, reason: 'NO_MATCH' };
}

/** Tạo mã theo quy tắc (tem cân / tem kệ / thử): giá trị gram / đồng chia value_scale phải chẵn và vừa độ dài. */
export function encodeWith(
  rule: BarcodeRuleDef,
  v: { plu?: string; grams?: number; amount?: bigint; value?: string },
): string {
  const segs = parsePattern(rule.pattern, { type: rule.type, ean13Checksum: rule.ean13Checksum });
  const bad = (m: string) => new BarcodeError('INVALID_VALUE', m);
  const num = (x: bigint, len: number, what: string) => {
    if (x < 0n) throw bad(`${what} âm`);
    const s = x.toString();
    if (s.length > len) throw bad(`${what} vượt ${len} chữ số`);
    return s.padStart(len, '0');
  };
  const scaled = (x: bigint, what: string) => {
    const k = BigInt(rule.valueScale);
    if (x % k !== 0n) throw bad(`${what} phải là bội của ${rule.valueScale}`);
    return x / k;
  };
  let out = '';
  for (const s of segs) {
    if (s.kind === 'lit') out += s.text;
    else if (s.kind === 'c') out += String(ean13CheckDigit(out));
    else if (s.kind === 'id' || s.kind === 'code') {
      if (!v.value || !VARIABLE_RE.test(v.value)) throw bad('Phần biến đổi: 1–64 ký tự số / chữ HOA / -');
      out += v.value;
    } else if (s.kind === 'plu') {
      if (!v.plu || !/^[0-9]+$/.test(v.plu) || v.plu.length > s.len) throw bad(`PLU tối đa ${s.len} chữ số`);
      out += v.plu.padStart(s.len, '0');
    } else if (s.kind === 'w') {
      if (v.grams === undefined || !Number.isSafeInteger(v.grams)) throw bad('Khối lượng phải là số nguyên gram');
      out += num(scaled(BigInt(v.grams), 'Khối lượng'), s.len, 'Khối lượng');
    } else {
      if (v.amount === undefined) throw bad('Thiếu tiền');
      out += num(scaled(v.amount, 'Tiền'), s.len, 'Tiền');
    }
  }
  if (out.length > 64) throw bad('Mã tạo ra dài quá 64 ký tự');
  return out;
}
