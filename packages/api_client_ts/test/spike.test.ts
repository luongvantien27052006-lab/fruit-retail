import { describe, expect, expectTypeOf, it } from 'vitest';
import { createApiClient, vnd, type components, type paths, type VndWire } from '../src/index.js';

// Spike sinh client TS (ADR-017): kiểu sinh từ openapi.yaml + chuyển tiền tường minh.
describe('spike openapi-typescript', () => {
  it('VndAmount trên dây là string, không phải number', () => {
    expectTypeOf<VndWire>().toEqualTypeOf<string>();
    expect(vnd.fromWire('114950')).toBe(114950n);
    expect(vnd.toWire(270400n)).toBe('270400');
  });

  it('/health có kiểu HealthStatus chi tiết', () => {
    type Ok = paths['/health']['get']['responses']['200']['content']['application/json'];
    expectTypeOf<Ok>().toEqualTypeOf<components['schemas']['HealthStatus']>();
    expectTypeOf<Ok['checks']['db']>().toEqualTypeOf<'ok' | 'down'>();
  });

  it('ErrorCode sinh đủ enum (gồm DEPENDENCY_UNAVAILABLE)', () => {
    expectTypeOf<'DEPENDENCY_UNAVAILABLE'>().toExtend<components['schemas']['ErrorCode']>();
  });

  it('client gọi được /health qua fetch giả lập (không gọi mạng thật)', async () => {
    const body = { status: 'ok', checks: { db: 'ok', redis: 'ok' } };
    const client = createApiClient({
      baseUrl: 'http://test.invalid/v1',
      fetch: async (req: Request) => {
        expect(new URL(req.url).pathname).toBe('/v1/health');
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const { data, error } = await client.GET('/health');
    expect(error).toBeUndefined();
    expect(data).toEqual(body);
  });
});
