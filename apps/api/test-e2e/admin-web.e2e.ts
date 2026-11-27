import type { INestApplication } from '@nestjs/common';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { generateSync } from 'otplib';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/bootstrap';
import { createMaster } from '../src/cli/create-master';
import { loadEnv } from '../src/config/env';
import { testAuthEnv } from '../test/helpers/auth-env';
import { type MigratedDb, startMigratedDb } from '../test/helpers/db';
import { relaxedRatePolicies } from '../test/helpers/rate-limit';

// CP03 lát 8b — trang quản lý qua BFF: đăng nhập lần đầu (đổi mật khẩu tạm → 2FA → mã khôi phục), đăng nhập 2FA,
// step-up, token không đọc được từ JS, CSRF, CSP nonce, làm mới token, đăng xuất (ADR-027).

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => ok(p));
    });
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

describe('trang quản lý qua BFF (CP03 lát 8b)', () => {
  let db: MigratedDb;
  let redis: StartedRedisContainer;
  let app: INestApplication;
  let web: ChildProcess;
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let origin: string;
  let secret = '';
  const cspViolations: string[] = [];
  const email = `e2e-${randomBytes(3).toString('hex')}@fruit.test`;
  let userId = '';
  let tempPassword = '';
  const newPassword = `E2e-${randomBytes(9).toString('base64url')}`;

  /** mã TOTP mới; xóa mốc bước đã dùng (cùng bước 30 s bị chặn dùng lại — ADR-021) */
  async function totp(): Promise<string> {
    await db.q(`UPDATE core.users SET totp_last_step = NULL WHERE id = $1`, [userId]);
    return generateSync({ secret });
  }

  beforeAll(async () => {
    [db, redis] = await Promise.all([startMigratedDb(), new RedisContainer('redis:7.4-alpine').start()]);
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL_APP: db.roleUrl('app_rw'),
      DATABASE_URL_VIEWER: db.roleUrl('viewer_ro'),
      REDIS_URL: redis.getConnectionUrl(),
      PORT: '0',
      LOG_LEVEL: 'silent',
      ...testAuthEnv(db.roleUrl('audit_writer')),
    });
    app = await createApp(env, { logger: false }, { providers: [relaxedRatePolicies] });
    await app.listen(0, '127.0.0.1');
    const apiPort = (app.getHttpServer().address() as AddressInfo).port;

    const m = await createMaster(db.roleUrl('app_rw'), email); // CLI thật: mật khẩu tạm, bắt đổi
    userId = m.userId;
    tempPassword = m.password;

    const webPort = await freePort();
    origin = `http://localhost:${webPort}`;
    const dir = resolve(process.cwd(), '../admin-web');
    // chống "xanh giả" trên bản build cũ: BUILD_ID phải mới hơn mọi file nguồn
    const built = statSync(resolve(dir, '.next/BUILD_ID')).mtimeMs;
    const newest = (p: string): number => {
      const st = statSync(p);
      if (!st.isDirectory()) return st.mtimeMs;
      return Math.max(0, ...readdirSync(p).map((n) => newest(resolve(p, n))));
    };
    const src = Math.max(...['app', 'lib', 'components', 'proxy.ts'].map((n) => newest(resolve(dir, n))));
    if (src > built)
      throw new Error('admin-web chưa build lại sau khi sửa — chạy pnpm --filter @fruit/admin-web build');
    web = spawn(process.execPath, [resolve(dir, 'node_modules/next/dist/bin/next'), 'start', '-p', String(webPort)], {
      cwd: dir,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
        ADMIN_ORIGIN: origin,
        NEXT_TELEMETRY_DISABLED: '1',
      },
      stdio: 'ignore',
    });
    await waitHttp(`${origin}/login`, 60_000);

    browser = await chromium.launch();
    ctx = await browser.newContext();
    page = await ctx.newPage();
    page.on('console', (msg) => {
      if (/Content.Security.Policy/i.test(msg.text())) cspViolations.push(msg.text());
    });
  });

  afterAll(async () => {
    await browser?.close();
    web?.kill();
    await app?.close();
    await Promise.allSettled([db?.pg.stop(), redis?.stop()]);
  });

  async function cookieMap() {
    return new Map((await ctx.cookies(origin)).map((c) => [c.name, c]));
  }

  it('chưa đăng nhập ⇒ /login; CSP có nonce, không unsafe-inline', async () => {
    const r = await page.goto(`${origin}/staff`);
    expect(new URL(page.url()).pathname).toBe('/login');
    const csp = r?.headers()['content-security-policy'] ?? '';
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('lần đầu: mật khẩu tạm → đổi mật khẩu → quét 2FA → mã khôi phục → vào trang', async () => {
    await page.fill('input[name=email]', email);
    await page.fill('input[name=password]', tempPassword);
    await page.click('button[type=submit]');
    await page.waitForURL(`${origin}/enroll`);
    // review cổng CP03: sai mật khẩu tạm ⇒ 422 CURRENT_PASSWORD_INVALID hiện tại chỗ (không đá ra /login)
    await page.fill('input[name=current]', 'sai-mat-khau-tam');
    await page.fill('input[name=new_password]', newPassword);
    await page.fill('input[name=confirm]', newPassword);
    await page.click('button[type=submit]');
    await page.locator('p.error').waitFor();
    expect(await page.locator('p.error').textContent()).toContain('Mật khẩu hiện tại không đúng');
    expect(new URL(page.url()).pathname).toBe('/enroll');
    await page.fill('input[name=current]', tempPassword);
    await page.fill('input[name=new_password]', newPassword);
    await page.fill('input[name=confirm]', newPassword);
    await page.click('button[type=submit]');
    const secretEl = page.locator('span.mono').first();
    await secretEl.waitFor();
    secret = (await secretEl.textContent())?.trim() ?? '';
    expect(secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(await page.locator('img.qr').getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    // review react 8b: sai mã ở bước đăng ký ⇒ báo lỗi tại chỗ, KHÔNG bị đá về /login, secret giữ nguyên
    await page.fill('input[name=code]', '000000');
    await page.click('button[type=submit]');
    await page.locator('p.error').waitFor();
    expect(new URL(page.url()).pathname).toBe('/enroll');
    expect((await secretEl.textContent())?.trim()).toBe(secret);
    await page.fill('input[name=code]', await totp());
    await page.click('button[type=submit]');
    await page.locator('.codes span').first().waitFor();
    expect(await page.locator('.codes span').count()).toBe(10);
    await page.click('text=Tôi đã cất mã');
    await page.waitForURL(`${origin}/`);
    await expect(page.locator('h1').textContent()).resolves.toBe('Tổng quan');
  });

  it('token nằm trong cookie __Host- HttpOnly/Secure/SameSite=Strict — JS không đọc được', async () => {
    const c = await cookieMap();
    for (const n of ['__Host-fa_at', '__Host-fa_rt']) {
      const k = c.get(n);
      expect(k, n).toBeTruthy();
      expect(k?.httpOnly).toBe(true);
      expect(k?.secure).toBe(true);
      expect(k?.sameSite).toBe('Strict');
      expect(k?.path).toBe('/');
    }
    expect(c.get('__Host-fa_csrf')?.httpOnly).toBe(false);
    const js = await page.evaluate(() => (globalThis as unknown as { document: { cookie: string } }).document.cookie);
    expect(js).not.toContain('fa_at');
    expect(js).not.toContain('fa_rt');
    // phản hồi BFF không mang token
    const body = await page.evaluate(async () => (await fetch('/bff/api/auth/sessions')).text());
    expect(body).not.toMatch(/access_token|refresh_token/);
    expect(body).toContain('"current":true');
  });

  it('CSRF: thiếu X-CSRF-Token hoặc Origin lạ ⇒ 403; đường ngoài danh sách trắng ⇒ 404', async () => {
    const noToken = await page.evaluate(async () => {
      const r = await fetch('/bff/api/admin/staff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return r.status;
    });
    expect(noToken).toBe(403);
    const c = await cookieMap();
    const cookie = [...c.values()].map((k) => `${k.name}=${k.value}`).join('; ');
    const evil = await fetch(`${origin}/bff/api/admin/staff`, {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://evil.example',
        'content-type': 'application/json',
        'x-csrf-token': c.get('__Host-fa_csrf')?.value ?? '',
      },
      body: '{}',
    });
    expect(evil.status).toBe(403);
    const notListed = await page.evaluate(async () => (await fetch('/bff/api/pos/sales')).status);
    expect(notListed).toBe(404);
    const traversal = await page.evaluate(async () => (await fetch('/bff/api/admin/..%2Fauth%2Flogout')).status);
    expect(traversal).toBe(404);
  });

  it('thao tác step-up: hộp mã 2FA hiện ra, nhập đúng ⇒ thao tác chạy tiếp', async () => {
    await page.goto(`${origin}/accounts`);
    await page.fill('form.card input[name=email]', `v-${randomBytes(3).toString('hex')}@fruit.test`);
    await page.selectOption('form.card select[name=role]', 'MASTER_ADMIN');
    await page.click('form.card button[type=submit]');
    const dlg = page.locator('dialog[open]');
    await dlg.waitFor();
    // sai mã ⇒ lỗi trong hộp, vẫn ở /accounts, form còn nguyên
    await dlg.locator('input[name=code]').fill('000000');
    await dlg.locator('button[type=submit]').click();
    await dlg.locator('p.error').waitFor();
    expect(new URL(page.url()).pathname).toBe('/accounts');
    // Esc ⇒ hủy: thao tác báo lỗi, hộp đóng, không treo (nút gửi bật lại)
    await page.keyboard.press('Escape');
    await page.locator('dialog[open]').waitFor({ state: 'detached' });
    await page.locator('form.card button[type=submit]:not([disabled])').waitFor();
    expect(await page.inputValue('form.card input[name=email]')).toContain('@fruit.test');
    // bấm đúp ⇒ chỉ MỘT thao tác chạy
    await page.dblclick('form.card button[type=submit]');
    await dlg.waitFor();
    await dlg.locator('input[name=code]').fill(await totp());
    await dlg.locator('button[type=submit]').click();
    await page.locator('.notice .mono').waitFor();
    expect((await page.locator('.notice .mono').textContent())?.length ?? 0).toBeGreaterThanOrEqual(16);
    const [a] = await db.q(
      `SELECT count(*)::int AS n FROM audit.logs WHERE action = 'admin_account.create' AND actor_id = $1`,
      [userId],
    );
    expect(a?.n).toBe(1);
    expect(await page.locator('.card p.error').count()).toBe(0); // không có lỗi "email đã dùng" từ lần bấm thứ hai
  });

  it('review react 8b: trang 404 không vi phạm CSP; bề rộng 375 px không tràn ngang', async () => {
    await page.goto(`${origin}/khong-co-trang-nay`);
    await expect(page.locator('h1').textContent()).resolves.toBe('Không tìm thấy trang');
    await page.setViewportSize({ width: 375, height: 812 });
    for (const p of ['/sessions', '/accounts', '/staff', '/devices', '/audit']) {
      await page.goto(`${origin}${p}`);
      await page.locator('h1').waitFor();
      const [sw, cw] = await page.evaluate(() => {
        const d = (
          globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }
        ).document.documentElement;
        return [d.scrollWidth, d.clientWidth];
      });
      expect(sw, p).toBeLessThanOrEqual(cw);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  it('access hết hạn (mất cookie) ⇒ proxy tự làm mới bằng refresh; request song song không làm chết phiên', async () => {
    const before = (await cookieMap()).get('__Host-fa_rt')?.value;
    await ctx.clearCookies({ name: '__Host-fa_at' });
    const statuses = await page.evaluate(async () =>
      Promise.all([1, 2, 3, 4].map(async () => (await fetch('/bff/api/auth/sessions')).status)),
    );
    expect(statuses).toEqual([200, 200, 200, 200]);
    const after = await cookieMap();
    expect(after.get('__Host-fa_at')).toBeTruthy();
    expect(after.get('__Host-fa_rt')?.value).not.toBe(before);
    await page.goto(`${origin}/sessions`);
    expect(new URL(page.url()).pathname).toBe('/sessions');
    const [s] = await db.q(
      `SELECT count(*)::int AS n FROM core.sessions WHERE user_id = $1 AND revoke_reason = 'REFRESH_REUSE'`,
      [userId],
    );
    expect(s?.n).toBe(0);
  });

  it('review 8b: header CSRF nhiều byte ⇒ 403 (không 500); refresh qua điều hướng vẫn ghi cookie; mất cookie CSRF ⇒ cấp lại', async () => {
    const multi = await page.evaluate(async () => {
      const r = await fetch('/bff/api/admin/staff', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'é'.repeat(43) },
        body: '{}',
      });
      return r.status;
    });
    expect(multi).toBe(403);
    // /login khi phiên đủ ⇒ 303 về '/', proxy đã làm mới (mất access) ⇒ Set-Cookie phải có trên chính phản hồi điều hướng
    const before = (await cookieMap()).get('__Host-fa_rt')?.value;
    await ctx.clearCookies({ name: '__Host-fa_at' });
    await ctx.clearCookies({ name: '__Host-fa_csrf' });
    const c0 = await cookieMap();
    const cookie = [...c0.values()].map((k) => `${k.name}=${k.value}`).join('; ');
    const r = await fetch(`${origin}/login`, { headers: { cookie }, redirect: 'manual' });
    expect(r.status).toBe(303);
    const set = r.headers.getSetCookie().join(' | ');
    expect(set).toContain('__Host-fa_at=');
    expect(set).toMatch(/__Host-fa_rt=[^;]+/);
    expect(set).toContain('__Host-fa_csrf=');
    const rt = /__Host-fa_rt=([^;]+)/.exec(set)?.[1];
    expect(rt).not.toBe(before);
    // trình duyệt đi cùng đường (trong 15 s bộ gộp trả CÙNG cặp token, refresh cũ không bị dùng lại ở API)
    await page.goto(`${origin}/login`);
    expect(new URL(page.url()).pathname).toBe('/');
    const c1 = await cookieMap();
    expect(c1.get('__Host-fa_rt')?.value).toBe(rt);
    expect(c1.get('__Host-fa_csrf')).toBeTruthy();
    // trang vẫn dùng được với token mới, thao tác ghi qua CSRF mới
    await page.goto(`${origin}/sessions`);
    expect(new URL(page.url()).pathname).toBe('/sessions');
    const write = await page.evaluate(async () => {
      const m = (globalThis as unknown as { document: { cookie: string } }).document.cookie
        .split('; ')
        .find((c: string) => c.startsWith('__Host-fa_csrf='));
      const r2 = await fetch('/bff/api/admin/pos-devices/enrollment-codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': m?.slice('__Host-fa_csrf='.length) ?? '' },
        body: JSON.stringify({ store_id: '00000000-0000-4000-8000-000000000000' }),
      });
      return r2.status;
    });
    expect(write).not.toBe(403); // qua CSRF (API trả 404/422 vì cửa hàng không có)
  });

  it('review 8b: mất cookie CSRF vẫn đăng xuất được (phiên ở API bị thu hồi)', async () => {
    await ctx.clearCookies({ name: '__Host-fa_csrf' });
    await page.goto(`${origin}/`);
    // proxy không làm mới (access còn) ⇒ CSRF vẫn thiếu; nút đăng xuất phải chạy
    await ctx.clearCookies({ name: '__Host-fa_csrf' });
    await page.click('text=Đăng xuất');
    await page.waitForURL(`${origin}/login`);
    const [s] = await db.q(
      `SELECT count(*)::int AS n FROM core.sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [userId],
    );
    expect(s?.n).toBe(0);
    // đăng nhập lại cho các bước sau
    await page.fill('input[name=email]', email);
    await page.fill('input[name=password]', newPassword);
    await page.click('button[type=submit]');
    await page.waitForURL(`${origin}/login/2fa`);
    await page.fill('input[name=code]', await totp());
    await page.click('button[type=submit]');
    await page.waitForURL(`${origin}/`);
  });

  it('đăng xuất ⇒ xóa cookie, phiên ở API bị thu hồi; đăng nhập lại qua 2FA', async () => {
    await page.click('text=Đăng xuất');
    await page.waitForURL(`${origin}/login`);
    const c = await cookieMap();
    expect(c.has('__Host-fa_at') || c.has('__Host-fa_rt')).toBe(false);
    const [s] = await db.q(
      `SELECT count(*)::int AS n FROM core.sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [userId],
    );
    expect(s?.n).toBe(0);

    await page.fill('input[name=email]', email);
    await page.fill('input[name=password]', newPassword);
    await page.click('button[type=submit]');
    await page.waitForURL(`${origin}/login/2fa`);
    expect((await cookieMap()).get('__Host-fa_mfa')?.httpOnly).toBe(true);
    await page.fill('input[name=code]', await totp());
    await page.click('button[type=submit]');
    await page.waitForURL(`${origin}/`);
    expect((await cookieMap()).has('__Host-fa_mfa')).toBe(false);
  });

  it('review cổng CP03: cùng trình duyệt đăng nhập lại ⇒ KHÔNG phát thêm sự kiện thiết bị mới; phiên bị thu hồi ⇒ về /login', async () => {
    const ev = async () =>
      Number(
        (
          await db.q(
            `SELECT count(*)::int AS n FROM integration.outbox WHERE event_type = 'auth.new_device_login' AND aggregate_id = $1`,
            [userId],
          )
        )[0]?.n,
      );
    // đã có ≥ 2 lần đăng nhập trọn vẹn trên trình duyệt này (kích hoạt + đăng nhập lại 2FA) ⇒ chỉ lần đầu là "mới"
    expect(await ev()).toBe(1);
    const dev = (await cookieMap()).get('__Host-fa_dev');
    expect(dev?.httpOnly).toBe(true);
    const [s] = await db.q(`SELECT client_device FROM core.sessions WHERE user_id = $1 AND revoked_at IS NULL`, [
      userId,
    ]);
    expect(s?.client_device).toBe(dev?.value);
    // Master khác thu hồi phiên (giả lập ở DB) ⇒ thao tác tiếp theo đưa về /login, cookie bị xóa
    await db.q(
      `UPDATE core.sessions SET revoked_at = now(), revoke_reason = 'TEST' WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    await page.goto(`${origin}/staff`);
    await page.waitForURL(`${origin}/login`);
    expect((await cookieMap()).has('__Host-fa_rt')).toBe(false);
  });

  it('không có vi phạm CSP trên các trang đã đi qua', () => {
    expect(cspViolations).toEqual([]);
  });
});
