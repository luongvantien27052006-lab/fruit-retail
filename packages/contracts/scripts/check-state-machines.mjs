// Kiểm bảng chuyển trạng thái + chạy test vector (CP01: "máy trạng thái có bảng chuyển + test vector").
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../state-machines/', import.meta.url);
let fail = 0;
let checked = 0;
const err = (m) => {
  console.error('FAIL ' + m);
  fail++;
};
const EFFECTS = new Set(Object.keys(JSON.parse(readFileSync(new URL('_effects.json', dir), 'utf8')).effects));
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
  const m = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
  for (const t of m.transitions) {
    if (!Array.isArray(t.effects)) err(`${f}: ${t.from}→${t.to} thiếu mảng effects`);
    else for (const e of t.effects) if (!EFFECTS.has(e)) err(`${f}: ${t.from}→${t.to} effect lạ ${e}`);
  }
  const cancels = m.transitions.filter((t) => t.to === 'CANCELLED' || t.to === 'REJECTED');
  if (m.machine === 'app_order') for (const t of cancels) {
    if (!t.effects.includes('REQUIRE_REASON')) err(`${f}: ${t.from}→${t.to} hủy phải có REQUIRE_REASON`);
    if (!t.effects.includes('RETURN_QUOTA') && t.from !== 'DELIVERY_FAILED') err(`${f}: ${t.from}→${t.to} hủy phải hoàn hạn mức`);
  }
  const S = new Set(m.states);
  const key = (a, b) => `${a}>${b}`;
  const T = new Map(m.transitions.map((t) => [key(t.from, t.to), t]));
  if (!S.has(m.initial)) err(`${f}: initial ${m.initial} không có trong states`);
  for (const t of m.terminal) {
    if (!S.has(t)) err(`${f}: terminal ${t} không có trong states`);
    if (m.transitions.some((x) => x.from === t)) err(`${f}: terminal ${t} có chuyển đi`);
  }
  if (T.size !== m.transitions.length) err(`${f}: chuyển trùng`);
  const seen = new Set([m.initial]);
  let grow = true;
  while (grow) {
    grow = false;
    for (const t of m.transitions) if (seen.has(t.from) && !seen.has(t.to)) { seen.add(t.to); grow = true; }
  }
  for (const s of S) if (!seen.has(s)) err(`${f}: ${s} không đến được từ ${m.initial}`);
  const pathOk = (p) => p.every((s, i) => i === 0 || T.has(key(p[i - 1], s)));
  for (const p of m.test_vectors.valid) {
    checked++;
    if (!pathOk(p)) err(`${f}: vector hợp lệ bị từ chối ${p.join('→')}`);
  }
  for (const p of m.test_vectors.invalid) {
    checked++;
    if (pathOk(p)) err(`${f}: vector sai lại được chấp nhận ${p.join('→')}`);
  }
  for (const [a, b, actor] of m.test_vectors.actor_invalid) {
    checked++;
    const t = T.get(key(a, b));
    if (!t) err(`${f}: actor_invalid trỏ chuyển không tồn tại ${a}→${b}`);
    else if (t.actors.includes(actor)) err(`${f}: ${actor} không được phép ${a}→${b}`);
  }
}
console.log(`state machines checked, vectors=${checked}, failures=${fail}`);
process.exit(fail ? 1 : 0);
