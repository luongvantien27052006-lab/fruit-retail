import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schemaErrors } from './helpers/contract';
import { type AdminEnv, startAdminEnv } from './helpers/admin-env';

// CP04 lát 3 — giá lẻ chung / theo cửa hàng / theo đơn vị, lịch sử giá, giá hiệu lực tại thời điểm (PostgreSQL + Redis thật).
// Cổng: đổi giá chỉ áp cho giao dịch mới; lịch sử đủ người / thời điểm; giá âm / 0 ⇒ 422; tiền chỉ chuỗi số nguyên (BIGINT).

describe('API giá (CP04 lát 3)', () => {
  let e: AdminEnv;
  const err = (r: { status: number; body: { code?: string } }) => [r.status, r.body.code];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    e = await startAdminEnv();
  });
  afterAll(async () => {
    await e?.close();
  });

  async function sku(body: Record<string, unknown> = {}) {
    const c = await e.master.post('/admin/categories', { name: `DM ${e.hex()}` });
    const p = await e.master.post('/admin/products', { category_id: c.body.id as string, name: `SP ${e.hex()}` });
    const r = await e.master.post('/admin/skus', {
      product_id: p.body.id as string,
      sku_code: `P-${e.hex()}`,
      name: `SKU ${e.hex()}`,
      sale_unit_type: 'WEIGHT',
      ...body,
    });
    expect(r.status).toBe(201);
    return r.body as { id: string; version: number; units: { id: string; unit_code: string }[] };
  }
  async function store(archived = false) {
    const id = randomUUID();
    const code = `S${e.hex()}`;
    await e.db.q(
      `INSERT INTO core.stores (id, code, name, archived_at) VALUES ($1, $2, $2, ${archived ? 'now()' : 'NULL'})`,
      [id, code],
    );
    return id;
  }
  const logs = (skuId: string) =>
    e.db.q(
      `SELECT field, store_id::text, sku_unit_id::text, old_value::text, new_value::text, reason, changed_by::text, changed_at
       FROM core.price_change_logs WHERE sku_id = $1 ORDER BY changed_at, id`,
      [skuId],
    );

  it('cổng: đổi giá chỉ áp cho giao dịch mới — giá hiệu lực tại thời điểm dựng lại từ lịch sử; lịch sử đủ ai / khi nào / cũ → mới / lý do', async () => {
    const s = await sku();
    const t0 = new Date();
    await sleep(5);
    const r1 = await e.master.put(`/admin/prices/${s.id}`, { version: 0, global: '95000', reason: 'Giá mở bán' });
    expect(r1.status).toBe(200);
    expect(schemaErrors('SkuPrices', r1.body)).toEqual([]);
    expect(r1.body).toMatchObject({ price_field: 'PER_KG', global: '95000', version: 1 });
    await sleep(5);
    const tMid = new Date();
    await sleep(5);
    const r2 = await e.master.put(`/admin/prices/${s.id}`, { version: 1, global: '99000', reason: 'Giá nhập tăng' });
    expect(r2.body).toMatchObject({ global: '99000', version: 2 });

    // giá tại các thời điểm: trước lần đặt đầu ⇒ chưa có; giữa hai lần ⇒ giá cũ; bây giờ ⇒ giá mới
    const at = async (d?: Date) => {
      const r = await e.master.get(
        `/admin/prices/${s.id}/effective${d ? `?at=${encodeURIComponent(d.toISOString())}` : ''}`,
      );
      expect(r.status).toBe(200);
      expect(schemaErrors('EffectivePrice', r.body)).toEqual([]);
      return r.body as { source: string; price: string | null };
    };
    expect(await at(t0)).toMatchObject({ source: 'NONE', price: null });
    expect(await at(tMid)).toMatchObject({ source: 'GLOBAL', price: '95000' });
    expect(await at()).toMatchObject({ source: 'GLOBAL', price: '99000' });

    // lịch sử: chuỗi liền, người đổi = Master, mốc server tăng dần, lý do
    const h = await e.master.get(`/admin/prices/${s.id}/history`);
    expect(h.status).toBe(200);
    expect(schemaErrors('PriceHistory', h.body)).toEqual([]);
    expect(
      h.body.items.map((x: { old_value: string | null; new_value: string; reason: string }) => [
        x.old_value,
        x.new_value,
        x.reason,
      ]),
    ).toEqual([
      ['95000', '99000', 'Giá nhập tăng'],
      [null, '95000', 'Giá mở bán'],
    ]);
    const db = await logs(s.id);
    expect(db.every((l) => l.changed_by === e.masterId)).toBe(true);
    expect((db[0]?.changed_at as Date).getTime()).toBeLessThan((db[1]?.changed_at as Date).getTime());
    expect((db[0]?.changed_at as Date).getTime()).toBeLessThanOrEqual(tMid.getTime());
    // audit cùng transaction
    const [a] = await e.db.q(
      `SELECT action, reason FROM audit.logs WHERE resource_id = $1 AND action = 'price.set' ORDER BY at DESC LIMIT 1`,
      [s.id],
    );
    expect(a).toEqual({ action: 'price.set', reason: 'Giá nhập tăng' });
    // phân trang lịch sử
    const p1 = await e.master.get(`/admin/prices/${s.id}/history?limit=1`);
    expect(p1.body.items).toHaveLength(1);
    const p2 = await e.master.get(`/admin/prices/${s.id}/history?limit=1&before=${p1.body.next_before as string}`);
    expect(p2.body.items.map((x: { new_value: string }) => x.new_value)).toEqual(['95000']);
    expect(p2.body.next_before).toBeNull();
  });

  it('giá cửa hàng: ghi đè giá chung chỉ ở cửa hàng đó; bỏ giá riêng (null) ⇒ về giá chung, lịch sử giữ giá cũ', async () => {
    const s = await sku({ sale_unit_type: 'PIECE_FIXED' });
    const [a, b] = [await store(), await store()];
    const r = await e.master.put(`/admin/prices/${s.id}`, {
      version: 0,
      reason: 'Giá ban đầu',
      global: '25000',
      stores: [{ store_id: a, price: '23000' }],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      price_field: 'PER_UNIT',
      global: '25000',
      stores: [{ store_id: a, price: '23000' }],
    });
    const eff = async (storeId: string, d?: Date) =>
      (
        await e.master.get(
          `/admin/prices/${s.id}/effective?store_id=${storeId}${d ? `&at=${encodeURIComponent(d.toISOString())}` : ''}`,
        )
      ).body as { source: string; price: string };
    expect(await eff(a)).toMatchObject({ source: 'STORE', price: '23000' });
    expect(await eff(b)).toMatchObject({ source: 'GLOBAL', price: '25000' });
    await sleep(5);
    const before = new Date();
    await sleep(5);
    const off = await e.master.put(`/admin/prices/${s.id}`, {
      version: 1,
      reason: 'Bỏ giá riêng',
      stores: [{ store_id: a, price: null }],
    });
    expect(off.body).toMatchObject({ version: 2, stores: [] });
    expect((await e.db.q(`SELECT 1 FROM core.store_prices WHERE sku_id = $1`, [s.id])).length).toBe(0);
    expect(await eff(a)).toMatchObject({ source: 'GLOBAL', price: '25000' });
    expect(await eff(a, before)).toMatchObject({ source: 'STORE', price: '23000' });
    const l = await logs(s.id);
    expect(l.map((x) => [x.field, x.store_id, x.old_value, x.new_value])).toEqual([
      ['PER_UNIT', null, null, '25000'],
      ['PER_UNIT', a, null, '23000'],
      ['PER_UNIT', a, '23000', null],
    ]);
    // cửa hàng lưu trữ / không tồn tại ⇒ 422
    expect(
      err(
        await e.master.put(`/admin/prices/${s.id}`, {
          version: 2,
          reason: 'x',
          stores: [{ store_id: await store(true), price: '1' }],
        }),
      ),
    ).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    expect(
      err(
        await e.master.put(`/admin/prices/${s.id}`, {
          version: 2,
          reason: 'x',
          stores: [{ store_id: randomUUID(), price: '1' }],
        }),
      ),
    ).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    expect(
      err(
        await e.master.put(`/admin/prices/${s.id}`, {
          version: 2,
          reason: 'x',
          stores: [
            { store_id: a, price: '1' },
            { store_id: a, price: '2' },
          ],
        }),
      ),
    ).toEqual([400, 'INVALID_REQUEST']);
  });

  it('giá đơn vị: hộp 500 g có giá riêng; đơn vị gốc / đơn vị không bán ⇒ 422; hỏi giá theo đơn vị', async () => {
    const s = await sku({
      units: [
        { unit_code: 'PACK', name: 'Hộp 500 g', factor_g: 500, for_sale: true, for_purchase: false },
        { unit_code: 'BOX', name: 'Thùng ~5 kg', is_variable: true, for_sale: false, for_purchase: true },
      ],
    });
    const [kg, pack, box] = s.units;
    const r = await e.master.put(`/admin/prices/${s.id}`, {
      version: 0,
      reason: 'Giá đầu',
      global: '320000',
      units: [{ sku_unit_id: pack?.id, price: '165000' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.units.find((u: { sku_unit_id: string }) => u.sku_unit_id === pack?.id)).toMatchObject({
      price: '165000',
    });
    const eff = (u: string) => e.master.get(`/admin/prices/${s.id}/effective?sku_unit_id=${u}`);
    expect((await eff(pack?.id ?? '')).body).toMatchObject({ source: 'SKU_UNIT', field: 'SKU_UNIT', price: '165000' });
    expect((await eff(kg?.id ?? '')).body).toMatchObject({ source: 'GLOBAL', field: 'PER_KG', price: '320000' });
    expect(
      err(
        await e.master.put(`/admin/prices/${s.id}`, {
          version: 1,
          reason: 'x',
          units: [{ sku_unit_id: kg?.id, price: '1000' }],
        }),
      ),
    ).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    expect(
      err(
        await e.master.put(`/admin/prices/${s.id}`, {
          version: 1,
          reason: 'x',
          units: [{ sku_unit_id: box?.id, price: '1000' }],
        }),
      ),
    ).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    expect(
      err(
        await e.master.put(`/admin/prices/${s.id}`, {
          version: 1,
          reason: 'x',
          units: [{ sku_unit_id: randomUUID(), price: '1000' }],
        }),
      ),
    ).toEqual([404, 'RESOURCE_NOT_FOUND']);
    // bỏ "để bán" khi đơn vị có giá riêng ⇒ 422 (API danh mục); bỏ giá riêng trước
    expect(err(await e.master.patch(`/admin/skus/${s.id}/units/${pack?.id ?? ''}`, { for_sale: false }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    const off = await e.master.put(`/admin/prices/${s.id}`, {
      version: 1,
      reason: 'Bỏ giá hộp',
      units: [{ sku_unit_id: pack?.id, price: null }],
    });
    expect(off.status).toBe(200);
    expect((await eff(pack?.id ?? '')).body).toMatchObject({ source: 'GLOBAL', price: '320000' });
    // hàng đếm: đơn vị gốc (1 quả) không có giá riêng
    const c = await sku({ sale_unit_type: 'PIECE_FIXED' });
    expect(
      err(
        await e.master.put(`/admin/prices/${c.id}`, {
          version: 0,
          reason: 'x',
          units: [{ sku_unit_id: c.units[0]?.id, price: '1000' }],
        }),
      ),
    ).toEqual([422, 'CATALOG_RULE_VIOLATION']);
  });

  it('kiểm dữ liệu: giá âm / 0 / quá trần ⇒ 422; số JSON (không phải chuỗi) ⇒ 400; version lệch ⇒ 409; SKU lưu trữ ⇒ 422; không đổi ⇒ không ghi lịch sử', async () => {
    const s = await sku();
    for (const v of ['0', '-1', '1000000001', '999999999999999999'])
      expect([v, ...err(await e.master.put(`/admin/prices/${s.id}`, { version: 0, reason: 'x', global: v }))]).toEqual([
        v,
        422,
        'CATALOG_RULE_VIOLATION',
      ]);
    for (const v of [95000, '95000.5', '1e5', ' 95000'])
      expect([v, ...err(await e.master.put(`/admin/prices/${s.id}`, { version: 0, reason: 'x', global: v }))]).toEqual([
        v,
        400,
        'INVALID_REQUEST',
      ]);
    expect(err(await e.master.put(`/admin/prices/${s.id}`, { version: 0, global: '1000' }))).toEqual([
      400,
      'INVALID_REQUEST',
    ]);
    expect(err(await e.master.put(`/admin/prices/${s.id}`, { version: 0, reason: '  ', global: '1000' }))).toEqual([
      400,
      'INVALID_REQUEST',
    ]);
    expect(err(await e.master.put(`/admin/prices/${s.id}`, { version: 7, reason: 'x', global: '1000' }))).toEqual([
      409,
      'VERSION_CONFLICT',
    ]);
    expect(
      err(await e.master.put(`/admin/prices/${randomUUID()}`, { version: 0, reason: 'x', global: '1000' })),
    ).toEqual([404, 'RESOURCE_NOT_FOUND']);
    expect((await logs(s.id)).length).toBe(0);
    // giá chung bằng giá cũ ⇒ không ghi lịch sử, không tăng version
    expect(
      (await e.master.put(`/admin/prices/${s.id}`, { version: 0, reason: 'x', global: '1000' })).body.version,
    ).toBe(1);
    const same = await e.master.put(`/admin/prices/${s.id}`, { version: 1, reason: 'lặp', global: '1000' });
    expect(same.body.version).toBe(1);
    expect((await logs(s.id)).length).toBe(1);
    // API danh mục không đổi được giá; giá không sửa qua PATCH SKU
    expect(err(await e.master.patch(`/admin/skus/${s.id}`, { version: 1, retail_price_per_kg: '5' }))).toEqual([
      400,
      'INVALID_REQUEST',
    ]);
    // SKU lưu trữ ⇒ không đổi giá
    await e.master.patch(`/admin/skus/${s.id}`, { version: 1, archived: true });
    expect(err(await e.master.put(`/admin/prices/${s.id}`, { version: 2, reason: 'x', global: '2000' }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
  });

  it('đổi giá hàng loạt: cần step-up; một dòng lỗi ⇒ cả lô rollback; trùng SKU ⇒ 400', async () => {
    const a = await sku();
    const b = await sku({ sale_unit_type: 'PIECE_FIXED' });
    const body = {
      reason: 'Điều chỉnh tuần',
      items: [
        { sku_id: a.id, version: 0, global: '50000' },
        { sku_id: b.id, version: 0, global: '12000' },
      ],
    };
    expect(err(await e.master.put('/admin/prices', body))).toEqual([403, 'STEP_UP_REQUIRED']);
    const su = await e.masterStepUp();
    // dòng lỗi là SKU có id LỚN hơn (xử lý sau) ⇒ chứng minh dòng đã ghi trước đó bị rollback
    const [lo, hi] = [a.id, b.id].sort();
    const bad = await su.put('/admin/prices', {
      ...body,
      items: body.items.map((i) => (i.sku_id === hi ? { ...i, version: 9 } : i)),
    });
    expect(err(bad)).toEqual([409, 'VERSION_CONFLICT']);
    expect((await logs(lo ?? '')).length).toBe(0);
    expect((await logs(hi ?? '')).length).toBe(0);
    expect(err(await su.put('/admin/prices', { ...body, items: [body.items[0], body.items[0]] }))).toEqual([
      400,
      'INVALID_REQUEST',
    ]);
    const ok = await su.put('/admin/prices', body);
    expect(ok.status).toBe(200);
    expect(schemaErrors('PriceBulkResult', ok.body)).toEqual([]);
    expect(ok.body.items.map((x: { global: string; version: number }) => [x.global, x.version]).sort()).toEqual([
      ['12000', 1],
      ['50000', 1],
    ]);
    const [au] = await e.db.q(`SELECT after FROM audit.logs WHERE action = 'price.set_bulk' ORDER BY at DESC LIMIT 1`);
    expect(au?.after).toMatchObject({ skus: 2, changes: 2 });
  });

  it('quyền + phạm vi: chỉ Master đổi giá / xem lịch sử; cửa hàng trưởng chỉ thấy giá riêng cửa hàng mình (ngoài ⇒ 404)', async () => {
    const s = await sku({ sale_unit_type: 'PIECE_FIXED' });
    const sm = await e.storeManager();
    const other = await store();
    const set = await e.master.put(`/admin/prices/${s.id}`, {
      version: 0,
      reason: 'Ghi chú nội bộ',
      global: '25000',
      stores: [
        { store_id: sm.storeId.toUpperCase(), price: '24000' },
        { store_id: other, price: '23000' },
      ],
    });
    expect(set.status).toBe(200);
    // UUID viết hoa được chuẩn hóa (không báo "cửa hàng không tồn tại")
    expect(set.body.stores.map((x: { store_id: string }) => x.store_id).sort()).toEqual([sm.storeId, other].sort());
    const cur = await sm.get(`/admin/prices/${s.id}`);
    expect(cur.status).toBe(200);
    expect(schemaErrors('SkuPrices', cur.body)).toEqual([]);
    expect(cur.body.stores).toEqual([expect.objectContaining({ store_id: sm.storeId, price: '24000' })]);
    expect(JSON.stringify(cur.body)).not.toContain(e.masterId);
    expect((await sm.get(`/admin/prices/${s.id}/effective?store_id=${sm.storeId}`)).body).toMatchObject({
      source: 'STORE',
      price: '24000',
    });
    expect(err(await sm.get(`/admin/prices/${s.id}/effective?store_id=${other}`))).toEqual([404, 'RESOURCE_NOT_FOUND']);
    expect((await sm.get(`/admin/prices/${s.id}/effective`)).body).toMatchObject({ source: 'GLOBAL', price: '25000' });
    expect((await sm.get(`/admin/prices/${s.id}/history`)).status).toBe(403);
    expect((await sm.put(`/admin/prices/${s.id}`, { version: 1, reason: 'x', global: '1' })).status).toBe(403);
    // Master thấy mọi cửa hàng
    expect((await e.master.get(`/admin/prices/${s.id}`)).body.stores).toHaveLength(2);
    expect((await e.http().get(`/v1/admin/prices/${s.id}`)).status).toBe(401);
    // lý do có ký tự điều khiển (NUL) ⇒ 400, không 500
    expect(
      err(
        await e.master.put(`/admin/prices/${s.id}`, {
          version: 1,
          reason: `a${String.fromCharCode(0)}b`,
          global: '26000',
        }),
      ),
    ).toEqual([400, 'INVALID_REQUEST']);
  });

  it('lịch sử: phân trang không mất bản ghi khi nhiều mốc cùng mili-giây; lọc theo cửa hàng / loại giá; biên at = changed_at', async () => {
    const s = await sku({ sale_unit_type: 'PIECE_FIXED' });
    const stores = await Promise.all(Array.from({ length: 30 }, () => store()));
    const r = await e.master.put(`/admin/prices/${s.id}`, {
      version: 0,
      reason: 'Nạp giá',
      global: '10000',
      stores: stores.map((id, k) => ({ store_id: id, price: String(9000 + k) })),
    });
    expect(r.status).toBe(200);
    const seen: string[] = [];
    let before: string | null = null;
    for (let page = 0; page < 20; page++) {
      const h = await e.master.get(`/admin/prices/${s.id}/history?limit=3${before ? `&before=${before}` : ''}`);
      expect(schemaErrors('PriceHistory', h.body)).toEqual([]);
      seen.push(...h.body.items.map((x: { id: string }) => x.id));
      before = h.body.next_before as string | null;
      if (!before) break;
    }
    expect(seen).toHaveLength(31);
    expect(new Set(seen).size).toBe(31);
    // lọc
    const one = await e.master.get(`/admin/prices/${s.id}/history?store_id=${stores[3] ?? ''}`);
    expect(one.body.items.map((x: { new_value: string }) => x.new_value)).toEqual(['9003']);
    const glob = await e.master.get(`/admin/prices/${s.id}/history?field=PER_UNIT&limit=500`);
    expect(glob.body.items).toHaveLength(31);
    expect((await e.master.get(`/admin/prices/${s.id}/history?field=SKU_UNIT`)).body.items).toEqual([]);
    // biên: at đúng bằng changed_at (đủ micro-giây) ⇒ lần đổi đó đã có hiệu lực
    const g = (await e.master.get(`/admin/prices/${s.id}/history?limit=500`)).body.items.find(
      (x: { store_id: string | null }) => x.store_id === null,
    ) as { changed_at: string };
    expect(g.changed_at).toMatch(/\.\d{6}Z$/);
    const eff = await e.master.get(`/admin/prices/${s.id}/effective?at=${encodeURIComponent(g.changed_at)}`);
    expect(eff.body).toMatchObject({ source: 'GLOBAL', price: '10000', changed_at: g.changed_at });
    expect(err(await e.master.get(`/admin/prices/${s.id}/history?before=${randomUUID()}`))).toEqual([
      400,
      'INVALID_REQUEST',
    ]);
  });

  it('ưu tiên đơn vị → cửa hàng → chung; giá đơn vị hàng đếm; giá 0 / âm ở cửa hàng, đơn vị ⇒ 422; null = không đặt', async () => {
    const s = await sku({
      sale_unit_type: 'PACK_FIXED',
      std_weight_g: 250,
      units: [{ unit_code: 'BOX', name: 'Thùng 6 hộp', factor_units: 6, for_sale: true, for_purchase: true }],
    });
    const box = s.units[1]?.id ?? '';
    const st = await store();
    for (const bad of [
      { stores: [{ store_id: st, price: '0' }] },
      { stores: [{ store_id: st, price: '-5' }] },
      { units: [{ sku_unit_id: box, price: '0' }] },
      { units: [{ sku_unit_id: box, price: '1000000001' }] },
    ])
      expect(err(await e.master.put(`/admin/prices/${s.id}`, { version: 0, reason: 'x', ...bad }))).toEqual([
        422,
        'CATALOG_RULE_VIOLATION',
      ]);
    const r = await e.master.put(`/admin/prices/${s.id}`, {
      version: 0,
      reason: 'Giá đầu',
      global: '40000',
      stores: [{ store_id: st, price: '38000' }],
      units: [{ sku_unit_id: box, price: '220000' }],
    });
    expect(r.status).toBe(200);
    const q = (x: string) => e.master.get(`/admin/prices/${s.id}/effective?${x}`);
    expect((await q(`sku_unit_id=${box}&store_id=${st}`)).body).toMatchObject({ source: 'SKU_UNIT', price: '220000' });
    expect((await q(`sku_unit_id=${s.units[0]?.id ?? ''}&store_id=${st}`)).body).toMatchObject({
      source: 'STORE',
      price: '38000',
    });
    expect(err(await q(`store_id=${randomUUID()}`))).toEqual([404, 'RESOURCE_NOT_FOUND']);
    // client sinh mã (Dart) gửi null cho trường không đặt ⇒ không đổi gì
    const n = await e.master.put(`/admin/prices/${s.id}`, {
      version: 1,
      reason: 'x',
      global: null,
      stores: null,
      units: null,
    });
    expect(n.status).toBe(200);
    expect(n.body).toMatchObject({ version: 1, global: '40000' });
  });

  it('song song: 4 PUT cùng SKU cùng version ⇒ đúng một 200, còn lại 409; lịch sử liền một bản ghi', async () => {
    const s = await sku();
    const rs = await Promise.all(
      ['11000', '12000', '13000', '14000'].map((v) =>
        e.master.put(`/admin/prices/${s.id}`, { version: 0, reason: 'song song', global: v }),
      ),
    );
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect((await logs(s.id)).length).toBe(1);
  });
});
