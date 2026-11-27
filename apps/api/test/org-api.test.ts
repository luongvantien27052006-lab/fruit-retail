import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schemaErrors } from './helpers/contract';
import { type AdminEnv, startAdminEnv } from './helpers/admin-env';

// CP04 lát 4 — tổ chức (cửa hàng, kho, vị trí, quầy, vị trí mặc định) + danh bạ NCC (PostgreSQL + Redis thật).
// Cổng: phạm vi cửa hàng (cửa hàng trưởng chỉ cửa hàng mình); PII NCC không lộ trong audit.

describe('API tổ chức + NCC (CP04 lát 4)', () => {
  let e: AdminEnv;
  const err = (r: { status: number; body: { code?: string } }) => [r.status, r.body.code];

  beforeAll(async () => {
    e = await startAdminEnv();
  });
  afterAll(async () => {
    await e?.close();
  });

  async function newStore(body: Record<string, unknown> = {}) {
    const r = await e.master.post('/admin/stores', { code: `s${e.hex()}`, name: `CH ${e.hex()}`, ...body });
    expect(r.status).toBe(201);
    return r.body as { id: string; code: string };
  }
  async function newSku() {
    const c = await e.master.post('/admin/categories', { name: `DM ${e.hex()}` });
    const p = await e.master.post('/admin/products', { category_id: c.body.id as string, name: `SP ${e.hex()}` });
    const r = await e.master.post('/admin/skus', {
      product_id: p.body.id as string,
      sku_code: `O-${e.hex()}`,
      name: `SKU ${e.hex()}`,
      sale_unit_type: 'WEIGHT',
    });
    expect(r.status).toBe(201);
    return r.body as { id: string; version: number };
  }
  const audits = (resourceId: string) =>
    e.db.q(`SELECT action, before, after FROM audit.logs WHERE resource_id = $1 ORDER BY at, id`, [resourceId]);

  it('cửa hàng: tạo (CLOSED/PAUSED + vị trí đang vận chuyển), trùng mã, giờ mở, điều kiện nhận đơn app', async () => {
    const s = await e.master.post('/admin/stores', {
      code: `q${e.hex()}`,
      name: 'Cửa hàng Quận 1',
      address: '12 Lê Lợi, Q1',
      opening_hours: {
        mon: [
          ['07:00', '12:00'],
          ['13:00', '21:00'],
        ],
        sun: [['08:00', '24:00']],
      },
    });
    expect(s.status).toBe(201);
    expect(schemaErrors('Store', s.body)).toEqual([]);
    expect(s.body).toMatchObject({ pos_status: 'CLOSED', app_status: 'PAUSED', status: 'ACTIVE' });
    expect(s.body.code).toMatch(/^Q[0-9A-F]{6}$/);
    const id = s.body.id as string;
    const loc = await e.master.get(`/admin/locations?store_id=${id}`);
    expect(loc.status).toBe(200);
    expect(schemaErrors('LocationList', loc.body)).toEqual([]);
    expect(loc.body.items).toEqual([expect.objectContaining({ type: 'IN_TRANSIT', code: 'IN_TRANSIT', store_id: id })]);
    // audit giữ địa chỉ cửa hàng (công khai)
    const [a] = await audits(id);
    expect((a?.after as { address: string }).address).toBe('12 Lê Lợi, Q1');

    expect(err(await e.master.post('/admin/stores', { code: s.body.code as string, name: 'x' }))).toEqual([
      409,
      'VERSION_CONFLICT',
    ]);
    expect((await e.master.post('/admin/stores', { code: `z${e.hex()}`, name: 'x', lat: 10.7 })).status).toBe(400);
    for (const opening_hours of [
      { mon: [['09:00', '08:00']] },
      {
        mon: [
          ['07:00', '12:00'],
          ['11:00', '13:00'],
        ],
      },
      { mon: [['25:00', '26:00']] },
      { xyz: [['07:00', '08:00']] },
    ])
      expect((await e.master.patch(`/admin/stores/${id}`, { opening_hours })).status).toBe(400);
    expect((await e.master.patch(`/admin/stores/${id}`, { name: 'a\u0000b' })).status).toBe(400);
    expect((await e.master.patch(`/admin/stores/${id}`, {})).status).toBe(400);

    // ONLINE cần tọa độ + giờ mở + năng lực > 0
    expect(err(await e.master.patch(`/admin/stores/${id}`, { app_status: 'ONLINE' }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    // giờ mở rỗng (nghỉ cả tuần) ⇒ không nhận đơn app (review TS N1)
    for (const opening_hours of [{}, { mon: [] }])
      expect(
        err(
          await e.master.patch(`/admin/stores/${id}`, {
            opening_hours,
            lat: 10.7769,
            lng: 106.7009,
            app_capacity_per_hour: 30,
            app_status: 'ONLINE',
          }),
        ),
      ).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    await e.master.patch(`/admin/stores/${id}`, {
      opening_hours: {
        mon: [
          ['07:00', '12:00'],
          ['13:00', '21:00'],
        ],
        sun: [['08:00', '24:00']],
      },
    });
    const on = await e.master.patch(`/admin/stores/${id}`, {
      lat: 10.7769,
      lng: 106.7009,
      app_capacity_per_hour: 30,
      app_status: 'ONLINE',
      pos_status: 'OPEN',
    });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ app_status: 'ONLINE', pos_status: 'OPEN', lat: 10.7769 });
    // ngừng hoạt động ⇒ tự CLOSED + PAUSED
    const off = await e.master.patch(`/admin/stores/${id}`, { status: 'INACTIVE' });
    expect(off.body).toMatchObject({ status: 'INACTIVE', pos_status: 'CLOSED', app_status: 'PAUSED' });
    expect(err(await e.master.patch(`/admin/stores/${id}`, { pos_status: 'OPEN' }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
  });

  it('lưu trữ cửa hàng: còn máy POS ACTIVE ⇒ 422; lưu trữ ⇒ không mở bán; mở lại', async () => {
    const sm = await e.storeManager();
    const r = await e.master.patch(`/admin/stores/${sm.storeId}`, { archived: true });
    expect(err(r)).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    expect((r.body as { details: { active_pos_devices: number } }).details.active_pos_devices).toBe(1);

    const s = await newStore();
    const a = await e.master.patch(`/admin/stores/${s.id}`, { archived: true });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ status: 'INACTIVE', pos_status: 'CLOSED', app_status: 'PAUSED' });
    expect(a.body.archived_at).not.toBeNull();
    expect(err(await e.master.patch(`/admin/stores/${s.id}`, { pos_status: 'OPEN' }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    // không gắn vị trí / quầy mới vào cửa hàng lưu trữ
    expect(
      err(await e.master.post('/admin/locations', { store_id: s.id, type: 'SHELF', code: 'K1', name: 'Kệ 1' })),
    ).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    expect(err(await e.master.post(`/admin/stores/${s.id}/registers`, { code: 'Q1' }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    const list = await e.master.get('/admin/stores');
    expect((list.body.items as { id: string }[]).some((x) => x.id === s.id)).toBe(false);
    const all = await e.master.get('/admin/stores?include_archived=true');
    expect((all.body.items as { id: string }[]).some((x) => x.id === s.id)).toBe(true);
    const back = await e.master.patch(`/admin/stores/${s.id}`, { archived: false, status: 'ACTIVE' });
    expect(back.body).toMatchObject({ status: 'ACTIVE', archived_at: null });

    // lưu trữ cửa hàng ↔ kích hoạt máy (review TS C1, xác định): một kết nối giữ stores FOR NO KEY UPDATE (như lần lưu trữ
    // đang chạy) ⇒ kích hoạt phải CHỜ khóa cửa hàng; lưu trữ commit ⇒ kích hoạt đọc lại thấy đã lưu trữ ⇒ 409, máy vẫn PENDING
    const st = await newStore();
    const dev = await e.pendingDevice(st.id);
    const c = new Client({ connectionString: e.db.ownerUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT 1 FROM core.stores WHERE id = $1 FOR NO KEY UPDATE', [st.id]);
      // supertest chỉ gửi khi .then() ⇒ gọi ngay để request chạy trong lúc kết nối kia giữ khóa
      const pending = e.master
        .post(`/admin/pos-devices/${dev.id}/activate`, { pairing_code: dev.pairingCode })
        .then((r) => r);
      let waited = false;
      for (let i = 0; i < 100 && !waited; i++) {
        const [w] = await e.db.q(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND usename = 'app_rw'`,
        );
        waited = (w?.n as number) > 0;
        if (!waited) await new Promise((r) => setTimeout(r, 50));
      }
      if (!waited) {
        await c.query('ROLLBACK');
        const r = await pending;
        throw new Error(`không chờ khóa: ${r.status} ${JSON.stringify(r.body)}`);
      }
      await c.query(`UPDATE core.stores SET archived_at = now(), status = 'INACTIVE' WHERE id = $1`, [st.id]);
      await c.query('COMMIT');
      expect(err(await pending)).toEqual([409, 'INVALID_STATE_TRANSITION']);
    } finally {
      await c.end();
    }
    const [d] = await e.db.q(`SELECT status::text FROM core.pos_devices WHERE id = $1`, [dev.id]);
    expect(d?.status).toBe('PENDING');
  });

  it('phạm vi cửa hàng: cửa hàng trưởng chỉ thấy / sửa cửa hàng mình; tạo / lưu trữ cần phạm vi toàn chuỗi', async () => {
    const other = await newStore();
    const sm = await e.storeManager();
    const l = await sm.get('/admin/stores');
    expect(l.status).toBe(200);
    expect((l.body.items as { id: string }[]).map((x) => x.id)).toEqual([sm.storeId]);
    expect(err(await sm.get(`/admin/stores/${other.id}`))).toEqual([404, 'RESOURCE_NOT_FOUND']);
    expect((await sm.get(`/admin/stores/${sm.storeId}`)).status).toBe(200);
    // không có store:write
    expect(err(await sm.patch(`/admin/stores/${sm.storeId}`, { pos_status: 'OPEN' }))).toEqual([
      403,
      'ACTION_FORBIDDEN',
    ]);
    expect(err(await sm.get(`/admin/locations?store_id=${other.id}`))).toEqual([404, 'RESOURCE_NOT_FOUND']);
    expect((await sm.get(`/admin/locations?store_id=${sm.storeId}`)).status).toBe(200);
    expect(err(await sm.get(`/admin/stores/${other.id}/registers`))).toEqual([404, 'RESOURCE_NOT_FOUND']);

    // cấp riêng store:write phạm vi cửa hàng mình
    const sw = await e.storeManager({ grants: ['store:write'] });
    const open = await sw.patch(`/admin/stores/${sw.storeId}`, { pos_status: 'OPEN' });
    expect(open.status).toBe(200);
    expect(open.body.pos_status).toBe('OPEN');
    expect(err(await sw.patch(`/admin/stores/${other.id}`, { pos_status: 'OPEN' }))).toEqual([
      404,
      'RESOURCE_NOT_FOUND',
    ]);
    expect(err(await sw.patch(`/admin/stores/${sw.storeId}`, { archived: true }))).toEqual([403, 'ACTION_FORBIDDEN']);
    // tên / địa chỉ / tọa độ: chỉ phạm vi toàn chuỗi (review bảo mật N2); giờ mở / năng lực: được
    for (const body of [{ name: 'Đổi tên' }, { address: 'x' }, { lat: 10, lng: 106 }])
      expect(err(await sw.patch(`/admin/stores/${sw.storeId}`, body))).toEqual([403, 'ACTION_FORBIDDEN']);
    expect(
      (
        await sw.patch(`/admin/stores/${sw.storeId}`, {
          opening_hours: { mon: [['07:00', '21:00']] },
          app_capacity_per_hour: 10,
        })
      ).status,
    ).toBe(200);
    expect(err(await sw.patch(`/admin/stores/${sw.storeId}`, { status: 'INACTIVE' }))).toEqual([
      403,
      'ACTION_FORBIDDEN',
    ]);
    expect(err(await sw.post('/admin/stores', { code: `x${e.hex()}`, name: 'x' }))).toEqual([403, 'ACTION_FORBIDDEN']);
    expect((await sw.post(`/admin/stores/${sw.storeId}/registers`, { code: 'Q9' })).status).toBe(201);
    expect(err(await sw.post(`/admin/stores/${other.id}/registers`, { code: 'Q9' }))).toEqual([
      404,
      'RESOURCE_NOT_FOUND',
    ]);
    const wh = await e.master.post('/admin/warehouses', { code: `w${e.hex()}`, name: 'Kho' });
    expect(
      err(
        await sw.post('/admin/locations', { warehouse_id: wh.body.id as string, type: 'SHELF', code: 'A', name: 'A' }),
      ),
    ).toEqual([403, 'ACTION_FORBIDDEN']);
    expect(err(await sw.post('/admin/warehouses', { code: `w${e.hex()}`, name: 'Kho' }))).toEqual([
      403,
      'ACTION_FORBIDDEN',
    ]);
    // NCC: cửa hàng trưởng không có supplier:read
    expect(err(await sm.get('/admin/suppliers'))).toEqual([403, 'ACTION_FORBIDDEN']);
  });

  it('kho + vị trí: tự có IN_TRANSIT, không tạo / lưu trữ IN_TRANSIT, trùng mã, thứ tự lộ trình', async () => {
    const w = await e.master.post('/admin/warehouses', { code: `w${e.hex()}`, name: 'Kho tổng', address: 'KCN' });
    expect(w.status).toBe(201);
    expect(schemaErrors('Warehouse', w.body)).toEqual([]);
    const wid = w.body.id as string;
    const locs = await e.master.get(`/admin/locations?warehouse_id=${wid}`);
    expect(locs.body.items).toHaveLength(1);
    const transit = (locs.body.items as { id: string; type: string }[])[0];
    expect(transit?.type).toBe('IN_TRANSIT');
    expect(err(await e.master.patch(`/admin/locations/${transit?.id as string}`, { archived: true }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    expect(
      (await e.master.post('/admin/locations', { warehouse_id: wid, type: 'IN_TRANSIT', code: 'T2', name: 'x' }))
        .status,
    ).toBe(400);
    expect(
      (await e.master.post('/admin/locations', { warehouse_id: wid, type: 'SHELF', code: 'in_transit_2', name: 'x' }))
        .status,
    ).toBe(400);
    expect(
      (
        await e.master.post('/admin/locations', {
          warehouse_id: wid,
          store_id: wid,
          type: 'SHELF',
          code: 'X',
          name: 'x',
        })
      ).status,
    ).toBe(400);
    const b = await e.master.post('/admin/locations', {
      warehouse_id: wid,
      type: 'COLD_ROOM',
      code: 'b',
      name: 'Lạnh',
      sort: 20,
    });
    expect(b.status).toBe(201);
    expect(schemaErrors('Location', b.body)).toEqual([]);
    expect(b.body.code).toBe('B');
    await e.master.post('/admin/locations', { warehouse_id: wid, type: 'SHELF', code: 'A', name: 'Kệ A', sort: 10 });
    expect(
      err(await e.master.post('/admin/locations', { warehouse_id: wid, type: 'SHELF', code: 'A', name: 'trùng' })),
    ).toEqual([409, 'VERSION_CONFLICT']);
    const ordered = await e.master.get(`/admin/locations?warehouse_id=${wid}`);
    expect((ordered.body.items as { code: string }[]).map((x) => x.code)).toEqual(['IN_TRANSIT', 'A', 'B']);
    const cold = await e.master.get(`/admin/locations?warehouse_id=${wid}&type=COLD_ROOM`);
    expect((cold.body.items as { code: string }[]).map((x) => x.code)).toEqual(['B']);
    expect((await e.master.get(`/admin/locations`)).status).toBe(400);
    const arch = await e.master.patch(`/admin/warehouses/${wid}`, { archived: true });
    expect(arch.status).toBe(200);
    expect(
      err(await e.master.post('/admin/locations', { warehouse_id: wid, type: 'SHELF', code: 'C', name: 'x' })),
    ).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    expect(schemaErrors('WarehouseList', (await e.master.get('/admin/warehouses?include_archived=true')).body)).toEqual(
      [],
    );
  });

  it('vị trí mặc định theo SKU: đúng cửa hàng, đang dùng, không phải IN_TRANSIT; chặn lưu trữ vị trí đang dùng', async () => {
    const s = await newStore();
    const s2 = await newStore();
    const sku = await newSku();
    const sku2 = await newSku();
    const mk = async (store: string, code: string, sort: number) => {
      const r = await e.master.post('/admin/locations', {
        store_id: store,
        type: 'SHELF',
        code,
        name: `Kệ ${code}`,
        sort,
      });
      expect(r.status).toBe(201);
      return r.body.id as string;
    };
    const k2 = await mk(s.id, 'K2', 2);
    const k1 = await mk(s.id, 'K1', 1);
    const foreign = await mk(s2.id, 'K1', 1);
    const [transit] = await e.db.q(`SELECT id::text FROM core.locations WHERE store_id = $1 AND type = 'IN_TRANSIT'`, [
      s.id,
    ]);
    const put = (skuId: string, location_id: string | null) =>
      e.master.put(`/admin/stores/${s.id}/default-locations/${skuId}`, { location_id });

    const r = await put(sku.id, k2);
    expect(r.status).toBe(200);
    expect(schemaErrors('SkuDefaultLocationResult', r.body)).toEqual([]);
    expect((await put(sku2.id, k1)).status).toBe(200);
    expect((await put(sku.id, k1)).status).toBe(200); // đổi vị trí
    expect((await put(sku.id, k2)).status).toBe(200);
    const l = await e.master.get(`/admin/stores/${s.id}/default-locations`);
    expect(schemaErrors('SkuDefaultLocationList', l.body)).toEqual([]);
    // lộ trình: K1 (sort 1) trước K2
    expect((l.body.items as { sku_id: string }[]).map((x) => x.sku_id)).toEqual([sku2.id, sku.id]);
    expect(err(await put(sku.id, foreign))).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    expect(err(await put(sku.id, transit?.id as string))).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    expect(err(await e.master.put(`/admin/stores/${s.id}/default-locations/${s.id}`, { location_id: k1 }))).toEqual([
      404,
      'RESOURCE_NOT_FOUND',
    ]);
    // vị trí đang là mặc định ⇒ không lưu trữ
    const a = await e.master.patch(`/admin/locations/${k2}`, { archived: true });
    expect(err(a)).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    expect((a.body as { details: { sku_defaults: number } }).details.sku_defaults).toBe(1);
    expect((await put(sku.id, null)).status).toBe(200);
    expect(err(await put(sku.id, null))).toEqual([404, 'RESOURCE_NOT_FOUND']);
    expect((await e.master.patch(`/admin/locations/${k2}`, { archived: true })).status).toBe(200);
    expect(err(await put(sku.id, k2))).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    const [au] = await e.db.q(
      `SELECT before, after FROM audit.logs WHERE action = 'sku_default_location.set' AND resource_id = $1
       ORDER BY at DESC, id DESC LIMIT 1`,
      [`${s.id}:${sku.id}`],
    );
    expect(au?.after).toMatchObject({ location_id: null });
    expect(au?.before).toMatchObject({ location_id: k2 });
  });

  it('quầy: tạo, trùng mã, lưu trữ khi còn máy POS ACTIVE ⇒ 422, không kích hoạt máy vào quầy đã lưu trữ', async () => {
    const sm = await e.storeManager();
    const r = await e.master.post(`/admin/stores/${sm.storeId}/registers`, { code: 'q1', name: 'Quầy 1' });
    expect(r.status).toBe(201);
    expect(schemaErrors('Register', r.body)).toEqual([]);
    expect(r.body.code).toBe('Q1');
    const rid = r.body.id as string;
    expect(err(await e.master.post(`/admin/stores/${sm.storeId}/registers`, { code: 'Q1' }))).toEqual([
      409,
      'VERSION_CONFLICT',
    ]);
    await e.db.q(`UPDATE core.pos_devices SET register_id = $1 WHERE store_id = $2`, [rid, sm.storeId]);
    const a = await e.master.patch(`/admin/registers/${rid}`, { archived: true });
    expect(err(a)).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    await e.db.q(`UPDATE core.pos_devices SET register_id = NULL WHERE store_id = $1`, [sm.storeId]);
    const ok = await e.master.patch(`/admin/registers/${rid}`, { archived: true, name: 'Quầy cũ' });
    expect(ok.status).toBe(200);
    expect(ok.body.archived_at).not.toBeNull();
    const list = await e.master.get(`/admin/stores/${sm.storeId}/registers?include_archived=true`);
    expect(schemaErrors('RegisterList', list.body)).toEqual([]);
    expect((await e.master.get(`/admin/stores/${sm.storeId}/registers`)).body.items).toEqual([]);
    // máy mới (PENDING) kích hoạt vào quầy đã lưu trữ ⇒ 400 field register_id; quầy đang dùng ⇒ 200
    const dev = await e.pendingDevice(sm.storeId);
    const bad = await e.master.post(`/admin/pos-devices/${dev.id}/activate`, {
      pairing_code: dev.pairingCode,
      register_id: rid,
    });
    expect(err(bad)).toEqual([400, 'INVALID_REQUEST']);
    expect((bad.body as { details: { field: string } }).details.field).toBe('register_id');
    const r2 = await e.master.post(`/admin/stores/${sm.storeId}/registers`, { code: 'Q2' });
    const good = await e.master.post(`/admin/pos-devices/${dev.id}/activate`, {
      pairing_code: dev.pairingCode,
      register_id: r2.body.id as string,
    });
    expect(good.status).toBe(200);
  });

  it('NCC: SĐT + tài khoản mã hóa, che khi đọc, không lộ trong audit; tìm theo SĐT; xem đủ tài khoản cần step-up', async () => {
    const c = await e.master.post('/admin/suppliers', {
      code: `ncc-${e.hex()}`,
      name: 'Vườn Cam Hà Giang',
      type: 'FARM',
      contact_name: 'Anh Tư',
      note: 'gọi số phụ 0987 111 222, STK cũ 1903 5555 7777',
      phone: '0912 345 678',
      bank_name: 'Vietcombank',
      bank_account: { account_number: '0071-0003-45678', account_holder: 'nguyen van tu' },
      payment_terms_days: 15,
    });
    expect(c.status).toBe(201);
    expect(schemaErrors('Supplier', c.body)).toEqual([]);
    expect(c.body).toMatchObject({
      phone: '+84912345678',
      phone_masked: '+84••••••678',
      bank_account_masked: '••••5678',
      bank_name: 'Vietcombank',
    });
    expect(JSON.stringify(c.body)).not.toContain('0071000345678');
    const id = c.body.id as string;

    const [row] = await e.db.q(
      `SELECT phone_enc, phone_hash, bank_enc, octet_length(phone_hash) AS hl FROM core.suppliers WHERE id = $1`,
      [id],
    );
    expect(row?.hl).toBe(32);
    for (const col of ['phone_enc', 'bank_enc']) {
      const raw = (row?.[col] as Buffer).toString('latin1');
      expect(raw).not.toContain('912345678');
      expect(raw).not.toContain('0071000345678');
      expect(raw).not.toContain('NGUYEN');
    }
    // danh sách: SĐT che; tìm theo SĐT (hash) / tên
    const byPhone = await e.master.get(`/admin/suppliers?q=${encodeURIComponent('+84 912 345 678')}`);
    expect(schemaErrors('SupplierList', byPhone.body)).toEqual([]);
    expect(byPhone.body.items).toEqual([expect.objectContaining({ id, phone: null, phone_masked: '+84••••••678' })]);
    const byName = await e.master.get(`/admin/suppliers?q=${encodeURIComponent('cam hà')}`);
    expect((byName.body.items as { id: string }[]).map((x) => x.id)).toContain(id);
    expect((await e.master.get(`/admin/suppliers?q=${encodeURIComponent('%')}`)).body.items).toEqual([]);

    expect(
      (await e.master.post('/admin/suppliers', { code: `x${e.hex()}`, name: 'x', type: 'FARM', phone: '12345' }))
        .status,
    ).toBe(400);
    expect(
      (
        await e.master.post('/admin/suppliers', {
          code: `x${e.hex()}`,
          name: 'x',
          type: 'FARM',
          bank_account: { account_number: '12ab', account_holder: 'A' },
        })
      ).status,
    ).toBe(400);

    // xem đủ tài khoản: Master + step-up
    expect(err(await e.master.post(`/admin/suppliers/${id}/bank-account/reveal`, {}))).toEqual([
      403,
      'STEP_UP_REQUIRED',
    ]);
    const su = await e.masterStepUp();
    const rv = await su.post(`/admin/suppliers/${id}/bank-account/reveal`, {});
    expect(rv.status).toBe(200);
    expect(schemaErrors('SupplierBankAccount', rv.body)).toEqual([]);
    expect(rv.body).toMatchObject({ account_number: '0071000345678', account_holder: 'NGUYEN VAN TU' });

    const u = await e.master.patch(`/admin/suppliers/${id}`, { phone: '028 3822 1234', bank_account: null });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ phone: '+842838221234', bank_account_masked: null });
    expect(err(await su.post(`/admin/suppliers/${id}/bank-account/reveal`, {}))).toEqual([404, 'RESOURCE_NOT_FOUND']);

    // audit: không SĐT / số tài khoản / chủ tài khoản ở bất kỳ đâu trong dòng nhật ký
    const logs = await audits(id);
    expect(logs.map((x) => x.action)).toEqual(['supplier.create', 'supplier.bank_reveal', 'supplier.update']);
    const text = JSON.stringify(logs);
    for (const leak of [
      '912345678',
      '0912',
      '38221234',
      '0071000345678',
      '45678',
      'NGUYEN',
      'nguyen',
      'Anh Tư',
      '0987',
      '1903',
    ])
      expect(text).not.toContain(leak);
    expect(logs[0]?.after).toMatchObject({ changed_pii: ['phone', 'bank_account', 'contact_name', 'note'] });
    expect(logs[2]?.after).toMatchObject({ changed_pii: ['phone', 'bank_account'] });

    // '+84 (0) 912…' chuẩn hóa được; tài khoản ngắn chỉ lộ 2 số cuối
    const p2 = await e.master.patch(`/admin/suppliers/${id}`, {
      phone: '+84 (0) 912 345 678',
      bank_account: { account_number: '123456', account_holder: 'A' },
    });
    expect(p2.body).toMatchObject({ phone: '+84912345678', bank_account_masked: '••••56' });
    // không có supplier:write (chỉ supplier:read) ⇒ không thấy tên NH / số che
    const rd = await e.storeManager({ grants: ['supplier:read'] });
    const g = await rd.get(`/admin/suppliers/${id}`);
    expect(g.status).toBe(200);
    expect(schemaErrors('Supplier', g.body)).toEqual([]);
    expect(g.body).toMatchObject({ phone: '+84912345678', bank_name: null, bank_account_masked: null });
    expect(err(await rd.patch(`/admin/suppliers/${id}`, { name: 'x' }))).toEqual([403, 'ACTION_FORBIDDEN']);
  });

  it('NCC: phân trang theo mã, kết hợp lọc q / type — không trùng, không sót', async () => {
    const tag = `PG${e.hex()}`;
    const codes = ['A', 'B', 'C', 'D'].map((x) => `${tag}-${x}`);
    for (const [i, code] of codes.entries())
      expect(
        (await e.master.post('/admin/suppliers', { code, name: `NCC ${tag} ${i}`, type: i === 2 ? 'FARM' : 'OTHER' }))
          .status,
      ).toBe(201);
    const walk = async (extra: string) => {
      const seen: string[] = [];
      let after: string | null = null;
      for (let n = 0; n < 10; n++) {
        const r = await e.master.get(
          `/admin/suppliers?q=${tag}&limit=1${extra}${after ? `&after=${encodeURIComponent(after)}` : ''}`,
        );
        expect(r.status).toBe(200);
        seen.push(...(r.body.items as { code: string }[]).map((x) => x.code));
        after = r.body.next_after as string | null;
        if (!after) break;
      }
      return seen;
    };
    expect(await walk('')).toEqual(codes);
    expect(await walk('&type=OTHER')).toEqual([codes[0], codes[1], codes[3]]);
  });

  it('NCC: SKU cung cấp — thêm / sửa mã phía NCC / bỏ; SKU hoặc NCC lưu trữ ⇒ 422', async () => {
    const c = await e.master.post('/admin/suppliers', {
      code: `n${e.hex()}`,
      name: 'Đầu mối Long Biên',
      type: 'WHOLESALER',
    });
    const id = c.body.id as string;
    const sku = await newSku();
    const put = (skuId: string, supplier_sku_code: string | null) =>
      e.master.put(`/admin/suppliers/${id}/skus/${skuId}`, { supplier_sku_code });
    const a = await put(sku.id, 'CAM-01');
    expect(a.status).toBe(200);
    expect(schemaErrors('SupplierSkuLink', a.body)).toEqual([]);
    expect((await put(sku.id, 'CAM-02')).body.supplier_sku_code).toBe('CAM-02');
    const l = await e.master.get(`/admin/suppliers/${id}/skus`);
    expect(schemaErrors('SupplierSkuList', l.body)).toEqual([]);
    expect(l.body.items).toEqual([expect.objectContaining({ sku_id: sku.id, supplier_sku_code: 'CAM-02' })]);
    const d = await e.master.delete(`/admin/suppliers/${id}/skus/${sku.id}`);
    expect(d.status).toBe(200);
    expect(schemaErrors('SupplierSkuRemoved', d.body)).toEqual([]);
    expect(err(await e.master.delete(`/admin/suppliers/${id}/skus/${sku.id}`))).toEqual([404, 'RESOURCE_NOT_FOUND']);
    expect(err(await put(id, null))).toEqual([404, 'RESOURCE_NOT_FOUND']);

    const old = await newSku();
    await e.master.patch(`/admin/skus/${old.id}`, { version: old.version, archived: true });
    expect(err(await put(old.id, null))).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    await e.master.patch(`/admin/suppliers/${id}`, { archived: true });
    expect(err(await put(sku.id, null))).toEqual([422, 'CATALOG_RULE_VIOLATION']);
  });

  it('thứ tự khóa: lô đổi giá (stores FOR SHARE) chạy song song với sửa cửa hàng — không deadlock', async () => {
    const s = await newStore();
    const skus = await Promise.all([newSku(), newSku(), newSku()]);
    const su = await e.masterStepUp();
    const rounds = Array.from({ length: 4 }, async (_, i) => {
      const cur = await Promise.all(skus.map((k) => e.master.get(`/admin/prices/${k.id}`)));
      return Promise.all([
        su.put('/admin/prices', {
          reason: `đợt ${i}`,
          items: skus.map((k, j) => ({
            sku_id: k.id,
            version: cur[j]?.body.version as number,
            stores: [{ store_id: s.id, price: `${10000 + i}` }],
          })),
        }),
        e.master.patch(`/admin/stores/${s.id}`, { name: `CH đợt ${i}` }),
      ]);
    });
    const res = (await Promise.all(rounds)).flat();
    for (const r of res) {
      // 409 = version giá lệch giữa các đợt song song; deadlock (40P01) cũng ra 409 nhưng reason RETRY ⇒ phải không có
      expect([200, 409]).toContain(r.status);
      expect((r.body as { details?: { reason?: string } }).details?.reason).not.toBe('RETRY');
    }
    expect(res.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(4);
  });
});
