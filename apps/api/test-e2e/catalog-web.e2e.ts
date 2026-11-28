import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATALOG_COLUMNS } from '../src/imports/import-columns';
import { ImportProcessor } from '../src/imports/import-processor';
import { type AdminEnv, startAdminEnv } from '../test/helpers/admin-env';

// CP04 lát 7 — màn quản lý danh mục qua BFF (API thật + S3 thật + next start + Chromium). Cổng lát 7:
// tạo SKU ⇒ đổi giá ⇒ thấy lịch sử; nhập file dry-run ⇒ chọn bỏ qua ⇒ nhập thật. Thêm: tải file qua BFF (logo), file mẫu,
// trang tem trong iframe sandbox (CSP riêng, không script), sắp lại quy tắc mã vạch.

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

/** PNG 1×1 hợp lệ */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

describe('trang quản lý — danh mục, nhập Excel, tem (CP04 lát 7)', () => {
  let e: AdminEnv;
  let web: ChildProcess;
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let origin: string;
  const cspViolations: string[] = [];
  const tag = `E${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const catName = `Trái cây ${tag}`;
  let skuId = '';

  beforeAll(async () => {
    e = await startAdminEnv({ s3: true });
    await e.app.listen(0, '127.0.0.1');
    const apiPort = (e.app.getHttpServer().address() as AddressInfo).port;
    const webPort = await freePort();
    origin = `http://localhost:${webPort}`;
    const dir = resolve(process.cwd(), '../admin-web');
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
    ctx = await browser.newContext({ acceptDownloads: true });
    page = await ctx.newPage();
    page.on('console', (m) => {
      if (/Content.Security.Policy/i.test(m.text())) cspViolations.push(m.text());
    });
    page.on('dialog', (d) => void d.accept());

    await page.goto(`${origin}/login`);
    await page.fill('input[name=email]', e.masterLogin.email);
    await page.fill('input[name=password]', e.masterLogin.password);
    await page.click('button[type=submit]');
    await page.waitForURL(`${origin}/login/2fa`);
    await page.fill('input[name=code]', await e.masterTotp());
    await page.click('button[type=submit]');
    await page.waitForURL(`${origin}/`);
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    web?.kill();
    await e?.close();
  });

  /** hộp step-up hiện ⇒ nhập mã đúng */
  async function stepUpIfAsked() {
    const dlg = page.locator('dialog[open]');
    await dlg.waitFor({ timeout: 15_000 });
    await dlg.locator('input[name=code]').fill(await e.masterTotp());
    await dlg.locator('button[type=submit]').click();
    await dlg.waitFor({ state: 'detached' });
  }

  it('tạo danh mục + sản phẩm + SKU ⇒ đổi giá hai lần ⇒ lịch sử đủ cũ → mới, lý do', async () => {
    await page.goto(`${origin}/catalog`);
    await page.fill('input[name=name]', catName);
    await page.click('button:has-text("Thêm danh mục")');
    await page.locator(`.tree button:has-text("${catName}")`).click();
    await page.fill('form:has(button:has-text("Thêm sản phẩm")) input[name=name]', `Cam ${tag}`);
    await page.click('button:has-text("Thêm sản phẩm")');
    await page.locator(`td:has-text("Cam ${tag}")`).waitFor();

    await page.click('button[role=tab]:has-text("SKU")');
    const f = page.locator('form:has(button:has-text("Tạo SKU"))');
    await f.locator('select[name=product_id]').selectOption({ label: `Cam ${tag}` });
    await f.locator('input[name=sku_code]').fill(`${tag}-CAM`);
    await f.locator('input[name=name]').fill(`Cam sành ${tag}`);
    await f.locator('input[name=scale_plu]').fill(String(10000 + Math.floor(Math.random() * 80000)));
    await f.locator('input[name=sold_by_scale]').check();
    await f.locator('button[type=submit]').click();
    await page.locator('.notice:has-text("Đã tạo SKU")').waitFor();
    await page.locator(`a:has-text("${tag}-CAM")`).click();
    await page.waitForURL(/\/catalog\/skus\//);
    skuId = page.url().split('/').pop() ?? '';

    const prices = page.locator('form:has(button:has-text("Lưu giá"))');
    await prices.locator('input[name=global]').fill('52.000');
    await prices.locator('input[name=reason]').fill('Giá mở bán');
    await prices.locator('button[type=submit]').click();
    await page.locator('.notice:has-text("Đã đổi giá")').waitFor();
    await page.locator('td:has-text("52.000đ")').first().waitFor();

    await prices.locator('input[name=global]').fill('55000');
    await prices.locator('input[name=reason]').fill('Tăng giá mùa');
    await prices.locator('button[type=submit]').click();
    await page.locator('td:has-text("52.000đ → 55.000đ")').waitFor();
    await page.locator('td:has-text("Tăng giá mùa")').waitFor();
    const [n] = await e.db.q(`SELECT count(*)::int AS n FROM core.price_change_logs WHERE sku_id = $1`, [skuId]);
    expect(n?.n).toBe(2);
  });

  it('nhập Excel: tải file mẫu; chạy thử báo dòng trùng, không ghi; bỏ qua ⇒ nhập thật 2 dòng, báo 1', async () => {
    await page.goto(`${origin}/imports`);
    const dl = page.waitForEvent('download');
    await page.click('button:has-text("Tải file mẫu: Danh mục")');
    expect((await dl).suggestedFilename()).toBe('mau-nhap-catalog.xlsx');

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Dữ liệu');
    ws.columns = CATALOG_COLUMNS.map((c) => ({ header: `${c.label} (${c.key})`, key: c.key }));
    const row = (code: string, name: string) => ({
      category: catName,
      product: `Táo ${tag}`,
      sku_code: code,
      name,
      sale_unit_type: 'WEIGHT',
      retail_price: 60000,
    });
    ws.addRow(row(`${tag}-T1`, 'Táo 1'));
    ws.addRow(row(`${tag}-CAM`, 'Trùng mã SKU đã tạo'));
    ws.addRow(row(`${tag}-T2`, 'Táo 2'));
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await page.setInputFiles('input[name=file]', {
      name: 'nhap.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: buf,
    });
    await page.click('button:has-text("Tải file lên")');
    await page.locator('.notice:has-text("Đã tải lên")').waitFor();

    /** worker không chạy trong e2e ⇒ test chạy processor cho lượt PENDING (như worker) */
    const runPending = async () => {
      for (let i = 0; i < 60; i++) {
        const rows = await e.db.q(`SELECT id::text FROM core.import_jobs WHERE status = 'PENDING'`);
        if (rows.length) {
          for (const r of rows) await e.app.get(ImportProcessor).run(r['id'] as string);
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('không thấy lượt nhập PENDING');
    };

    await page.click('button:has-text("Chạy thử")');
    await stepUpIfAsked();
    await runPending();
    await page.locator('h2:has-text("Kết quả chạy thử — Xong")').waitFor({ timeout: 30_000 });
    await page.locator('td:has-text("Bỏ qua")').first().waitFor();
    expect(await page.locator(`td:has-text("${tag}-CAM")`).count()).toBeGreaterThan(0);
    const before = await e.db.q(`SELECT count(*)::int AS n FROM core.skus WHERE sku_code LIKE $1`, [`${tag}-T%`]);
    expect(before[0]?.n).toBe(0);

    await page.click('button:has-text("Nhập thật")');
    // step-up còn hạn 5 phút ⇒ có thể không hỏi lại
    await runPending();
    await page.locator('h2:has-text("Kết quả nhập — Xong")').waitFor({ timeout: 30_000 });
    const after = await e.db.q(`SELECT count(*)::int AS n FROM core.skus WHERE sku_code LIKE $1`, [`${tag}-T%`]);
    expect(after[0]?.n).toBe(2);
    await page.locator('p:has-text("Tạo mới 2")').waitFor();
  });

  it('logo tải qua BFF (presign + PUT S3 + complete) ⇒ READY, gắn vào thương hiệu', async () => {
    await page.goto(`${origin}/brand`);
    await page.locator('label:has-text("Logo màu") input[type=file]').setInputFiles({
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await page.locator('.notice:has-text("Đã cập nhật logo")').waitFor();
    const [b] = await e.db.q(
      `SELECT f.status FROM core.brand_settings b JOIN core.files f ON f.id = b.logo_color_file_id LIMIT 1`,
    );
    expect(b?.status).toBe('READY');
    // CSRF: gọi thẳng /bff/upload không có mã ⇒ 403
    const r = await page.evaluate(async () => {
      const x = await fetch('/bff/upload?kind=BRAND_LOGO', {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: new Uint8Array([1]),
      });
      return x.status;
    });
    expect(r).toBe(403);
  });

  it('tem giá kệ: trang HTML trong iframe sandbox (không allow-scripts), CSP riêng, đúng giá', async () => {
    await page.goto(`${origin}/labels`);
    await page.locator('select[name=category_id]').selectOption({ label: catName });
    const resp = page.waitForResponse((r) => r.url().endsWith('/bff/labels'));
    await page.click('button:has-text("Tạo trang tem")');
    const r = await resp;
    expect(r.status()).toBe(200);
    const csp = r.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('sandbox allow-same-origin allow-modals');
    expect(csp).not.toContain('allow-scripts');
    expect(csp).toContain("frame-ancestors 'self'");
    const sandbox = await page.locator('iframe.labels').getAttribute('sandbox');
    expect(sandbox).not.toContain('allow-scripts');
    const frame = page.frameLocator('iframe.labels');
    await frame.locator(`text=Cam sành ${tag}`).waitFor();
    expect(await frame.locator('body').innerText()).toContain('55.000đ');
    expect(await frame.locator('script').count()).toBe(0);
    await page.locator('button:text-is("In"):not([disabled])').waitFor();
    // CSRF sai ⇒ trang lỗi trong khung, không gọi API
    const bad = await page.evaluate(async () => {
      const x = await fetch('/bff/labels', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'csrf=x&payload=%7B%7D',
      });
      return x.status;
    });
    expect(bad).toBe(403);
  });

  it('quy tắc mã vạch: đổi chỗ hai quy tắc trên màn ⇒ lưu thứ tự (giữ tập priority)', async () => {
    const before = await e.db.q(`SELECT code, priority FROM core.barcode_rules ORDER BY priority`);
    await page.goto(`${origin}/labels`);
    await page.click('button[role=tab]:has-text("Quy tắc mã vạch")');
    const first = before[0]?.['code'] as string;
    const second = before[1]?.['code'] as string;
    await page.click(`button[aria-label="Đưa ${first} xuống"]`);
    await page.click('button:has-text("Lưu thứ tự")');
    await page.locator('.notice:has-text("Đã lưu thứ tự")').waitFor();
    const after = await e.db.q(`SELECT code, priority FROM core.barcode_rules ORDER BY priority`);
    expect(after.map((x) => x['code']).slice(0, 2)).toEqual([second, first]);
    expect(after.map((x) => x['priority'])).toEqual(before.map((x) => x['priority']));
  });

  it('cửa hàng: tạo, sửa giờ mở cửa; NCC: tạo, xem số tài khoản cần step-up', async () => {
    await page.goto(`${origin}/org`);
    const sf = page.locator('form:has(button:has-text("Thêm cửa hàng"))');
    await sf.locator('input[name=code]').fill(`S${tag}`);
    await sf.locator('input[name=name]').fill(`CH ${tag}`);
    await sf.locator('button[type=submit]').click();
    await page.locator('.notice:has-text("Đã tạo cửa hàng")').waitFor();
    await page.fill('input[name=h_mon]', '07:00-12:00, 13:00-21:00');
    await page.click('button:has-text("Lưu cửa hàng")');
    await page.locator('.notice:has-text("Đã lưu cửa hàng")').waitFor();
    const [s] = await e.db.q(`SELECT opening_hours FROM core.stores WHERE code = $1`, [`S${tag}`]);
    expect(s?.opening_hours).toEqual({
      mon: [
        ['07:00', '12:00'],
        ['13:00', '21:00'],
      ],
    });

    await page.goto(`${origin}/suppliers`);
    const nf = page.locator('form:has(button:has-text("Thêm")):has(input[name=code])');
    await nf.locator('input[name=code]').fill(`N${tag}`);
    await nf.locator('input[name=name]').fill(`NCC ${tag}`);
    await nf.locator('input[name=account_number]').fill('0123456789');
    await nf.locator('input[name=account_holder]').fill('Nguyen Van A');
    await nf.locator('button[type=submit]').click();
    await page.locator('.notice:has-text("Đã thêm nhà cung cấp")').waitFor();
    expect(await page.locator('body').innerText()).not.toContain('0123456789');
    await page.click('button:has-text("Xem số tài khoản")');
    await stepUpIfAsked().catch(() => undefined); // step-up có thể còn hạn từ bước nhập
    await page.locator('span.mono:has-text("0123456789")').waitFor();
  });

  it('không có vi phạm CSP trên các trang đã đi qua', () => {
    expect(cspViolations).toEqual([]);
  });
});
