import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BarcodeError,
  type BarcodeRuleDef,
  decodeBarcode,
  decodeWith,
  encodeWith,
  isValidEan13,
  parsePattern,
} from '../src/index.js';

interface In {
  plu?: string;
  grams?: number;
  amount?: string;
  value?: string;
}
interface V {
  rules: Record<string, BarcodeRuleDef>;
  ean13: { code: string; valid: boolean }[];
  decode: {
    id: string;
    rule: string;
    barcode: string;
    ok: boolean;
    reason?: string;
    expected?: { plu?: string; grams?: number; amount?: string; value?: string };
  }[];
  decodeFirst: {
    id: string;
    rules: string[];
    barcode: string;
    ok: boolean;
    rule?: string;
    reason?: string;
    failRule?: string;
  }[];
  encode: { id: string; rule: string; input: In; expected: string }[];
  encodeRejects: { id: string; rule: string; input: In; error: string }[];
  patternRejects: { id: string; pattern: string; type: BarcodeRuleDef['type']; ean13Checksum: boolean }[];
}
const v = JSON.parse(readFileSync(new URL('../../vectors/barcode.vectors.json', import.meta.url), 'utf8')) as V;
const rule = (k: string) => {
  const r = v.rules[k];
  if (!r) throw new Error(`thiếu quy tắc ${k}`);
  return r;
};
const input = (i: In) => ({ ...i, amount: i.amount === undefined ? undefined : BigInt(i.amount) });

describe('EAN-13 — Phụ lục B', () => {
  it.each(v.ean13)('$code ⇒ $valid', (c) => expect(isValidEan13(c.code)).toBe(c.valid));
});

describe('giải mã theo một quy tắc', () => {
  it.each(v.decode)('$id: $rule $barcode', (c) => {
    const r = decodeWith(rule(c.rule), c.barcode);
    expect(r.ok).toBe(c.ok);
    if (r.ok) {
      const d = r.decoded;
      expect({
        ...(d.plu !== undefined ? { plu: d.plu } : {}),
        ...(d.grams !== undefined ? { grams: d.grams } : {}),
        ...(d.amount !== undefined ? { amount: d.amount.toString() } : {}),
        ...(d.value !== undefined ? { value: d.value } : {}),
      }).toEqual(c.expected);
      expect(d.rule).toBe(c.rule);
    } else expect(r.reason).toBe(c.reason);
  });
});

describe('giải mã theo thứ tự quy tắc', () => {
  it.each(v.decodeFirst)('$id: $barcode', (c) => {
    const r = decodeBarcode(c.rules.map(rule), c.barcode);
    expect(r.ok).toBe(c.ok);
    if (r.ok) expect(r.decoded.rule).toBe(c.rule);
    else {
      expect(r.reason).toBe(c.reason);
      if (c.failRule) expect(r.rule).toBe(c.failRule);
    }
  });
});

describe('tạo mã', () => {
  it.each(v.encode)('$id: $rule ⇒ $expected', (c) => expect(encodeWith(rule(c.rule), input(c.input))).toBe(c.expected));
  it.each(v.encodeRejects)('$id: $rule từ chối', (c) => {
    try {
      encodeWith(rule(c.rule), input(c.input));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BarcodeError);
      expect((e as BarcodeError).code).toBe(c.error);
    }
  });
  it('mã tạo ra giải lại được (vòng tròn)', () => {
    for (const c of v.encode) {
      const r = decodeWith(rule(c.rule), c.expected);
      expect(r.ok).toBe(true);
    }
  });
});

describe('mẫu không hợp lệ', () => {
  it.each(v.patternRejects)('$id: "$pattern"', (c) => {
    expect(() => parsePattern(c.pattern, { type: c.type, ean13Checksum: c.ean13Checksum })).toThrow(BarcodeError);
  });
});
