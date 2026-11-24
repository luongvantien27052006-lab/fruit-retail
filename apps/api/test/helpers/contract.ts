import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/** Kiểm body response THẬT theo schema trong openapi.yaml (hợp đồng là nguồn duy nhất — ADR-004/007). */
const spec = parse(readFileSync(resolve(process.cwd(), '../../packages/contracts/openapi.yaml'), 'utf8')) as {
  components: { schemas: Record<string, unknown> };
};
const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
ajv.addSchema({ $id: 'oas', components: spec.components });

export function schemaErrors(name: string, body: unknown): string[] {
  const v = ajv.getSchema(`oas#/components/schemas/${name}`);
  if (!v) throw new Error(`không có schema ${name}`);
  return v(body) ? [] : (v.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ''}`);
}

/** Kiểm payload sự kiện outbox theo packages/contracts/events/<event_type>.json (phần `payload`). */
export function eventPayloadErrors(eventType: string, payload: unknown): string[] {
  const file = resolve(process.cwd(), `../../packages/contracts/events/${eventType}.json`);
  const ev = JSON.parse(readFileSync(file, 'utf8')) as { properties: { payload: object } };
  const v = ajv.compile(ev.properties.payload);
  return v(payload) ? [] : (v.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ''}`);
}
