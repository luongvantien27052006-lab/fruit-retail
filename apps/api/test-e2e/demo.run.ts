import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { it } from 'vitest';
import { createMaster } from '../src/cli/create-master';
import { ImportProcessor } from '../src/imports/import-processor';
import { startAdminEnv } from '../test/helpers/admin-env';

/**
 * MÔI TRƯỜNG DEMO để Tiến tự bấm thử (KHÔNG phải test): PostgreSQL + Redis + SeaweedFS (S3) qua Testcontainers, API thật,
 * web admin bản build production (`next start`), và vòng chạy lượt nhập Excel thay worker. Không đụng stack Docker
 * `fruit-retail`; dừng tiến trình ⇒ Testcontainers tự dọn container. Dữ liệu mất khi dừng.
 *
 * Chạy: `pnpm --filter @fruit/admin-web build` rồi `pnpm --filter @fruit/api run demo` (giữ chạy tới khi Ctrl+C).
 * Mật khẩu tạm của tài khoản Master ghi vào `data-private/demo-login.txt` (gitignore) — đăng nhập lần đầu sẽ bắt đổi mật
 * khẩu và quét QR 2FA bằng ứng dụng Authenticator, giống hệ thống thật.
 */

const WEB_PORT = Number(process.env['DEMO_WEB_PORT'] ?? '3001');
const EMAIL = process.env['DEMO_EMAIL'] ?? 'tien-demo@fruit.test';

async function portFree(p: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = createServer();
    s.once('error', () => ok(false));
    s.listen(p, '127.0.0.1', () => s.close(() => ok(true)));
  });
}

async function waitHttp(url: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.status > 0) return;
    } catch {
      /* chưa lên */
    }
    if (Date.now() > end) throw new Error(`không lên: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

it(
  'demo',
  async () => {
    if (!(await portFree(WEB_PORT))) throw new Error(`Cổng ${WEB_PORT} đang bận — đặt DEMO_WEB_PORT khác`);
    const dir = resolve(process.cwd(), '../admin-web');
    const built = statSync(resolve(dir, '.next/BUILD_ID')).mtimeMs;
    const newest = (p: string): number => {
      const st = statSync(p);
      if (!st.isDirectory()) return st.mtimeMs;
      return Math.max(0, ...readdirSync(p).map((n) => newest(resolve(p, n))));
    };
    if (Math.max(...['app', 'lib', 'components', 'proxy.ts'].map((n) => newest(resolve(dir, n)))) > built)
      throw new Error('admin-web chưa build lại — chạy pnpm --filter @fruit/admin-web build');

    const e = await startAdminEnv({ s3: true });
    await e.app.listen(0, '127.0.0.1');
    const apiPort = (e.app.getHttpServer().address() as AddressInfo).port;
    const m = await createMaster(e.db.roleUrl('app_rw'), EMAIL); // mật khẩu tạm, bắt đổi + 2FA (như CLI thật)

    const origin = `http://localhost:${WEB_PORT}`;
    const web: ChildProcess = spawn(
      process.execPath,
      [resolve(dir, 'node_modules/next/dist/bin/next'), 'start', '-p', String(WEB_PORT)],
      {
        cwd: dir,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
          ADMIN_ORIGIN: origin,
          NEXT_TELEMETRY_DISABLED: '1',
        },
        stdio: 'ignore',
      },
    );
    process.on('exit', () => web.kill());
    await waitHttp(`${origin}/login`, 60_000);

    const out = resolve(process.cwd(), '../../data-private');
    mkdirSync(out, { recursive: true });
    writeFileSync(
      resolve(out, 'demo-login.txt'),
      [
        'MÔI TRƯỜNG DEMO (dữ liệu mất khi dừng) — KHÔNG phải hệ thống thật',
        `Trang quản lý: ${origin}`,
        `Email: ${m.email}`,
        `Mật khẩu tạm (đăng nhập lần đầu sẽ bắt đổi): ${m.password}`,
        `File danh mục mẫu để thử nhập: data-private/danh-muc-mau-DEV.xlsx`,
        '',
      ].join('\n'),
    );
    console.log(`DEMO_READY ${origin} (thông tin đăng nhập: data-private/demo-login.txt)`);

    // thay worker: chạy các lượt nhập Excel đang chờ (worker thật là tiến trình riêng — ADR-016)
    const proc = e.app.get(ImportProcessor);
    for (;;) {
      try {
        const rows = await e.db.q(`SELECT id::text FROM core.import_jobs WHERE status = 'PENDING' ORDER BY created_at`);
        for (const r of rows) await proc.run(r['id'] as string);
      } catch (x) {
        console.error('demo: lỗi chạy lượt nhập', x);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  },
  24 * 3600_000,
);
