// Chuẩn hóa openapi.yaml cho swagger_parser (spike CP02, ADR-017): công cụ này chưa hỗ trợ `parameters` ở cấp path
// (hợp lệ trong OpenAPI 3.1) → chép xuống từng thao tác. KHÔNG sửa nguồn; ghi ra file tạm cho bước sinh Dart.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, stringify } from 'yaml';

const [src = 'openapi.yaml', out = '../shared_models/.codegen/openapi.dart.yaml'] = process.argv.slice(2);
const doc = parse(readFileSync(src, 'utf8'));
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
let moved = 0;
for (const item of Object.values(doc.paths ?? {})) {
  const shared = item.parameters;
  if (!Array.isArray(shared)) continue;
  for (const m of METHODS) {
    const op = item[m];
    if (!op) continue;
    const own = op.parameters ?? [];
    const key = (p) => (p.$ref ? p.$ref : `${p.in}:${p.name}`);
    const seen = new Set(own.map(key));
    op.parameters = [...shared.filter((p) => !seen.has(key(p))), ...own];
  }
  delete item.parameters;
  moved++;
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, stringify(doc, { lineWidth: 0 }));
console.log(`export-for-dart: chuẩn hóa ${moved} path → ${out}`);
