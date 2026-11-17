// CI: phiên bản công cụ thực tế phải khớp docs/engineering/architecture/versions.json (ADR-010, ADR-018).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const v = JSON.parse(readFileSync(new URL('../docs/engineering/architecture/versions.json', import.meta.url), 'utf8'));
const only = process.argv.slice(2); // ví dụ: node tools/check-versions.mjs node pnpm
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
const checks = {
  node: () => [process.versions.node, v.runtime.node.exact],
  pnpm: () => [run('pnpm', ['--version']), v.runtime.pnpm.exact],
  flutter: () => [/Flutter (\S+)/.exec(run('flutter', ['--version']))?.[1], v.runtime.flutter.exact],
  dart: () => [/Dart SDK version: (\S+)/.exec(run('dart', ['--version']))?.[1], v.runtime.dart.exact],
};
let fail = 0;
for (const [name, fn] of Object.entries(checks)) {
  if (only.length && !only.includes(name)) continue;
  const [actual, expected] = fn();
  const ok = actual === expected;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: thực tế ${actual}, versions.json ${expected}`);
  if (!ok) fail++;
}
process.exit(fail ? 1 : 0);
