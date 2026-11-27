import { createHash } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATALOG_COLUMNS, SUPPLIER_COLUMNS } from '../src/imports/import-columns';
import { ImportProcessor } from '../src/imports/import-processor';
import { EVENT_CONSUMERS, type EventConsumer } from '../src/infra/outbox/events';
import { WorkerModule } from '../src/worker.module';
import { schemaErrors } from './helpers/contract';
import { type AdminEnv, type Client, startAdminEnv } from './helpers/admin-env';
import { buildZip, CONTENT_TYPES_XLSX } from './helpers/zip';

// CP04 lát 5 — nhập / xuất Excel (PostgreSQL + Redis + S3 thật). Cổng T40: 200 SKU, 3 trùng mã vạch, bỏ qua ⇒ 197 nhập +
// báo 3; file độc (công thức, zip bomb, macro) bị từ chối; dry-run không ghi gì.

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
type Row = Record<string, string | number | { formula: string } | null>;

async function xlsx(cols: readonly { key: string; label: string }[], rows: Row[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Dữ liệu');
  ws.columns = cols.map((c) => ({ header: `${c.label} (${c.key})`, key: c.key }));
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('Nhập / xuất Excel (CP04 lát 5)', () => {
  let e: AdminEnv;
  let su: Client;
  const err = (r: { status: number; body: { code?: string } }) => [r.status, r.body.code];

  beforeAll(async () => {
    e = await startAdminEnv({ s3: true });
    su = await e.masterStepUp();
  }, 240_000);
  afterAll(async () => {
    await e?.close();
  });

  async function upload(buf: Buffer): Promise<string> {
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
    const c = await e.master.post(`/files/${p.body.id as string}/complete`, {});
    expect(c.status).toBe(200);
    return p.body.id as string;
  }
  /** tạo lượt + chạy processor như worker; trả lượt sau khi chạy */
  async function runImport(buf: Buffer, body: { type?: string; mode: string; dry_run: boolean }) {
    const file_id = await upload(buf);
    const c = await su.post('/admin/imports', {
      type: body.type ?? 'CATALOG',
      file_id,
      mode_on_duplicate: body.mode,
      dry_run: body.dry_run,
    });
    expect(c.status).toBe(201);
    expect(schemaErrors('ImportJob', c.body)).toEqual([]);
    expect(c.body.status).toBe('PENDING');
    await e.app.get(ImportProcessor).run(c.body.id as string);
    const g = await e.master.get(`/admin/imports/${c.body.id as string}`);
    expect(g.status).toBe(200);
    expect(schemaErrors('ImportJob', g.body)).toEqual([]);
    return g.body as {
      id: string;
      status: string;
      error: string | null;
      total_rows: number;
      ok_rows: number;
      skipped_rows: number;
      error_rows: number;
      report: {
        created: number;
        skipped: number;
        updated: number;
        errors: number;
        reason?: string;
        rows: { row: number; status: string; key?: string; field?: string; message?: string }[];
      };
    };
  }
  const ean = (n: number) => {
    const body = `893${String(n).padStart(9, '0')}`;
    const s = [...body].reduce((a, d, i) => a + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
    return `${body}${(10 - (s % 10)) % 10}`;
  };
  const countSkus = async (prefix: string) =>
    (await e.db.q(`SELECT count(*)::int AS n FROM core.skus WHERE sku_code LIKE $1`, [`${prefix}%`]))[0]?.n as number;

  it('T40: 200 SKU, 3 trùng mã vạch, chế độ bỏ qua ⇒ dry-run không ghi, chạy thật 197 nhập + báo 3', async () => {
    const tag = `T40${e.hex(2)}`;
    // một SKU có sẵn giữ mã vạch ean(9001) ⇒ dòng 50 trùng bản ghi đã có
    const cat = await e.master.post('/admin/categories', { name: `Có sẵn ${tag}` });
    const prod = await e.master.post('/admin/products', { category_id: cat.body.id as string, name: 'SP có sẵn' });
    const pre = await e.master.post('/admin/skus', {
      product_id: prod.body.id as string,
      sku_code: `PRE-${tag}`,
      name: 'Có sẵn',
      sale_unit_type: 'PIECE_FIXED',
      barcode: ean(9001),
    });
    expect(pre.status).toBe(201);
    const rows: Row[] = Array.from({ length: 200 }, (_, i) => ({
      category: `Trái cây ${tag} > ${i % 2 ? 'Cam' : 'Táo'}`,
      product: `SP ${i % 10}`,
      sku_code: `${tag}-${String(i + 1).padStart(3, '0')}`,
      name: `Hàng ${i + 1}`,
      sale_unit_type: i % 2 ? 'WEIGHT' : 'PIECE_FIXED',
      retail_price: 10000 + i,
      barcode: ean(i + 1),
    }));
    // 3 trùng: dòng 50 (Excel 51) trùng SKU có sẵn; dòng 120, 180 trùng dòng 10, 20 trong file
    (rows[49] as Row).barcode = ean(9001);
    (rows[119] as Row).barcode = ean(10);
    (rows[179] as Row).barcode = ean(20);
    const buf = await xlsx(CATALOG_COLUMNS, rows);

    const dry = await runImport(buf, { mode: 'SKIP', dry_run: true });
    expect(dry.status).toBe('COMPLETED');
    expect(dry.report).toMatchObject({ created: 197, skipped: 3, errors: 0 });
    expect(await countSkus(`${tag}-`)).toBe(0);

    const job = await runImport(buf, { mode: 'SKIP', dry_run: false });
    expect(job).toMatchObject({ status: 'COMPLETED', total_rows: 200, ok_rows: 197, skipped_rows: 3, error_rows: 0 });
    const skipped = job.report.rows.filter((r) => r.status === 'SKIPPED');
    expect(skipped.map((r) => [r.row, r.field])).toEqual([
      [51, 'barcode'],
      [121, 'barcode'],
      [181, 'barcode'],
    ]);
    expect(await countSkus(`${tag}-`)).toBe(197);
    // giá lẻ có lịch sử (lý do nêu lượt nhập), người đổi = Master tạo lượt
    const [s] = await e.db.q(
      `SELECT s.retail_price_per_kg::text AS kg, l.reason, l.changed_by::text AS by FROM core.skus s
       JOIN core.price_change_logs l ON l.sku_id = s.id WHERE s.sku_code = $1`,
      [`${tag}-002`],
    );
    expect(s).toMatchObject({ kg: '10001', by: e.masterId });
    expect(s?.reason).toContain(job.id);
    // audit từng SKU + tổng kết, người thực hiện = Master
    const [au] = await e.db.q(
      `SELECT count(*)::int AS n FROM audit.logs WHERE action = 'sku.create' AND actor_id = $1 AND request_id = $2`,
      [e.masterId, job.id],
    );
    expect(au?.n).toBe(197);
    const [done] = await e.db.q(`SELECT after FROM audit.logs WHERE action = 'import.complete' AND resource_id = $1`, [
      job.id,
    ]);
    expect(done?.after).toMatchObject({ okRows: 197, skippedRows: 3 });
    // chạy lại cùng lượt (giao sự kiện lần 2) ⇒ không làm gì
    await e.app.get(ImportProcessor).run(job.id);
    expect(await countSkus(`${tag}-`)).toBe(197);
  }, 180_000);

  it('chế độ STOP: gặp trùng ⇒ dừng, không nhập dòng nào; UPDATE: sửa SKU trùng mã, trùng mã vạch SKU khác ⇒ lỗi dòng', async () => {
    const tag = `UP${e.hex(2)}`;
    const base = (i: number): Row => ({
      category: `DM ${tag}`,
      product: 'SP',
      sku_code: `${tag}-${i}`,
      name: `Tên ${i}`,
      sale_unit_type: 'WEIGHT',
      retail_price: 20000,
      barcode: ean(5000 + i),
    });
    const first = await runImport(await xlsx(CATALOG_COLUMNS, [base(1), base(2)]), { mode: 'SKIP', dry_run: false });
    expect(first.ok_rows).toBe(2);

    const stop = await runImport(await xlsx(CATALOG_COLUMNS, [base(3), base(1)]), { mode: 'STOP', dry_run: false });
    expect(stop.status).toBe('FAILED');
    expect(stop.error).toMatch(/dòng 3/);
    expect(await countSkus(`${tag}-3`)).toBe(0);

    const upd = await runImport(
      await xlsx(CATALOG_COLUMNS, [
        { ...base(1), name: 'Tên mới', retail_price: 25000 },
        { ...base(2), barcode: ean(5001) }, // mã vạch của SKU 1 ⇒ không cập nhật được
        base(4),
      ]),
      { mode: 'UPDATE', dry_run: false },
    );
    expect(upd).toMatchObject({ status: 'COMPLETED', ok_rows: 2, error_rows: 1 });
    expect(upd.report.rows.map((r) => r.status)).toEqual(['UPDATED', 'ERROR', 'CREATED']);
    const [s1] = await e.db.q(`SELECT name, retail_price_per_kg::text AS kg FROM core.skus WHERE sku_code = $1`, [
      `${tag}-1`,
    ]);
    expect(s1).toEqual({ name: 'Tên mới', kg: '25000' });
  }, 120_000);

  it('lỗi từng dòng: thiếu / sai dữ liệu ⇒ báo dòng + cột, dòng khác vẫn nhập; thiếu cột bắt buộc ⇒ FAILED', async () => {
    const tag = `ER${e.hex(2)}`;
    const job = await runImport(
      await xlsx(CATALOG_COLUMNS, [
        { category: `DM ${tag}`, product: 'SP', sku_code: `${tag}-1`, name: 'Đúng', sale_unit_type: 'WEIGHT' },
        { category: `DM ${tag}`, product: 'SP', sku_code: `${tag}-2`, name: 'Sai kiểu', sale_unit_type: 'KHONG_CO' },
        {
          category: `DM ${tag}`,
          product: 'SP',
          sku_code: `${tag}-3`,
          name: 'Giá âm',
          sale_unit_type: 'WEIGHT',
          retail_price: -5,
        },
        // hộp cố định thiếu định lượng ⇒ service từ chối (quy tắc kiểu bán)
        { category: `DM ${tag}`, product: 'SP', sku_code: `${tag}-4`, name: 'Thiếu g', sale_unit_type: 'PACK_FIXED' },
        {
          category: `DM ${tag}`,
          product: 'SP',
          sku_code: `${tag}-5`,
          name: 'Mã vạch sai',
          sale_unit_type: 'PIECE_FIXED',
          barcode: '8938505970012',
        },
      ]),
      { mode: 'SKIP', dry_run: false },
    );
    expect(job.report.rows.map((r) => [r.row, r.status, r.field ?? null])).toEqual([
      [2, 'CREATED', null],
      [3, 'ERROR', 'sale_unit_type'],
      [4, 'ERROR', 'retail_price'],
      [5, 'ERROR', 'std_weight_g'],
      [6, 'ERROR', 'barcode'],
    ]);
    expect(job).toMatchObject({ status: 'COMPLETED', ok_rows: 1, error_rows: 4 });
    expect(await countSkus(`${tag}-`)).toBe(1);

    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('x').addRow(['Mã SKU (sku_code)', 'Tên SKU (name)']);
    const miss = await runImport(Buffer.from(await wb.xlsx.writeBuffer()), { mode: 'SKIP', dry_run: false });
    expect(miss.status).toBe('FAILED');
    expect(miss.error).toMatch(/Thiếu cột bắt buộc/);
  }, 120_000);

  it('file độc bị từ chối: công thức, zip bomb, macro, không phải xlsx — không ghi gì', async () => {
    const tag = `BAD${e.hex(2)}`;
    const formula = await xlsx(CATALOG_COLUMNS, [
      {
        category: `DM ${tag}`,
        product: 'SP',
        sku_code: `${tag}-1`,
        name: { formula: 'HYPERLINK("http://x","bấm")' },
        sale_unit_type: 'WEIGHT',
      },
    ]);
    const f1 = await runImport(formula, { mode: 'SKIP', dry_run: false });
    expect(f1.status).toBe('FAILED');
    expect(f1.report.reason).toBe('FORMULA');

    const bomb = buildZip([
      { name: '[Content_Types].xml', data: CONTENT_TYPES_XLSX },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(40 * 1024 * 1024, 0x41) },
    ]);
    expect(bomb.length).toBeLessThan(5 * 1024 * 1024);
    const f2 = await runImport(bomb, { mode: 'SKIP', dry_run: false });
    expect([f2.status, f2.report.reason]).toEqual(['FAILED', 'ZIP_BOMB']);

    const macro = buildZip([
      { name: '[Content_Types].xml', data: CONTENT_TYPES_XLSX },
      { name: 'xl/vbaProject.bin', data: Buffer.from('macro') },
    ]);
    const f3 = await runImport(macro, { mode: 'SKIP', dry_run: false });
    expect([f3.status, f3.report.reason]).toEqual(['FAILED', 'ACTIVE_CONTENT']);

    const notXlsx = buildZip([{ name: 'a.txt', data: Buffer.from('xin chào') }]);
    const f4 = await runImport(notXlsx, { mode: 'SKIP', dry_run: false });
    expect([f4.status, f4.report.reason]).toEqual(['FAILED', 'NOT_XLSX']);
    expect(await countSkus(`${tag}-`)).toBe(0);
  }, 120_000);

  it('nhập NCC: SĐT / tài khoản mã hóa; báo cáo + audit không chứa SĐT / số tài khoản', async () => {
    const tag = `NC${e.hex(2)}`;
    const job = await runImport(
      await xlsx(SUPPLIER_COLUMNS, [
        {
          code: `${tag}-1`,
          name: 'Vườn A',
          type: 'FARM',
          phone: '0912 777 888',
          bank_name: 'ACB',
          account_number: '123456789012',
          account_holder: 'tran van a',
        },
        { code: `${tag}-2`, name: 'Sai SĐT', type: 'FARM', phone: '0123' },
        { code: `${tag}-3`, name: 'Thiếu chủ TK', type: 'OTHER', account_number: '99998888777' },
      ]),
      { type: 'SUPPLIER', mode: 'SKIP', dry_run: false },
    );
    expect(job).toMatchObject({ status: 'COMPLETED', ok_rows: 1, error_rows: 2 });
    const [s] = await e.db.q(
      `SELECT id::text, phone_enc IS NOT NULL AS p, bank_enc IS NOT NULL AS b FROM core.suppliers WHERE code = $1`,
      [`${tag}-1`],
    );
    expect(s).toMatchObject({ p: true, b: true });
    const leaks = ['912777888', '0912', '123456789012', '99998888777', 'TRAN VAN A', 'tran van a'];
    const report = JSON.stringify(job);
    for (const l of leaks) expect(report).not.toContain(l);
    const logs = JSON.stringify(
      await e.db.q(`SELECT before, after, reason FROM audit.logs WHERE request_id = $1 OR resource_id = $1`, [job.id]),
    );
    for (const l of leaks) expect(logs).not.toContain(l);
  }, 120_000);

  it('quyền: tạo lượt cần Master + step-up; file phải của chính người gọi, đã READY, loại IMPORT_XLSX', async () => {
    const id = await upload(await xlsx(CATALOG_COLUMNS, []));
    const body = { type: 'CATALOG', file_id: id, mode_on_duplicate: 'SKIP', dry_run: true };
    // phiên Master đã step-up ở beforeAll ⇒ cho hết hạn để thử, rồi step-up lại
    await e.db.q(`UPDATE core.sessions SET step_up_until = now() - interval '1 second' WHERE user_id = $1`, [
      e.masterId,
    ]);
    expect(err(await e.master.post('/admin/imports', body))).toEqual([403, 'STEP_UP_REQUIRED']);
    su = await e.masterStepUp();
    const sm = await e.storeManager();
    expect((await sm.post('/admin/imports', body)).status).toBe(403); // guard kiểm step-up trước quyền (có sẵn CP03)
    expect(err(await sm.get('/admin/imports'))).toEqual([403, 'ACTION_FORBIDDEN']);
    expect(err(await su.post('/admin/imports', { ...body, file_id: e.masterId }))).toEqual([404, 'RESOURCE_NOT_FOUND']);
    expect(err(await su.post('/admin/imports', { ...body, mode_on_duplicate: 'MERGE' }))).toEqual([
      400,
      'INVALID_REQUEST',
    ]);
    // nhân viên không tải được file IMPORT_XLSX
    const p = await sm.post('/files/presign', {
      kind: 'IMPORT_XLSX',
      mime: XLSX,
      bytes: 100,
      sha256: 'a'.repeat(64),
      capture_source: 'GALLERY',
    });
    expect(err(p)).toEqual([403, 'ACTION_FORBIDDEN']);
    const l = await e.master.get('/admin/imports?limit=5');
    expect(l.status).toBe(200);
    expect(schemaErrors('ImportJobList', l.body)).toEqual([]);
  }, 120_000);

  it('file mẫu + xuất danh sách: SKU xuất cùng cột với file nhập; NCC không có SĐT / số tài khoản', async () => {
    const t = await e.master
      .get('/admin/imports/templates/CATALOG')
      .buffer(true)
      .parse((res, cb) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => cb(null, Buffer.concat(parts)));
      });
    expect(t.status).toBe(200);
    expect(t.headers['content-type']).toContain(XLSX);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(t.body as ArrayBuffer);
    expect(wb.worksheets[0]?.getRow(1).getCell(1).value).toBe('Danh mục (category) *');

    const ex = await e.master.post('/admin/catalog-exports', { list: 'skus' });
    expect(ex.status).toBe(201);
    expect(schemaErrors('CatalogExport', ex.body)).toEqual([]);
    const got = await fetch(ex.body.url as string);
    expect(got.ok).toBe(true);
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(await got.arrayBuffer());
    const head = (wb2.worksheets[0]?.getRow(1).values as unknown[]).slice(1, CATALOG_COLUMNS.length + 1);
    expect(head).toEqual(CATALOG_COLUMNS.map((c) => `${c.label} (${c.key})`));

    await e.master.post('/admin/suppliers', {
      code: `EXP${e.hex()}`,
      name: 'NCC xuất',
      type: 'FARM',
      phone: '0909 123 456',
      bank_account: { account_number: '5556667778', account_holder: 'A B' },
    });
    const sx = await e.master.post('/admin/catalog-exports', { list: 'suppliers' });
    const raw = Buffer.from(await (await fetch(sx.body.url as string)).arrayBuffer());
    const wb3 = new ExcelJS.Workbook();
    await wb3.xlsx.load(raw as unknown as ArrayBuffer);
    const all = JSON.stringify(wb3.worksheets[0]?.getSheetValues());
    for (const l of ['909123456', '0909', '5556667778']) expect(all).not.toContain(l);
    for (const list of ['categories', 'stores', 'locations'])
      expect((await e.master.post('/admin/catalog-exports', { list })).status).toBe(201);
    const sm = await e.storeManager();
    expect(err(await sm.post('/admin/catalog-exports', { list: 'skus' }))).toEqual([403, 'ACTION_FORBIDDEN']);
    const [a] = await e.db.q(`SELECT after FROM audit.logs WHERE action = 'export.create' AND resource_id = $1`, [
      sx.body.file_id,
    ]);
    expect(a?.after).toMatchObject({ list: 'suppliers' });
  }, 120_000);

  it('worker thật: WorkerModule dựng được, consumer catalog-import chạy lượt từ sự kiện outbox', async () => {
    const tag = `WK${e.hex(2)}`;
    const file_id = await upload(
      await xlsx(CATALOG_COLUMNS, [
        { category: `DM ${tag}`, product: 'SP', sku_code: `${tag}-1`, name: 'Từ worker', sale_unit_type: 'WEIGHT' },
      ]),
    );
    const c = await su.post('/admin/imports', { type: 'CATALOG', file_id, mode_on_duplicate: 'SKIP', dry_run: false });
    const [ev] = await e.db.q(
      `SELECT id::text, event_type, schema_version, aggregate_type, aggregate_id::text, payload, occurred_at
       FROM integration.outbox WHERE aggregate_id = $1`,
      [c.body.id],
    );
    expect(ev?.event_type).toBe('catalog.import_requested');
    const w = await NestFactory.createApplicationContext(WorkerModule.forRoot(e.env), { logger: false });
    try {
      const consumers = w.get<EventConsumer[]>(EVENT_CONSUMERS);
      const consumer = consumers.find((x) => x.name === 'catalog-import');
      expect(consumer).toBeDefined();
      await consumer?.handle(
        {
          event_id: ev?.id as string,
          event_type: ev?.event_type as string,
          schema_version: ev?.schema_version as number,
          aggregate_type: ev?.aggregate_type as string,
          aggregate_id: ev?.aggregate_id as string,
          occurred_at: (ev?.occurred_at as Date).toISOString(),
          payload: ev?.payload,
        },
        undefined as never,
      );
    } finally {
      await w.close();
    }
    // kiểm qua DB: TransactionHost của @nestjs-cls/transactional là biến tĩnh — dựng worker CÙNG tiến trình ghi đè nó
    // (production: API và worker là hai tiến trình) ⇒ test này để CUỐI, không gọi API sau đó
    const [j] = await e.db.q(`SELECT status::text, ok_rows FROM core.import_jobs WHERE id = $1`, [c.body.id]);
    expect(j).toEqual({ status: 'COMPLETED', ok_rows: 1 });
    expect(await countSkus(`${tag}-`)).toBe(1);
  }, 120_000);
});
