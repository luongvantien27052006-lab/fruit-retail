import createClient, { type ClientOptions } from 'openapi-fetch';
import { fromWire, toWire } from '@fruit/money_weight';
import type { components, paths } from './generated/schema.js';

export type { components, paths };

/** Tiền trên dây là chuỗi (ADR-017). Client chuyển tường minh sang bigint bằng money_weight. */
export type VndWire = components['schemas']['VndAmount'];
export const vnd = { fromWire: (w: VndWire): bigint => fromWire(w), toWire: (v: bigint): VndWire => toWire(v) };

export function createApiClient(opts: ClientOptions) {
  return createClient<paths>(opts);
}
