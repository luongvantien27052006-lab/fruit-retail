import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { LOG_SERIALIZERS, REDACT_PATHS } from '../src/app.module';
import { safeUrl } from '../src/common/log-url';

// Review bảo mật cổng CP04: SĐT / STK không lọt log qua query string (ADR-015).
// pino-http bọc serializer tùy biến SAU serializer chuẩn (thêm `query` = object Express đã phân tích) ⇒ test đi đúng đường đó.
const req = createRequire(require.resolve('pino-http'));
const std = req('pino-std-serializers') as {
  wrapRequestSerializer: (f: (r: Record<string, unknown>) => unknown) => (raw: unknown) => unknown;
};

describe('URL trong log', () => {
  it('che tham số chữ tự do và mọi giá trị ≥ 7 chữ số; giữ đường dẫn + tham số vô hại', () => {
    expect(safeUrl('/v1/admin/suppliers?q=0901234567&limit=100')).toBe('/v1/admin/suppliers?q=[redacted]&limit=100');
    expect(safeUrl('/v1/admin/skus?q=cam&include_archived=true')).toBe(
      '/v1/admin/skus?q=[redacted]&include_archived=true',
    );
    expect(safeUrl('/v1/x?foo=%2B84901234567')).toBe('/v1/x?foo=[redacted]');
    // tên tham số mã hóa, SĐT có dấu chấm (review bảo mật vòng 2)
    expect(safeUrl('/v1/admin/suppliers?%71=090.123.4567')).toBe('/v1/admin/suppliers?%71=[redacted]');
    expect(safeUrl('/v1/x?a=090.123.4567')).toBe('/v1/x?a=[redacted]');
    expect(safeUrl('/v1/admin/barcode-rules/decode?code=2000123008455')).toBe(
      '/v1/admin/barcode-rules/decode?code=[redacted]',
    );
    expect(safeUrl('/v1/admin/skus?after=SKU-1&limit=50')).toBe('/v1/admin/skus?after=SKU-1&limit=50');
    expect(safeUrl('/v1/health')).toBe('/v1/health');
    expect(safeUrl(undefined)).toBe(undefined);
  });

  it('dòng log thật (serializer chuẩn pino-http + REDACT_PATHS) không chứa SĐT, kể cả qua req.query', () => {
    const lines: string[] = [];
    const out = new Writable({
      write(chunk: Buffer, _e, cb) {
        lines.push(chunk.toString('utf8'));
        cb();
      },
    });
    const log = pino(
      { serializers: { req: std.wrapRequestSerializer(LOG_SERIALIZERS.req) }, redact: REDACT_PATHS },
      out,
    );
    // request kiểu Express: url gốc + query đã phân tích
    const raw = {
      method: 'GET',
      url: '/v1/admin/suppliers?q=0901234567',
      originalUrl: '/v1/admin/suppliers?q=0901234567',
      query: { q: '0901234567' },
      headers: { authorization: 'Bearer x' },
      socket: { remoteAddress: '127.0.0.1', remotePort: 1 },
    };
    log.info({ req: raw }, 'request completed');
    const all = lines.join('');
    expect(all).toContain('/v1/admin/suppliers?q=[redacted]');
    expect(all).not.toContain('0901234567');
    expect(all).not.toContain('Bearer x');
  });
});
