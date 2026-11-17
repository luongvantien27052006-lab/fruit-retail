// Kiểm mọi schema sự kiện biên dịch được và một mẫu envelope hợp lệ (ADR-007).
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../events/', import.meta.url);
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
for (const f of files) ajv.addSchema(JSON.parse(readFileSync(new URL(f, dir), 'utf8')), f);
let bad = 0;
for (const f of files.filter((f) => f !== '_envelope.json')) {
  try {
    ajv.getSchema(f);
  } catch (e) {
    console.error(`FAIL ${f}: ${e.message}`);
    bad++;
  }
}
const sample = {
  event_id: '0192f1a2-7c3e-7b1a-9c2d-3e4f5a6b7c8d',
  event_type: 'sale.completed',
  schema_version: 1,
  occurred_at: '2026-11-17T03:00:00Z',
  aggregate_id: '0192f1a2-7c3e-7b1a-9c2d-3e4f5a6b7c8e',
  payload: {
    sale_id: '0192f1a2-7c3e-7b1a-9c2d-3e4f5a6b7c8e',
    store_id: '0192f1a2-7c3e-7b1a-9c2d-3e4f5a6b7c8f',
    shift_id: '0192f1a2-7c3e-7b1a-9c2d-3e4f5a6b7c90',
    business_date: '2026-11-17',
    total_amount: '270400',
    weight_g: 845,
    is_offline: false,
  },
};
const v = ajv.getSchema('sale.completed.json');
if (!v(sample)) {
  console.error('FAIL sample sale.completed', v.errors);
  bad++;
}
const wrong = { ...sample, payload: { ...sample.payload, total_amount: 270400.5 } };
if (v(wrong)) {
  console.error('FAIL: tiền dạng số thực phải bị từ chối');
  bad++;
}
console.log(`${files.length - 1} event schemas, failures=${bad}`);
process.exit(bad ? 1 : 0);
