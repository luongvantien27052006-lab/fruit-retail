import { describe, expect, it } from 'vitest';
import { SkusService } from '../src/catalog/skus.service';

// Review bảo mật cổng CP04 L2: API SKU (catalog:read) không trả giá lẻ cho người thiếu price:read (vd WAREHOUSE_STAFF —
// ma trận §2.2), cùng quy tắc file xuất danh sách / API /admin/prices.
const wire = {
  id: 'x',
  retail_price_per_kg: '52000',
  retail_price_per_unit: null,
  units: [{ id: 'u', price_per_unit: '72000' }],
};
const svc = (perms: string[] | null) =>
  new SkusService(
    {} as never,
    {} as never,
    { get: () => (perms ? { permissions: new Set(perms) } : undefined) } as never,
  ) as unknown as { view: (w: typeof wire) => typeof wire; viewUnit: (u: { price_per_unit: unknown }) => unknown };

describe('giá trong API SKU theo quyền price:read', () => {
  it('thiếu price:read ⇒ mọi trường giá null; có ⇒ giữ nguyên; worker (không principal) ⇒ giữ nguyên', () => {
    expect(svc(['catalog:read']).view(wire)).toEqual({
      id: 'x',
      retail_price_per_kg: null,
      retail_price_per_unit: null,
      units: [{ id: 'u', price_per_unit: null }],
    });
    expect(svc(['catalog:read']).viewUnit({ price_per_unit: '1' })).toEqual({ price_per_unit: null });
    expect(svc(['catalog:read', 'price:read']).view(wire)).toEqual(wire);
    expect(svc(null).view(wire)).toEqual(wire);
  });
});
