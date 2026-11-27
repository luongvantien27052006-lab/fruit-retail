import { isValidEan13 } from '@fruit/money_weight';

/** Bảng mã EAN-13 (GS1 General Specifications §5.2.1): L / G / R cho chữ số 0–9; chữ số đầu chọn mẫu L/G của nhóm trái. */
const L = [
  '0001101',
  '0011001',
  '0010011',
  '0111101',
  '0100011',
  '0110001',
  '0101111',
  '0111011',
  '0110111',
  '0001011',
];
const G = [
  '0100111',
  '0110011',
  '0011011',
  '0100001',
  '0011101',
  '0111001',
  '0000101',
  '0010001',
  '0001001',
  '0010111',
];
const R = [
  '1110010',
  '1100110',
  '1101100',
  '1000010',
  '1011100',
  '1001110',
  '1010000',
  '1000100',
  '1001000',
  '1110100',
];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** 95 mô-đun (1 = vạch đen): 101 + 6 trái + 01010 + 6 phải + 101. Mã sai số kiểm ⇒ lỗi. */
export function ean13Modules(code: string): string {
  if (!isValidEan13(code)) throw new Error('Mã EAN-13 không hợp lệ');
  const d = [...code].map(Number);
  const first = d[0] as number;
  const parity = PARITY[first] as string;
  let m = '101';
  for (let i = 1; i <= 6; i++) m += (parity[i - 1] === 'L' ? L : G)[d[i] as number];
  m += '01010';
  for (let i = 7; i <= 12; i++) m += R[d[i] as number];
  return m + '101';
}

/** SVG mã vạch (chỉ chữ số — không có dữ liệu người dùng trong SVG ngoài mã đã kiểm). */
export function ean13Svg(code: string, opts: { moduleWidth?: number; height?: number } = {}): string {
  const mw = opts.moduleWidth ?? 1.4;
  const h = opts.height ?? 36;
  const m = ean13Modules(code);
  const quiet = 11; // vùng trắng trái ≥ 11 mô-đun
  const rects: string[] = [];
  for (let i = 0; i < m.length; i++) {
    if (m[i] !== '1') continue;
    let j = i;
    while (m[j + 1] === '1') j++;
    rects.push(
      `<rect x="${((quiet + i) * mw).toFixed(2)}" y="0" width="${((j - i + 1) * mw).toFixed(2)}" height="${h}"/>`,
    );
    i = j;
  }
  const w = (quiet + 95 + 7) * mw;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(2)} ${h + 12}" width="${w.toFixed(2)}" height="${h + 12}" role="img" aria-label="${code}">` +
    `<g fill="#000">${rects.join('')}</g>` +
    `<text x="${(w / 2).toFixed(2)}" y="${h + 11}" font-family="monospace" font-size="11" text-anchor="middle">${code}</text></svg>`
  );
}
