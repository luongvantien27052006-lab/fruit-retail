import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatKg, formatVnd, fromWire, lineAmount, MoneyWeightError, toWire, unitsAmount } from '../src/index.js';

interface V {
  lineAmount: { id: string; pricePerKg: string; grams: number; expected: string }[];
  lineAmountRejects: { id: string; pricePerKg: string; grams: number; error: string }[];
  unitsAmount: { id: string; pricePerUnit: string; units: number; expected: string }[];
  unitsAmountRejects: { id: string; pricePerUnit: string; units: number; error: string }[];
  formatVnd: { amount: string; expected: string }[];
  formatKg: { grams: number; expected: string }[];
  wire: { wire: string; ok: boolean }[];
}
const v = JSON.parse(readFileSync(new URL('../../vectors/money_weight.vectors.json', import.meta.url), 'utf8')) as V;

describe('lineAmount — FR-INV-03, Phụ lục A', () => {
  it.each(v.lineAmount)('$id: $pricePerKg đ/kg × $grams g = $expected', (c) => {
    const r = lineAmount(BigInt(c.pricePerKg), c.grams);
    expect(typeof r).toBe('bigint');
    expect(r).toBe(BigInt(c.expected));
  });
  it.each(v.lineAmountRejects)('$id từ chối ($error)', (c) => {
    expect(() => lineAmount(BigInt(c.pricePerKg), c.grams)).toThrowError(MoneyWeightError);
    try {
      lineAmount(BigInt(c.pricePerKg), c.grams);
    } catch (e) {
      expect((e as MoneyWeightError).code).toBe(c.error);
    }
  });
});

describe('unitsAmount', () => {
  it.each(v.unitsAmount)('$id', (c) => expect(unitsAmount(BigInt(c.pricePerUnit), c.units)).toBe(BigInt(c.expected)));
  it.each(v.unitsAmountRejects)('$id từ chối ($error)', (c) => {
    expect(() => unitsAmount(BigInt(c.pricePerUnit), c.units)).toThrowError(expect.objectContaining({ code: c.error }));
  });
});

describe('formatVnd / formatKg', () => {
  it.each(v.formatVnd)('$amount → $expected', (c) => expect(formatVnd(BigInt(c.amount))).toBe(c.expected));
  it.each(v.formatKg)('$grams g → $expected', (c) => expect(formatKg(c.grams)).toBe(c.expected));
});

describe('wire codec — ADR-016', () => {
  it.each(v.wire)('"$wire" hợp lệ = $ok', (c) => {
    if (c.ok) expect(toWire(fromWire(c.wire))).toBe(c.wire);
    else expect(() => fromWire(c.wire)).toThrowError(MoneyWeightError);
  });
  it('toWire chỉ nhận bigint', () => {
    // @ts-expect-error — số thực/number bị chặn ở kiểu
    expect(() => toWire(1.5)).toThrowError(MoneyWeightError);
  });
});
