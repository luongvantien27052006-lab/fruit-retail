// Đối chiếu tái hiện được (CP01 cổng): mọi route SPEC §13.2 có trong openapi.yaml (trừ ngoại lệ đã duyệt),
// mọi thao tác có x-permission, và mọi bảng SPEC §12.2/§12.3/§10.5/§21.8 có trong ERD.md.
import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const spec = readFileSync(new URL('docs/specs/DAC_TA_HE_THONG_HOA_QUA_v3.md', root), 'utf8').split('\n');
const oas = readFileSync(new URL('packages/contracts/openapi.yaml', root), 'utf8');
const erd = readFileSync(new URL('docs/engineering/data/ERD.md', root), 'utf8');
let fail = 0;
const err = (m) => {
  console.error('FAIL ' + m);
  fail++;
};
const section = (startRe, endRe) => {
  const s = spec.findIndex((l) => startRe.test(l));
  const e = spec.findIndex((l, i) => i > s && endRe.test(l));
  return spec.slice(s, e);
};

// 1) Route §13.2
const ALLOWED_DIFF = new Map([
  ['/pos/wholesale-orders/{id}/accept', 'NC-16: dùng start-picking'],
  ['/pos/wholesale-orders/{id}/reject', 'NC-16: đơn sỉ không có bước từ chối'],
  ['/pos/wholesale-orders/{id}/report-shortage', 'NC-16: thiếu hàng đơn sỉ xử lý ở Master'],
  ['/pos/markdowns/{id}/approve', 'NC-21: giảm giá cận hạn chỉ Master duyệt — qua /admin/approvals'],
]);
const paths = new Set([...oas.matchAll(/^ {2}(\/[^:\s]+):$/gm)].map((m) => m[1]));
const rows = section(/^### 13\.2\./, /^### 13\.3\./).filter(
  (l) => l.startsWith('| ') && !l.startsWith('| Nhóm') && !l.startsWith('|---'),
);
const want = new Set();
for (const row of rows) {
  // chỉ cắt '|' NGOÀI backtick: `ship|receive`, `pick|deliver`… là các route thay thế trong cùng ô
  // hàng Admin mở đầu "CRUD theo mục §10.1;" — chỉ bỏ cụm đó, vẫn kiểm các route liệt kê sau nó
  const cell = (
    row
      .replace(/`[^`]*`/g, (m) => m.replaceAll('|', '\u0001'))
      .split('|')[2]
      ?.replaceAll('\u0001', '|') ?? ''
  ).replace(/CRUD theo mục[^;]*;/, '');
  let lastBase = '';
  for (const raw of cell.split('·')) {
    const m = raw.match(/(?:(?:GET|POST|PATCH|DELETE|CRUD)\s+)?(`?)(\/[^\s`?]+)/);
    if (!m) continue;
    let p = m[2];
    if (/^\/[a-z-]+$/.test(p) && lastBase && !/^\/(auth|app|pos|admin|viewer|webhooks|shipper)\//.test(p))
      p = lastBase + p;
    const segs = p.split('/');
    if (!/^\/(auth|app|pos|admin|viewer|webhooks|shipper)\//.test(p)) continue;
    lastBase = segs.slice(0, -1).join('/');
    for (const alt of p
      .replace(/:([a-z_]+)/g, '{$1}')
      .split('|')
      .map((x, i, arr) => (i === 0 ? x : x.includes('/') ? x : arr[0].replace(/[^/]+$/, x)))) {
      want.add(alt);
    }
  }
}
// "tương tự cho /pos/wholesale-orders/:id/*" — các hậu tố của đơn app
for (const a of ['accept', 'reject', 'weigh-line', 'report-shortage', 'pack', 'dispatch'])
  want.add(`/pos/wholesale-orders/{id}/${a}`);
let missing = 0;
for (const p of want) {
  // route đã được miễn (bỏ có chủ đích) mà xuất hiện lại trong openapi ⇒ lỗi: quyết định NC bị lặng lẽ đảo ngược
  if (paths.has(p) && ALLOWED_DIFF.has(p)) {
    err(`route ${p} đã bỏ theo ${ALLOWED_DIFF.get(p)} nhưng lại có trong openapi`);
    continue;
  }
  if (paths.has(p)) continue;
  if (p.endsWith('/*') && [...paths].some((x) => x.startsWith(p.slice(0, -1)))) continue;
  if (ALLOWED_DIFF.has(p)) {
    console.log(`ok (ngoại lệ) ${p} — ${ALLOWED_DIFF.get(p)}`);
    continue;
  }
  err(`route §13.2 thiếu trong openapi: ${p}`);
  missing++;
}
console.log(`§13.2 routes checked=${want.size}, missing=${missing}`);

// 2) x-permission mọi thao tác
const ops = (oas.match(/^ {4}(get|post|put|patch|delete):$/gm) || []).length;
const perms = (oas.match(/^ {6}x-permission:/gm) || []).length;
if (ops !== perms) err(`thao tác=${ops} nhưng x-permission=${perms}`);
console.log(`operations=${ops}, x-permission=${perms}`);

// 3) Bảng trong ERD
const tables = new Set();
for (const l of section(/^### 12\.2\./, /^### 12\.3\./))
  for (const m of l.matchAll(/(?:^|·\s+)([a-z_]+)\(/g)) tables.add(m[1]);
for (const l of section(/^### 12\.3\./, /^### 12\.4\./)) {
  const m = l.match(/^(reporting|audit|integration)\.([a-z_]+)/);
  if (m && !m[2].includes('snap'))
    tables.add(m[2] === 'snapshots' ? 'snapshots' : m[1] === 'reporting' ? m[2] : `${m[1]}.${m[2]}`);
}
for (const l of section(/^### 10\.5\./, /^---/)) {
  const m = l.match(/^reporting\.([a-z_]+)\(/);
  if (m) tables.add(m[1]);
}
const t218 = section(/^### 21\.8\./, /^Mã quyền mới/).join(' ');
for (const m of t218.matchAll(/\b([a-z]+(?:_[a-z]+)+|units|returns)\b(?=[(,\s])/g)) {
  const n = m[1];
  if (
    [
      'phone_orders',
      'app_orders',
      'inventory_batches',
      'stock_movements',
      'alert_date',
      'stop_sell_app_date',
      'reversal_of_id',
      'movement_type',
      'mode_on_duplicate',
      'badge_code_hash',
      'issued_at',
      'revoked_at',
      'shift_id',
      'staff_id',
      'account_id',
      'ref_type',
      'ref_id',
      'original_sale_id',
      'fee_amount',
      'doc_type',
      'next_value',
      'file_id',
      'location_id',
      'sku_id',
      'min_g',
      'max_g',
      'min_units',
      'max_units',
      'locked_until',
    ].includes(n)
  )
    continue;
  tables.add(n);
}
let tMiss = 0;
for (const t of tables) {
  const re = new RegExp(`(\\| |, )${t.replace('.', '\\.')}( \\||,)`);
  if (!re.test(erd)) {
    err(`bảng thiếu trong ERD: ${t}`);
    tMiss++;
  }
}
console.log(`tables checked=${tables.size}, missing=${tMiss}`);
process.exit(fail ? 1 : 0);
