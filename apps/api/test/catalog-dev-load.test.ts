import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATALOG_COLUMNS } from '../src/imports/import-columns';
import { ImportProcessor } from '../src/imports/import-processor';
import { type AdminEnv, type Client, startAdminEnv } from './helpers/admin-env';
import { DEV_CATALOG } from './fixtures/catalog-dev';

// CP04 lát 8 (cổng, NC-28) — DIỄN TẬP nạp danh mục ≥ 20 SKU qua CHÍNH luồng nhập (file lên S3 → chạy thử → chạy thật)
// bằng danh mục MẪU nhãn DEV. Mục cổng "danh mục THẬT của Tiến" vẫn chờ file thật (runbook-nap-danh-muc.md).

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('nạp danh mục mẫu DEV qua luồng nhập (CP04 lát 8)', () => {
  let e: AdminEnv;
  let su: Client;
  let fileId = '';

  beforeAll(async () => {
    e = await startAdminEnv({ s3: true });
    su = await e.masterStepUp();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Dữ liệu');
    ws.columns = CATALOG_COLUMNS.map((c) => ({ header: `${c.label} (${c.key})`, key: c.key }));
    for (const r of DEV_CATALOG) ws.addRow(r);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const p = await e.master.post('/files/presign', {
      kind: 'IMPORT_XLSX',
      mime: XLSX,
      bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
      capture_source: 'GALLERY',
    });
    expect(p.status).toBe(200);
    const put = await fetch(p.body.upload_url as string, {
      method: 'PUT',
      headers: { 'Content-Type': XLSX },
      body: new Uint8Array(buf),
    });
    expect(put.ok).toBe(true);
    expect((await e.master.post(`/files/${p.body.id as string}/complete`, {})).body.status).toBe('READY');
    fileId = p.body.id as string;
  }, 240_000);
  afterAll(async () => {
    await e?.close();
  });

  async function run(dry: boolean, mode = 'SKIP') {
    const c = await su.post('/admin/imports', {
      type: 'CATALOG',
      file_id: fileId,
      mode_on_duplicate: mode,
      dry_run: dry,
    });
    expect(c.status).toBe(201);
    await e.app.get(ImportProcessor).run(c.body.id as string);
    const g = await e.master.get(`/admin/imports/${c.body.id as string}`);
    return g.body as {
      status: string;
      error: string | null;
      report: {
        created: number;
        skipped: number;
        updated: number;
        errors: number;
        rows: { status: string; message?: string }[];
      };
    };
  }
  const devSkus = async () =>
    (await e.db.q(`SELECT count(*)::int AS n FROM core.skus WHERE sku_code LIKE 'DEV-%'`))[0]?.n as number;

  it('≥ 20 SKU: chạy thử không ghi, chạy thật tạo đủ; nhập lại (bỏ qua) không tạo trùng', async () => {
    expect(DEV_CATALOG.length).toBeGreaterThanOrEqual(20);
    const dry = await run(true);
    expect(dry.status).toBe('COMPLETED');
    expect(dry.report.rows.filter((r) => r.status === 'ERROR')).toEqual([]);
    expect(dry.report.created).toBe(DEV_CATALOG.length);
    expect(await devSkus()).toBe(0);

    const real = await run(false);
    expect(real.status).toBe('COMPLETED');
    expect(real.report).toMatchObject({ created: DEV_CATALOG.length, errors: 0 });
    expect(await devSkus()).toBe(DEV_CATALOG.length);

    const again = await run(false);
    expect(again.report).toMatchObject({ created: 0, skipped: DEV_CATALOG.length, errors: 0 });
    expect(await devSkus()).toBe(DEV_CATALOG.length);
  }, 180_000);

  it('dữ liệu đúng sau khi nạp: giá lẻ + lịch sử, PLU, mã vạch, quy đổi hộp, cây danh mục', async () => {
    const rows = await e.db.q(
      `SELECT s.sku_code, s.sale_unit_type::text AS t, s.scale_plu, s.std_weight_g,
              s.retail_price_per_kg::text AS kg, s.retail_price_per_unit::text AS unit,
              (SELECT count(*)::int FROM core.price_change_logs l WHERE l.sku_id = s.id) AS logs
       FROM core.skus s WHERE s.sku_code LIKE 'DEV-%'`,
    );
    const by = new Map(rows.map((r) => [r['sku_code'] as string, r]));
    for (const d of DEV_CATALOG) {
      const r = by.get(d.sku_code);
      expect(r, d.sku_code).toBeDefined();
      const weighted = ['WEIGHT', 'PIECE_BY_WEIGHT', 'PACK_VARIABLE'].includes(d.sale_unit_type);
      expect(r?.[weighted ? 'kg' : 'unit'], d.sku_code).toBe(String(d.retail_price));
      expect(r?.['scale_plu'] ?? undefined, d.sku_code).toBe(d.scale_plu);
      expect(r?.['logs'], d.sku_code).toBe(1); // giá đặt qua nhập file có lịch sử (ai / khi nào / lý do)
    }
    expect(by.get('DEV-DAU-250')?.['std_weight_g']).toBe(250);
    // mã vạch đơn vị gốc
    const [bc] = await e.db.q(
      `SELECT u.barcode FROM core.sku_units u JOIN core.skus s ON s.id = u.sku_id WHERE s.sku_code = 'DEV-DAU-250'`,
    );
    expect(bc?.['barcode']).toBe(DEV_CATALOG.find((d) => d.sku_code === 'DEV-DAU-250')?.barcode);
    // cây: DEV > Trái cây > <nhóm>
    const cats = await e.db.q(`SELECT name FROM core.categories WHERE name IN ('DEV', 'Trái cây', 'Cam', 'Dâu')`);
    expect(cats.map((c) => c['name']).sort()).toEqual(['Cam', 'DEV', 'Dâu', 'Trái cây']);
  });

  it('dùng được ngay: file PLU cho cân có đủ 17 SKU bán qua cân; tem giá kệ in được cả danh mục', async () => {
    const plu = await e.master.post('/admin/plu-export', { format: 'CSV' });
    expect(plu.status).toBe(201);
    expect(plu.body.rows).toBeGreaterThanOrEqual(DEV_CATALOG.filter((d) => d.sold_by_scale === 'có').length);
    const csv = await (await fetch(plu.body.url as string)).text();
    for (const d of DEV_CATALOG.filter((x) => x.scale_plu)) expect(csv, d.sku_code).toContain(d.scale_plu);

    const [root] = await e.db.q(`SELECT id::text FROM core.categories WHERE name = 'Cam'`);
    const t = await e.master.post('/admin/shelf-labels', { category_id: root?.['id'] as string });
    expect(t.status).toBe(200);
    expect(t.text).toContain('Cam sành (DEV)');
    expect(t.text).toContain('45.000đ');
  });
});
