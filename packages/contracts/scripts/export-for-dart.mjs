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
// swagger_parser sinh lớp sealed `<Tên>Sealed` cho `oneOf` nhưng client vẫn import `<tên>.dart` (không tồn tại) ⇒ build
// hỏng trên máy sạch (CI develop sau CP03). Gộp các nhánh object thành MỘT object: thuộc tính = hợp, bắt buộc = giao,
// enum cùng tên = hợp. Phía Dart tự phân nhánh theo trường phân biệt (vd. `status`); nguồn hợp đồng giữ nguyên oneOf.
let flattened = 0;
for (const [name, sc] of Object.entries(doc.components?.schemas ?? {})) {
  if (!Array.isArray(sc.oneOf)) continue;
  if (!sc.oneOf.every((v) => v.type === 'object' && !v.$ref)) throw new Error(`oneOf chưa hỗ trợ: ${name}`);
  const props = {};
  for (const v of sc.oneOf)
    for (const [k, p0] of Object.entries(v.properties ?? {})) {
      // `const` (3.1) ⇒ enum một giá trị để gộp được
      const { const: c, ...p1 } = p0;
      const p = c === undefined ? p0 : { ...p1, enum: [c] };
      const prev = props[k];
      if (!prev) {
        props[k] = p;
        continue;
      }
      // so sánh không phụ thuộc thứ tự khóa; phần ngoài `enum` (type, format…) phải giống hệt
      const canon = (o) =>
        JSON.stringify(
          Object.keys(o)
            .sort()
            .map((x) => [x, o[x]]),
        );
      const { enum: e1, ...r1 } = prev;
      const { enum: e2, ...r2 } = p;
      if (canon(r1) !== canon(r2) || Array.isArray(e1) !== Array.isArray(e2))
        throw new Error(`oneOf ${name}: thuộc tính ${k} khác nhau giữa các nhánh — chưa hỗ trợ gộp`);
      if (Array.isArray(e1)) props[k] = { ...prev, enum: [...new Set([...e1, ...e2])] };
    }
  const required = sc.oneOf.map((v) => v.required ?? []).reduce((acc, r) => acc.filter((k) => r.includes(k)));
  const rest = { ...sc };
  delete rest.oneOf;
  delete rest.discriminator;
  doc.components.schemas[name] = { ...rest, type: 'object', required, properties: props };
  flattened++;
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, stringify(doc, { lineWidth: 0 }));
console.log(`export-for-dart: chuẩn hóa ${moved} path, gộp ${flattened} oneOf → ${out}`);
