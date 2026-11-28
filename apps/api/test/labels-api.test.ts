import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ean13Modules } from '../src/labels/ean13-svg';
import { schemaErrors } from './helpers/contract';
import { type AdminEnv, startAdminEnv } from './helpers/admin-env';

// CP04 lát 6 — quy tắc mã vạch cân, xuất PLU (export_logs), thương hiệu (logo qua file), tem giá kệ (PostgreSQL + Redis + S3).
// Cổng: checksum Phụ lục B (vector chung TS/Dart ở packages/money_weight); xuất PLU ghi log, thiếu quyền ⇒ 403.

describe('PLU, mã vạch cân, thương hiệu, tem (CP04 lát 6)', () => {
  let e: AdminEnv;
  const err = (r: { status: number; body: { code?: string } }) => [r.status, r.body.code];

  beforeAll(async () => {
    e = await startAdminEnv({ s3: true });
  }, 240_000);
  afterAll(async () => {
    await e?.close();
  });

  async function sku(body: Record<string, unknown>) {
    const c = await e.master.post('/admin/categories', { name: `DM ${e.hex()}` });
    const p = await e.master.post('/admin/products', { category_id: c.body.id as string, name: `SP ${e.hex()}` });
    const r = await e.master.post('/admin/skus', {
      product_id: p.body.id as string,
      sku_code: `L-${e.hex()}`,
      name: `SKU ${e.hex()}`,
      sale_unit_type: 'WEIGHT',
      ...body,
    });
    expect(r.status).toBe(201);
    return r.body as { id: string; version: number; sku_code: string };
  }
  const price = async (s: { id: string }, global: string, stores: { store_id: string; price: string }[] = []) => {
    const cur = await e.master.get(`/admin/prices/${s.id}`);
    const r = await e.master.put(`/admin/prices/${s.id}`, {
      reason: 'test',
      version: cur.body.version as number,
      global,
      stores,
    });
    expect(r.status).toBe(200);
  };
  // PLU duy nhất trong lượt test (không ngẫu nhiên — tránh trùng)
  let pluSeq = 30000 + Math.floor(Math.random() * 1000) * 50;
  const plu = () => String(pluSeq++);

  it('quy tắc mã vạch: seed W1/W2/W3/PRODUCT; tạo / sửa; mẫu sai ⇒ 422; trùng code / priority ⇒ 409; quyền', async () => {
    const l = await e.master.get('/admin/barcode-rules');
    expect(l.status).toBe(200);
    expect(schemaErrors('BarcodeRuleList', l.body)).toEqual([]);
    expect((l.body.items as { code: string }[]).map((x) => x.code)).toEqual(
      expect.arrayContaining(['W1', 'W2', 'W3', 'PRODUCT']),
    );
    const c = await e.master.post('/admin/barcode-rules', {
      code: 'w10',
      name: 'Tem cân 10 g',
      priority: 40,
      type: 'WEIGHT',
      pattern: '23{PLU:5}{W:5}{C}',
      value_scale: 10,
      ean13_checksum: true,
    });
    expect(c.status).toBe(201);
    expect(schemaErrors('BarcodeRule', c.body)).toEqual([]);
    expect(c.body).toMatchObject({ code: 'W10', enabled: false });
    const bad = await e.master.post('/admin/barcode-rules', {
      code: 'BAD',
      name: 'x',
      priority: 41,
      type: 'WEIGHT',
      pattern: '23{PLU:5}{W:5}',
      ean13_checksum: true,
    });
    expect(err(bad)).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    expect((bad.body as { details: { field: string } }).details.field).toBe('pattern');
    const dupP = await e.master.post('/admin/barcode-rules', {
      code: 'X1',
      name: 'x',
      priority: 40,
      type: 'PRODUCT',
      pattern: 'X{CODE}',
      ean13_checksum: false,
    });
    expect(err(dupP)).toEqual([409, 'VERSION_CONFLICT']);
    expect((dupP.body as { details: { field: string } }).details.field).toBe('priority');
    const dupC = await e.master.post('/admin/barcode-rules', {
      code: 'W10',
      name: 'x',
      priority: 42,
      type: 'PRODUCT',
      pattern: 'X{CODE}',
      ean13_checksum: false,
    });
    expect(err(dupC)).toEqual([409, 'VERSION_CONFLICT']);
    expect((dupC.body as { details: { field: string } }).details.field).toBe('code');
    // tem cân phải có tiền tố 20–29 (mã hàng đóng gói 89… không bị đọc nhầm thành hàng cân — review TS lát 6 C1)
    const p89 = await e.master.post('/admin/barcode-rules', {
      code: 'P89',
      name: 'x',
      priority: 43,
      type: 'WEIGHT',
      pattern: '89{PLU:5}{W:5}{C}',
      ean13_checksum: true,
    });
    expect(err(p89)).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    const id = c.body.id as string;
    const on = await e.master.patch(`/admin/barcode-rules/${id}`, { enabled: true });
    expect(on.body.enabled).toBe(true);
    expect(err(await e.master.patch(`/admin/barcode-rules/${id}`, { pattern: '23{PLU:5}{P:5}{C}' }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    expect((await e.master.patch(`/admin/barcode-rules/${id}`, { type: 'PRICE' })).status).toBe(400);
    const sm = await e.storeManager();
    expect((await sm.get('/admin/barcode-rules')).status).toBe(200);
    expect(err(await sm.patch(`/admin/barcode-rules/${id}`, { enabled: false }))).toEqual([403, 'ACTION_FORBIDDEN']);
    await e.master.patch(`/admin/barcode-rules/${id}`, { enabled: false });
  });

  it('sắp lại thứ tự: đổi chỗ không cần giá trị tạm; giữ tập priority; danh sách cũ ⇒ 409; quyền; audit', async () => {
    type Rule = { id: string; code: string; priority: number };
    const cur = (await e.master.get('/admin/barcode-rules')).body.items as Rule[];
    const prios = cur.map((r) => r.priority);
    const rev = [...cur].reverse().map((r) => r.id);
    const r = await e.master.post('/admin/barcode-rules/reorder', { ids: rev });
    expect(r.status).toBe(200);
    expect(schemaErrors('BarcodeRuleList', r.body)).toEqual([]);
    const after = r.body.items as Rule[];
    expect(after.map((x) => x.id)).toEqual(rev);
    expect(after.map((x) => x.priority)).toEqual(prios);
    // thiếu một quy tắc / trùng id ⇒ danh sách đã đổi
    expect(err(await e.master.post('/admin/barcode-rules/reorder', { ids: rev.slice(1) }))).toEqual([
      409,
      'VERSION_CONFLICT',
    ]);
    expect(err(await e.master.post('/admin/barcode-rules/reorder', { ids: [rev[0], ...rev.slice(0, -1)] }))).toEqual([
      409,
      'VERSION_CONFLICT',
    ]);
    const sm = await e.storeManager();
    expect(err(await sm.post('/admin/barcode-rules/reorder', { ids: rev }))).toEqual([403, 'ACTION_FORBIDDEN']);
    const audit = await e.db.q(`SELECT count(*)::text AS n FROM audit.logs WHERE action = 'barcode_rule.reorder'`);
    expect(Number(audit[0]?.n)).toBeGreaterThanOrEqual(1);
    // trả lại thứ tự cũ cho các test sau
    const back = await e.master.post('/admin/barcode-rules/reorder', { ids: cur.map((x) => x.id) });
    expect((back.body.items as Rule[]).map((x) => x.code)).toEqual(cur.map((x) => x.code));
  });

  it('giải mã: Phụ lục B (2000123008455 ⇒ PLU 00123, 845 g) + tra SKU; sai số kiểm ⇒ CHECKSUM; mã hàng đóng gói', async () => {
    const pluCode = '00123';
    await e.db.q(`UPDATE core.skus SET scale_plu = NULL WHERE scale_plu = $1`, [pluCode]);
    const s = await sku({ scale_plu: pluCode, sold_by_scale: true });
    const d = await e.master.get('/admin/barcode-rules/decode?code=2000123008455');
    expect(d.status).toBe(200);
    expect(schemaErrors('BarcodeDecodeResult', d.body)).toEqual([]);
    expect(d.body).toMatchObject({ ok: true, rule: 'W1', type: 'WEIGHT', plu: '00123', grams: 845 });
    expect(d.body.sku).toMatchObject({ id: s.id });
    const ck = await e.master.get('/admin/barcode-rules/decode?code=2000123008454');
    expect(ck.body).toMatchObject({ ok: false, reason: 'CHECKSUM', rule: 'W1', sku: null });
    const packed = await sku({ sale_unit_type: 'PIECE_FIXED', barcode: '8938505970011' });
    const p = await e.master.get('/admin/barcode-rules/decode?code=8938505970011');
    expect(p.body).toMatchObject({ ok: true, rule: 'PRODUCT', value: '8938505970011' });
    expect(p.body.sku).toMatchObject({ id: packed.id });
    expect((await e.master.get('/admin/barcode-rules/decode?code=abc')).status).toBe(400);
    expect(schemaErrors('BarcodeDecodeResult', ck.body)).toEqual([]);
    // quy tắc hỏng trong DB (qua CHECK nhưng không phân tích được — sửa tay bằng SQL) ⇒ bỏ qua, không 500
    await e.db.q(
      `INSERT INTO core.barcode_rules (id, code, name, priority, type, pattern, value_scale, ean13_checksum, enabled)
       VALUES (gen_random_uuid(), 'BROKEN', 'hỏng', 1, 'WEIGHT', '{C}20{PLU:5}{W:5}', 1, false, true)`,
    );
    try {
      const again = await e.master.get('/admin/barcode-rules/decode?code=2000123008455');
      expect(again.body).toMatchObject({ ok: true, rule: 'W1' });
      expect(again.body.skipped_rules).toEqual(['BROKEN']);
      expect(schemaErrors('BarcodeDecodeResult', again.body)).toEqual([]);
    } finally {
      await e.db.q(`DELETE FROM core.barcode_rules WHERE code = 'BROKEN'`);
    }
  });

  it('xuất PLU: chỉ SKU bán qua cân có giá, giá cửa hàng; ghi export_logs; thiếu quyền ⇒ 403; không chọn cửa hàng cần ALL', async () => {
    const st = await e.master.post('/admin/stores', { code: `p${e.hex()}`, name: 'CH PLU' });
    const storeId = st.body.id as string;
    const a = await sku({ scale_plu: plu(), sold_by_scale: true, name: '=Cam "sành" 1+1' });
    const b = await sku({ scale_plu: plu(), sold_by_scale: true });
    const c = await sku({ sale_unit_type: 'PIECE_FIXED' });
    await price(a, '45000', [{ store_id: storeId, price: '50000' }]);
    await price(c, '10000');
    const x = await e.master.post('/admin/plu-export', { store_id: storeId, format: 'CSV' });
    expect(x.status).toBe(201);
    expect(schemaErrors('PluExport', x.body)).toEqual([]);
    expect(x.body.skipped_no_price).toContain(b.sku_code);
    const raw = Buffer.from(await (await fetch(x.body.url as string)).arrayBuffer());
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = raw.subarray(3).toString('utf8');
    const line = csv.split('\r\n').find((l) => l.includes(a.sku_code)) ?? '';
    expect(line).toContain('"50000"');
    // nháy kép nhân đôi; bắt đầu bằng = ⇒ thêm ' (chống chèn công thức); cột không dấu
    expect(line).toContain(`"'=Cam ""sành"" 1+1"`);
    expect(line).toContain(`"'=Cam ""sanh"" 1+1"`);
    expect(csv).not.toContain(c.sku_code);
    expect(csv).not.toContain(b.sku_code);
    const [log] = await e.db.q(
      `SELECT export_type, filters, rows, user_id::text FROM audit.export_logs WHERE file_id = $1`,
      [x.body.file_id],
    );
    expect(log).toMatchObject({ export_type: 'PLU', rows: x.body.rows, user_id: e.masterId });
    expect(log?.filters).toMatchObject({ store_id: storeId, format: 'CSV' });
    // không chọn cửa hàng ⇒ giá chung (45000), XLSX
    const g = await e.master.post('/admin/plu-export', { format: 'XLSX' });
    expect(g.status).toBe(201);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await (await fetch(g.body.url as string)).arrayBuffer());
    const all = JSON.stringify(wb.worksheets[0]?.getSheetValues());
    expect(all).toContain('45000');
    // cửa hàng trưởng: không có plu:export ⇒ 403; cấp riêng phạm vi cửa hàng ⇒ chỉ cửa hàng mình, giá chung cần ALL
    const sm = await e.storeManager();
    expect(err(await sm.post('/admin/plu-export', { store_id: sm.storeId }))).toEqual([403, 'ACTION_FORBIDDEN']);
    const sp = await e.storeManager({ grants: ['plu:export'] });
    expect((await sp.post('/admin/plu-export', { store_id: sp.storeId })).status).toBe(201);
    expect(err(await sp.post('/admin/plu-export', { store_id: storeId }))).toEqual([404, 'RESOURCE_NOT_FOUND']);
    expect(err(await sp.post('/admin/plu-export', {}))).toEqual([403, 'ACTION_FORBIDDEN']);
    // cửa hàng đã lưu trữ ⇒ 422
    const old = await e.master.post('/admin/stores', { code: `o${e.hex()}`, name: 'CH cũ' });
    await e.master.patch(`/admin/stores/${old.body.id as string}`, { archived: true });
    expect(err(await e.master.post('/admin/plu-export', { store_id: old.body.id as string }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    // xuất danh sách (lát 5) cũng ghi export_logs
    const ex = await e.master.post('/admin/catalog-exports', { list: 'categories' });
    const [l2] = await e.db.q(`SELECT export_type FROM audit.export_logs WHERE file_id = $1`, [ex.body.file_id]);
    expect(l2?.export_type).toBe('CATALOG_CATEGORIES');
  });

  it('thương hiệu: logo qua file BRAND_LOGO READY; file sai loại ⇒ 422; chỉ Master; audit giữ địa chỉ hiển thị', async () => {
    const g = await e.master.get('/admin/brand');
    expect(g.status).toBe(200);
    expect(schemaErrors('BrandSettings', g.body)).toEqual([]);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const p = await e.master.post('/files/presign', {
      kind: 'BRAND_LOGO',
      mime: 'image/png',
      bytes: png.length,
      sha256: createHash('sha256').update(png).digest('hex'),
      capture_source: 'GALLERY',
    });
    expect(p.status).toBe(200);
    await fetch(p.body.upload_url as string, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array(png),
    });
    const done = await e.master.post(`/files/${p.body.id as string}/complete`, {});
    expect(done.body.status).toBe('READY');
    const u = await e.master.put('/admin/brand', {
      brand_name: 'Hoa Quả Tươi',
      hotline: '1900 1234',
      display_address: '12 Lê Lợi, Q1',
      primary_color: '#2E7D32',
      logo_mono_file_id: p.body.id as string,
    });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ brand_name: 'Hoa Quả Tươi', logo_mono_file_id: p.body.id, updated_by: e.masterId });
    const [a] = await e.db.q(`SELECT after FROM audit.logs WHERE action = 'brand.update' ORDER BY at DESC LIMIT 1`);
    expect((a?.after as { display_address: string }).display_address).toBe('12 Lê Lợi, Q1');
    // file không phải BRAND_LOGO / chưa READY ⇒ 422
    const p2 = await e.master.post('/files/presign', {
      kind: 'PHOTO_PRODUCT',
      mime: 'image/jpeg',
      bytes: 10,
      sha256: 'a'.repeat(64),
      capture_source: 'GALLERY',
    });
    expect(err(await e.master.put('/admin/brand', { logo_color_file_id: p2.body.id as string }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    expect((await e.master.put('/admin/brand', { primary_color: 'xanh' })).status).toBe(400);
    expect((await e.master.put('/admin/brand', { privacy_url: 'http://x.vn' })).status).toBe(400);
    const sm = await e.storeManager();
    expect((await sm.get('/admin/brand')).status).toBe(200);
    expect(err(await sm.put('/admin/brand', { brand_name: 'x' }))).toEqual([403, 'ACTION_FORBIDDEN']);
    expect((await e.master.put('/admin/brand', { logo_mono_file_id: null })).body.logo_mono_file_id).toBeNull();
  });

  it('tem giá kệ: HTML in được, chữ được thoát, giá cửa hàng, mã vạch SVG; phạm vi cửa hàng', async () => {
    const st = await e.master.post('/admin/stores', { code: `t${e.hex()}`, name: 'CH tem' });
    const storeId = st.body.id as string;
    const a = await sku({ name: '<script>alert(1)</script> Cam', scale_plu: plu(), sold_by_scale: true });
    const b = await sku({
      sale_unit_type: 'PIECE_FIXED',
      name: 'Táo & lê',
      units: [
        {
          unit_code: 'PACK',
          name: 'Hộp 6 quả',
          factor_units: 6,
          for_sale: true,
          for_purchase: false,
          barcode: '8934567890120',
        },
      ],
    });
    await price(a, '45000', [{ store_id: storeId, price: '52000' }]);
    await price(b, '12000');
    // đơn vị gốc của b không có mã vạch; đơn vị bán thêm có mã ⇒ tem lấy mã đó
    const c = await sku({ sale_unit_type: 'PIECE_FIXED', name: 'Chưa có giá' });
    const r = await e.master.post('/admin/shelf-labels', { sku_ids: [a.id, b.id, c.id], store_id: storeId });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    const csp = r.headers['content-security-policy'] as string;
    for (const d of [
      "default-src 'none'",
      'sandbox',
      "frame-ancestors 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ])
      expect(csp).toContain(d);
    expect(r.headers['x-label-count']).toBe('3');
    const h = r.text;
    expect(h).not.toContain('<script>');
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Cam');
    expect(h).toContain('Táo &amp; lê');
    expect(h).toContain('52.000đ');
    expect(h).toContain('/kg');
    // một đơn vị hiển thị: hộp có mã vạch ⇒ giá HỘP (12.000 × 6 = 72.000đ) + "/Hộp 6 quả" + mã vạch của hộp — khớp POS
    expect(h).toContain('72.000đ<span class="per">/Hộp 6 quả</span>');
    expect(h).not.toContain('12.000đ');
    expect(h).toContain('Chưa có giá');
    expect(h).toContain('<svg');
    expect(h).toContain('aria-label="8934567890120"');
    expect(h.match(/class="page"/g)).toHaveLength(1);
    // hộp có giá riêng ⇒ tem in giá riêng của hộp (ưu tiên giá đơn vị — lát 3)
    const full = await e.master.get(`/admin/skus/${b.id}`);
    const box = (full.body.units as { id: string; name: string }[]).find((u) => u.name === 'Hộp 6 quả');
    const cur = await e.master.get(`/admin/prices/${b.id}`);
    expect(
      (
        await e.master.put(`/admin/prices/${b.id}`, {
          reason: 'giá hộp',
          version: cur.body.version as number,
          units: [{ sku_unit_id: box?.id as string, price: '65000' }],
        })
      ).status,
    ).toBe(200);
    const r2 = await e.master.post('/admin/shelf-labels', { sku_ids: [b.id], store_id: storeId });
    expect(r2.text).toContain('65.000đ<span class="per">/Hộp 6 quả</span>');
    expect((await e.master.post('/admin/shelf-labels', { sku_ids: [a.id], category_id: a.id })).status).toBe(400);
    expect((await e.master.post('/admin/shelf-labels', {})).status).toBe(400);
    const sm = await e.storeManager();
    expect((await sm.post('/admin/shelf-labels', { sku_ids: [a.id], store_id: sm.storeId })).status).toBe(200);
    expect(err(await sm.post('/admin/shelf-labels', { sku_ids: [a.id], store_id: storeId }))).toEqual([
      404,
      'RESOURCE_NOT_FOUND',
    ]);
    // không chọn cửa hàng (giá chung) ⇒ cần phạm vi toàn chuỗi
    expect(err(await sm.post('/admin/shelf-labels', { sku_ids: [a.id] }))).toEqual([403, 'ACTION_FORBIDDEN']);
    // > 24 tem ⇒ nhiều trang A4
    const many = await Promise.all(Array.from({ length: 25 }, () => sku({ sale_unit_type: 'PIECE_FIXED' })));
    const p2 = await e.master.post('/admin/shelf-labels', { sku_ids: many.map((x) => x.id) });
    expect(p2.text.match(/class="page"/g)).toHaveLength(2);
  }, 120_000);

  it('EAN-13 SVG: 95 mô-đun, vạch bảo vệ, bảng L/G/R nhất quán (R = bù L, G = đảo R), giải ngược ra đúng mã', () => {
    const code = '2000123008455';
    const m = ean13Modules(code);
    expect(m).toHaveLength(95);
    expect(m.slice(0, 3)).toBe('101');
    expect(m.slice(45, 50)).toBe('01010');
    expect(m.slice(92)).toBe('101');
    // giải ngược theo bảng chuẩn
    const L = [
      '0001101',
      '0011001',
      '0010011',
      '0111101',
      '0100011',
      '0110001',
      '0101111',
      '0111011',
      '0110111',
      '0001011',
    ];
    const R = L.map((x) => [...x].map((c) => (c === '1' ? '0' : '1')).join(''));
    const G = R.map((x) => [...x].reverse().join(''));
    const PAR = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
    let parity = '';
    let digits = '';
    for (let i = 0; i < 6; i++) {
      const w = m.slice(3 + i * 7, 10 + i * 7);
      const l = L.indexOf(w);
      parity += l >= 0 ? 'L' : 'G';
      digits += String(l >= 0 ? l : G.indexOf(w));
    }
    for (let i = 0; i < 6; i++) digits += String(R.indexOf(m.slice(50 + i * 7, 57 + i * 7)));
    expect(`${PAR.indexOf(parity)}${digits}`).toBe(code);
    expect(() => ean13Modules('2000123008454')).toThrow();
  });
});
