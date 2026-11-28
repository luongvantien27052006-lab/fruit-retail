import { describe, expect, it } from 'vitest';
import { LOG_SERIALIZERS } from '../src/app.module';
import { safeUrl } from '../src/common/log-url';

// Review bảo mật cổng CP04: SĐT / STK không lọt log qua query string (ADR-015).
describe('URL trong log', () => {
  it('che tham số chữ tự do và mọi giá trị ≥ 7 chữ số; giữ đường dẫn + tham số vô hại', () => {
    expect(safeUrl('/v1/admin/suppliers?q=0901234567&limit=100')).toBe('/v1/admin/suppliers?q=[redacted]&limit=100');
    expect(safeUrl('/v1/admin/skus?q=cam&include_archived=true')).toBe(
      '/v1/admin/skus?q=[redacted]&include_archived=true',
    );
    expect(safeUrl('/v1/x?foo=%2B84901234567')).toBe('/v1/x?foo=[redacted]');
    expect(safeUrl('/v1/admin/barcode-rules/decode?code=2000123008455')).toBe(
      '/v1/admin/barcode-rules/decode?code=[redacted]',
    );
    expect(safeUrl('/v1/admin/skus?after=SKU-1&limit=50')).toBe('/v1/admin/skus?after=SKU-1&limit=50');
    expect(safeUrl('/v1/health')).toBe('/v1/health');
    expect(safeUrl(undefined)).toBe(undefined);
  });
  it('serializer req của pino-http dùng safeUrl', () => {
    const out = LOG_SERIALIZERS.req({ url: '/v1/admin/suppliers?q=0901234567', method: 'GET' } as { url: string });
    expect(out).toMatchObject({ url: '/v1/admin/suppliers?q=[redacted]', method: 'GET' });
  });
});
