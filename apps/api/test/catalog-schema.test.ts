import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMigratedDb, type MigratedDb } from './helpers/db';

// CP04 lát 1 — schema M04 (0009_catalog) trên PostgreSQL + PostGIS THẬT. Chạy bằng role ứng dụng app_rw (trừ phần
// chuẩn bị dữ liệu), để kiểm cả ràng buộc lẫn quyền theo cột.
const id = () => randomUUID();
const code = (p: string) => `${p}-${randomBytes(3).toString('hex').toUpperCase()}`;

describe('0009_catalog', () => {
  let db: MigratedDb;
  let app: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  let userId: string;
  let storeId: string;
  let productId: string;

  beforeAll(async () => {
    db = await startMigratedDb();
    app = (sql, params = []) => db.q(sql, params, db.roleUrl('app_rw'));
    userId = id();
    await db.q(`INSERT INTO core.users (id, type, email, password_hash) VALUES ($1, 'MASTER', $2, 'x')`, [
      userId,
      `m-${randomBytes(3).toString('hex')}@fruit.test`,
    ]);
    storeId = id();
    await app(`INSERT INTO core.stores (id, code, name) VALUES ($1, $2, 'CH')`, [storeId, code('CH')]);
    const cat = id();
    await app(`INSERT INTO core.categories (id, name) VALUES ($1, 'Quả nhập khẩu')`, [cat]);
    productId = id();
    await app(`INSERT INTO core.products (id, category_id, name) VALUES ($1, $2, 'Nho Mẫu Đơn')`, [productId, cat]);
  });
  afterAll(async () => {
    await db?.pg.stop();
  });

  /** Một transaction của app_rw (constraint trigger giá chỉ kiểm lúc COMMIT). */
  const tx = async <T>(fn: (q: (sql: string, params?: unknown[]) => Promise<unknown[]>) => Promise<T>): Promise<T> => {
    const c = new Client({ connectionString: db.roleUrl('app_rw') });
    await c.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(async (sql, params = []) => (await c.query(sql, params)).rows);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await c.end();
    }
  };
  type Q = (sql: string, params?: unknown[]) => Promise<unknown[]>;
  const insert = (q: Q, table: string, cols: Record<string, unknown>) => {
    const keys = Object.keys(cols);
    return q(
      `INSERT INTO core.${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(cols),
    );
  };
  const log = (
    q: Q,
    k: { sku: string; store?: string | null; field: string; unit?: string | null },
    oldV: number | null,
    newV: number | null,
  ) =>
    insert(q, 'price_change_logs', {
      id: id(),
      sku_id: k.sku,
      sku_unit_id: k.unit ?? null,
      store_id: k.store ?? null,
      scope: k.store ? 'STORE' : 'GLOBAL',
      field: k.field,
      old_value: oldV,
      new_value: newV,
      reason: 'test',
      changed_by: userId,
    });
  /** Tạo SKU như API sẽ làm: giá ban đầu ghi lịch sử (old NULL) trong cùng transaction. */
  const sku = async (type: string, extra: Record<string, unknown> = {}) => {
    const sid = id();
    await tx(async (q) => {
      await insert(q, 'skus', {
        id: sid,
        product_id: productId,
        sku_code: code('SKU'),
        name: 'SKU',
        sale_unit_type: type,
        ...extra,
      });
      if (extra['retail_price_per_kg'] != null)
        await log(q, { sku: sid, field: 'PER_KG' }, null, Number(extra['retail_price_per_kg']));
      if (extra['retail_price_per_unit'] != null)
        await log(q, { sku: sid, field: 'PER_UNIT' }, null, Number(extra['retail_price_per_unit']));
    });
    return sid;
  };
  const unit = async (skuId: string, extra: Record<string, unknown>) => {
    const uid = id();
    await tx(async (q) => {
      await insert(q, 'sku_units', { id: uid, sku_id: skuId, unit_code: 'KG', name: code('U'), ...extra });
      if (extra['price_per_unit'] != null)
        await log(q, { sku: skuId, field: 'SKU_UNIT', unit: uid }, null, Number(extra['price_per_unit']));
    });
    return uid;
  };

  it('seed: đơn vị, mã lý do Phụ lục D, quy tắc W1 bật, bì mẫu, đúng một dòng thương hiệu', async () => {
    const units = await db.q(`SELECT code FROM core.units ORDER BY code`);
    expect(units.map((u) => u.code)).toEqual(
      expect.arrayContaining(['KG', 'PIECE', 'PACK', 'BOX', 'CRATE', 'SERVICE']),
    );
    const reasons = await db.q(`SELECT "group"::text AS g, count(*)::int AS n FROM core.reason_codes GROUP BY 1`);
    expect(Object.fromEntries(reasons.map((r) => [r.g, r.n]))).toEqual({
      SPOILAGE: 6,
      POS_LINE_DELETE: 4,
      APP_ORDER_CANCEL: 5,
      DELIVERY_FAILED: 5,
      STOCKTAKE_VARIANCE: 6,
      MANUAL_WEIGHT: 3,
    });
    const w1 = await db.q(`SELECT pattern, enabled FROM core.barcode_rules WHERE code = 'W1'`);
    expect(w1).toEqual([{ pattern: '20{PLU:5}{W:5}{C}', enabled: true }]);
    expect((await db.q(`SELECT count(*)::int AS n FROM core.container_types`))[0]?.n).toBeGreaterThanOrEqual(3);
    expect(await db.q(`SELECT id FROM core.brand_settings`)).toEqual([{ id: 1 }]);
    // app_rw không thêm được dòng thương hiệu thứ hai; CHECK id = 1 chặn cả owner
    await expect(app(`INSERT INTO core.brand_settings (id, brand_name) VALUES (2, 'x')`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.q(`INSERT INTO core.brand_settings (id, brand_name) VALUES (2, 'x')`)).rejects.toThrow(
      /brand_settings_singleton/,
    );
    await app(`UPDATE core.brand_settings SET hotline = '1900 0000', primary_color = '#2F7D4F' WHERE id = 1`);
  });

  it('ràng buộc kiểu bán ↔ giá / cân / PLU', async () => {
    // hàng cân: giá/kg; không có giá/đơn vị
    await sku('WEIGHT', { retail_price_per_kg: 320000, scale_plu: '00123', sold_by_scale: true });
    await expect(sku('WEIGHT', { retail_price_per_unit: 25000 })).rejects.toThrow(/skus_price_kind/);
    // hàng đếm: giá/đơn vị; không giá/kg, không PLU
    await sku('PIECE_FIXED', { retail_price_per_unit: 25000 });
    await expect(sku('PIECE_FIXED', { retail_price_per_kg: 100000 })).rejects.toThrow(/skus_price_kind/);
    await expect(sku('PACK_FIXED', { std_weight_g: 500, scale_plu: '00999' })).rejects.toThrow(/skus_plu/);
    // hộp cố định cần định lượng
    await expect(sku('PACK_FIXED', { retail_price_per_unit: 165000 })).rejects.toThrow(/skus_pack_fixed_weight/);
    // giá phải > 0; PLU đúng 5 số; bán qua cân cần PLU
    await expect(sku('WEIGHT', { retail_price_per_kg: 0 })).rejects.toThrow(/skus_prices_positive/);
    await expect(sku('WEIGHT', { retail_price_per_kg: -1 })).rejects.toThrow(/skus_prices_positive/);
    await expect(sku('WEIGHT', { scale_plu: '1234' })).rejects.toThrow(/skus_plu/);
    await expect(sku('WEIGHT', { sold_by_scale: true })).rejects.toThrow(/skus_sold_by_scale/);
    // khoảng cân hợp lệ
    await expect(sku('PIECE_BY_WEIGHT', { weight_min_g: 900, weight_max_g: 500 })).rejects.toThrow(/skus_weight_range/);
    await expect(sku('PIECE_BY_WEIGHT', { std_weight_g: 1200, weight_max_g: 1000 })).rejects.toThrow(
      /skus_weight_range/,
    );
    // giỏ / dịch vụ không có cân, bì; dịch vụ không hạn dùng
    await expect(sku('BUNDLE', { tare_g: 50 })).rejects.toThrow(/skus_no_weight_kinds/);
    await expect(sku('SERVICE', { shelf_life_days: 3 })).rejects.toThrow(/skus_service/);
    await sku('SERVICE', { retail_price_per_unit: 10000 });
    // hạn cảnh báo / ngừng bán app không quá hạn dùng
    await expect(sku('WEIGHT', { shelf_life_days: 5, alert_days_before_expiry: 6 })).rejects.toThrow(/skus_shelf/);
  });

  it('mã SKU, PLU, mã vạch trùng ⇒ từ chối; SKU lưu trữ trả PLU / mã vạch lại', async () => {
    const c = code('DUP');
    await sku('WEIGHT', { sku_code: c });
    await expect(sku('WEIGHT', { sku_code: c })).rejects.toThrow(/skus_sku_code_key/);
    const a = await sku('WEIGHT', { scale_plu: '00500' });
    await expect(sku('WEIGHT', { scale_plu: '00500' })).rejects.toThrow(/skus_scale_plu_active/);
    await app(`UPDATE core.skus SET archived_at = now() WHERE id = $1`, [a]);
    await sku('WEIGHT', { scale_plu: '00500' });

    const s1 = await sku('PACK_FIXED', { std_weight_g: 500 });
    const s2 = await sku('PACK_FIXED', { std_weight_g: 250 });
    const u1 = await unit(s1, { unit_code: 'PACK', factor_units: 1, for_sale: true, barcode: '8930000000017' });
    await expect(
      unit(s2, { unit_code: 'PACK', factor_units: 1, for_sale: true, barcode: '8930000000017' }),
    ).rejects.toThrow(/sku_units_barcode_active/);
    await app(`UPDATE core.sku_units SET archived_at = now() WHERE id = $1`, [u1]);
    await unit(s2, { unit_code: 'PACK', factor_units: 1, for_sale: true, barcode: '8930000000017' });
    // dải 20–29 (13 số) dành cho tem cân
    await expect(
      unit(s2, { unit_code: 'PACK', factor_units: 1, for_sale: true, barcode: '2000123008455' }),
    ).rejects.toThrow(/sku_units_barcode/);
  });

  it('đơn vị tính: đúng một cách quy đổi, khớp đơn vị tồn; thùng danh nghĩa chỉ để mua; hệ số bất biến', async () => {
    const grape = await sku('WEIGHT', { retail_price_per_kg: 320000 });
    await unit(grape, { unit_code: 'KG', factor_g: 1000, for_sale: true, for_purchase: true });
    // hộp 500 g quy đổi cứng 500 g (§21.3.1)
    const box = await unit(grape, {
      unit_code: 'PACK',
      name: 'Hộp 500 g',
      factor_g: 500,
      for_sale: true,
      price_per_unit: 165000,
    });
    // thùng danh nghĩa: không quy đổi cứng, không bán
    await unit(grape, { unit_code: 'BOX', name: 'Thùng ~5 kg', is_variable: true, for_purchase: true });
    await expect(unit(grape, { unit_code: 'BOX', is_variable: true, for_sale: true })).rejects.toThrow(
      /sku_units_variable_not_for_sale/,
    );
    await expect(
      unit(grape, { unit_code: 'BOX', factor_g: 5000, is_variable: true, for_purchase: true }),
    ).rejects.toThrow(/sku_units_one_factor/);
    await expect(unit(grape, { unit_code: 'PACK', for_sale: true })).rejects.toThrow(/sku_units_one_factor/);
    // SKU tồn gram không có đơn vị quy đổi ra số quả
    await expect(unit(grape, { unit_code: 'PIECE', factor_units: 1, for_sale: true })).rejects.toThrow(/tồn theo gram/);
    // SKU đếm không quy đổi ra gram
    const avocado = await sku('PIECE_FIXED', { retail_price_per_unit: 25000 });
    await expect(unit(avocado, { unit_code: 'KG', factor_g: 1000, for_sale: true })).rejects.toThrow(
      /tồn theo đơn vị đếm/,
    );
    await unit(avocado, { unit_code: 'BOX', name: 'Thùng 24 quả', factor_units: 24, for_purchase: true });
    // dưa lưới (quả theo cân): cả gram lẫn số quả
    const melon = await sku('PIECE_BY_WEIGHT', { retail_price_per_kg: 60000 });
    await unit(melon, { unit_code: 'KG', factor_g: 1000, for_sale: true });
    await unit(melon, { unit_code: 'PIECE', factor_units: 1, for_sale: true });
    // dịch vụ không mua
    const svc = await sku('SERVICE', { retail_price_per_unit: 10000 });
    await expect(unit(svc, { unit_code: 'SERVICE', factor_units: 1, for_purchase: true })).rejects.toThrow(/không mua/);
    // giá đơn vị chỉ cho đơn vị bán, trong trần
    await expect(
      unit(grape, { unit_code: 'PACK', factor_g: 250, for_purchase: true, price_per_unit: 9000 }),
    ).rejects.toThrow(/sku_units_price/);
    await expect(
      unit(grape, { unit_code: 'PACK', factor_g: 250, for_sale: true, price_per_unit: 10_000_000_000 }),
    ).rejects.toThrow(/sku_units_price/);
    // review N2: đơn vị kg phải đúng 1000 g; đơn vị đã lưu trữ không dùng được
    await expect(unit(grape, { unit_code: 'KG', factor_g: 500, for_sale: true })).rejects.toThrow(/đúng 1000 g/);
    await db.q(`INSERT INTO core.units (code, name, kind) VALUES ('OLDBOX', 'thùng cũ', 'COUNT')`);
    await db.q(`UPDATE core.units SET archived_at = now() WHERE code = 'OLDBOX'`);
    await expect(unit(grape, { unit_code: 'OLDBOX', factor_g: 3000, for_purchase: true })).rejects.toThrow(
      /đã lưu trữ/,
    );
    await expect(db.q(`INSERT INTO core.units (code, name, kind) VALUES ('G100', '100 g', 'WEIGHT')`)).rejects.toThrow(
      /units_fixed_g/,
    );
    // review N3: thùng danh nghĩa chỉ cho hàng tồn theo gram; giỏ quà không mua
    await expect(unit(avocado, { unit_code: 'BOX', is_variable: true, for_purchase: true })).rejects.toThrow(
      /danh nghĩa/,
    );
    const giftBox = await sku('BUNDLE', { retail_price_per_unit: 500000 });
    await expect(unit(giftBox, { unit_code: 'BASKET', factor_units: 1, for_purchase: true })).rejects.toThrow(
      /không mua/,
    );
    const tray = await sku('PACK_VARIABLE', { retail_price_per_kg: 60000 });
    await expect(unit(tray, { unit_code: 'TRAY', factor_units: 1, for_sale: true })).rejects.toThrow(/tồn theo gram/);
    // review N4: đơn vị gốc / quả theo cân không có giá riêng (một nguồn giá)
    await expect(
      unit(grape, { unit_code: 'KG', factor_g: 1000, for_sale: true, price_per_unit: 300000 }),
    ).rejects.toThrow(/đơn vị gốc/);
    await expect(
      unit(avocado, { unit_code: 'PIECE', factor_units: 1, for_sale: true, price_per_unit: 26000 }),
    ).rejects.toThrow(/đơn vị gốc/);
    await expect(
      unit(melon, { unit_code: 'BOX', factor_units: 2, for_sale: true, price_per_unit: 99000 }),
    ).rejects.toThrow(/quả theo cân/);
    const melonPiece = (
      await db.q(`SELECT id FROM core.sku_units WHERE sku_id = $1 AND unit_code = 'PIECE'`, [melon])
    )[0]?.id as string;
    await expect(
      tx(async (q) => {
        await q(`UPDATE core.sku_units SET price_per_unit = 99000 WHERE id = $1`, [melonPiece]);
        await log(q, { sku: melon, field: 'SKU_UNIT', unit: melonPiece }, null, 99000);
      }),
    ).rejects.toThrow(/quả theo cân/);
    // hệ số quy đổi, đơn vị gốc, kiểu bán, mã SKU không sửa được
    await expect(app(`UPDATE core.sku_units SET factor_g = 450 WHERE id = $1`, [box])).rejects.toThrow(
      /permission denied/,
    );
    await expect(app(`UPDATE core.sku_units SET unit_code = 'BAG' WHERE id = $1`, [box])).rejects.toThrow(
      /permission denied/,
    );
    await expect(app(`UPDATE core.skus SET sale_unit_type = 'PIECE_FIXED' WHERE id = $1`, [grape])).rejects.toThrow(
      /permission denied/,
    );
    await expect(app(`UPDATE core.skus SET sku_code = 'X' WHERE id = $1`, [grape])).rejects.toThrow(
      /permission denied/,
    );
    await expect(app(`UPDATE core.units SET fixed_g = 500 WHERE code = 'KG'`)).rejects.toThrow(/permission denied/);
    // đổi giá đơn vị kèm lịch sử trong cùng transaction
    await tx(async (q) => {
      await q(`UPDATE core.sku_units SET price_per_unit = 170000 WHERE id = $1`, [box]);
      await log(q, { sku: grape, field: 'SKU_UNIT', unit: box }, 165000, 170000);
    });
  });

  it('review N1: đổi giá mà không ghi lịch sử ⇒ rollback lúc COMMIT (SKU, đơn vị, giá cửa hàng, bỏ giá cửa hàng)', async () => {
    const grape = await sku('WEIGHT', { retail_price_per_kg: 320000 });
    await expect(app(`UPDATE core.skus SET retail_price_per_kg = 300000 WHERE id = $1`, [grape])).rejects.toThrow(
      /không khớp price_change_logs/,
    );
    // tạo SKU có giá mà không ghi bản đầu
    await expect(
      app(
        `INSERT INTO core.skus (id, product_id, sku_code, name, sale_unit_type, retail_price_per_kg)
         VALUES ($1, $2, $3, 'x', 'WEIGHT', 1000)`,
        [id(), productId, code('NOLOG')],
      ),
    ).rejects.toThrow(/không khớp price_change_logs/);
    await expect(
      app(
        `INSERT INTO core.sku_units (id, sku_id, unit_code, name, factor_g, for_sale, price_per_unit)
           VALUES ($1, $2, 'PACK', 'Hộp 250 g', 250, true, 90000)`,
        [id(), grape],
      ),
    ).rejects.toThrow(/không khớp price_change_logs/);
    await expect(
      app(
        `INSERT INTO core.store_prices (store_id, sku_id, retail_price_per_kg, updated_by) VALUES ($1, $2, 330000, $3)`,
        [storeId, grape, userId],
      ),
    ).rejects.toThrow(/không khớp price_change_logs/);
    // log lệch giá thật cũng bị chặn
    await expect(
      tx(async (q) => {
        await q(`UPDATE core.skus SET retail_price_per_kg = 300000 WHERE id = $1`, [grape]);
        await log(q, { sku: grape, field: 'PER_KG' }, 320000, 310000);
      }),
    ).rejects.toThrow(/không khớp price_change_logs/);
    // vòng 2 C2: ghi lịch sử mà KHÔNG đổi giá thật cũng bị chặn (giá tra cứu sẽ lệch giá đang bán)
    await expect(tx((q) => log(q, { sku: grape, field: 'PER_KG' }, 320000, 280000))).rejects.toThrow(
      /không khớp price_change_logs/,
    );
    const box = await unit(grape, {
      unit_code: 'PACK',
      name: 'Hộp 500 g',
      factor_g: 500,
      for_sale: true,
      price_per_unit: 165000,
    });
    await expect(tx((q) => log(q, { sku: grape, field: 'SKU_UNIT', unit: box }, 165000, 160000))).rejects.toThrow(
      /không khớp price_change_logs/,
    );
    await expect(tx((q) => log(q, { sku: grape, store: storeId, field: 'PER_KG' }, null, 310000))).rejects.toThrow(
      /không khớp price_change_logs/,
    );
    // ghi chú 1: "túi 1 kg đóng sẵn" (đơn vị đếm, 1000 g) được giá riêng; đơn vị kg thì không
    await unit(grape, { unit_code: 'BAG', name: 'Túi 1 kg', factor_g: 1000, for_sale: true, price_per_unit: 315000 });
    // đúng cách: giá cửa hàng + log, rồi bỏ giá cửa hàng + log new NULL
    await tx(async (q) => {
      await q(
        `INSERT INTO core.store_prices (store_id, sku_id, retail_price_per_kg, updated_by) VALUES ($1, $2, 330000, $3)`,
        [storeId, grape, userId],
      );
      await log(q, { sku: grape, store: storeId, field: 'PER_KG' }, null, 330000);
    });
    await expect(
      app(`DELETE FROM core.store_prices WHERE store_id = $1 AND sku_id = $2`, [storeId, grape]),
    ).rejects.toThrow(/không khớp price_change_logs/);
    await tx(async (q) => {
      await q(`DELETE FROM core.store_prices WHERE store_id = $1 AND sku_id = $2`, [storeId, grape]);
      await log(q, { sku: grape, store: storeId, field: 'PER_KG' }, 330000, null);
    });
  });

  it('giá theo cửa hàng đúng loại giá; lịch sử giá chỉ-thêm, chuỗi liền, mốc do server đặt (clock_timestamp)', async () => {
    const grape = await sku('WEIGHT', { retail_price_per_kg: 320000 });
    const avocado = await sku('PIECE_FIXED', { retail_price_per_unit: 25000 });
    await expect(
      tx(async (q) => {
        await q(
          `INSERT INTO core.store_prices (store_id, sku_id, retail_price_per_kg, updated_by) VALUES ($1, $2, 1, $3)`,
          [storeId, avocado, userId],
        );
      }),
    ).rejects.toThrow(/đúng loại giá/);
    await tx(async (q) => {
      await q(
        `INSERT INTO core.store_prices (store_id, sku_id, retail_price_per_kg, updated_by) VALUES ($1, $2, 330000, $3)`,
        [storeId, grape, userId],
      );
      await log(q, { sku: grape, store: storeId, field: 'PER_KG' }, null, 330000);
    });
    await expect(
      app(`UPDATE core.store_prices SET retail_price_per_kg = 0 WHERE store_id = $1 AND sku_id = $2`, [storeId, grape]),
    ).rejects.toThrow(/store_prices_positive/);
    await expect(app(`UPDATE core.store_prices SET sku_id = $1`, [avocado])).rejects.toThrow(/permission denied/);

    // C1: hai lần đổi trong CÙNG transaction có mốc tăng dần (không cùng now()); mốc khách gửi bị bỏ qua
    const ids = [id(), id()];
    await tx(async (q) => {
      await q(`UPDATE core.skus SET retail_price_per_kg = 300000 WHERE id = $1`, [grape]);
      await q(
        `INSERT INTO core.price_change_logs (id, sku_id, scope, field, old_value, new_value, reason, changed_by, changed_at)
         VALUES ($1, $2, 'GLOBAL', 'PER_KG', 320000, 310000, 'giá chợ giảm', $3, '2000-01-01')`,
        [ids[0], grape, userId],
      );
      await q(
        `INSERT INTO core.price_change_logs (id, sku_id, scope, field, old_value, new_value, reason, changed_by)
         VALUES ($1, $2, 'GLOBAL', 'PER_KG', 310000, 300000, 'chỉnh lại', $3)`,
        [ids[1], grape, userId],
      );
    });
    const rows = await db.q(
      `SELECT id, changed_by, changed_at > now() - interval '1 minute' AS fresh FROM core.price_change_logs
       WHERE id = ANY ($1) ORDER BY changed_at, id`,
      [ids],
    );
    expect(rows).toEqual([
      { id: ids[0], changed_by: userId, fresh: true },
      { id: ids[1], changed_by: userId, fresh: true },
    ]);
    const [{ a, b }] = (await db.q(
      `SELECT (SELECT changed_at FROM core.price_change_logs WHERE id = $1) AS a,
              (SELECT changed_at FROM core.price_change_logs WHERE id = $2) AS b`,
      ids,
    )) as [{ a: Date; b: Date }];
    expect(b.getTime()).toBeGreaterThanOrEqual(a.getTime());
    expect((await db.q(`SELECT x.val FROM core.price_log_latest($1, NULL, 'PER_KG', NULL) x`, [grape]))[0]?.val).toBe(
      '300000',
    );
    // C1: chuỗi liền — giá cũ phải bằng giá mới của bản trước; bản đầu old NULL
    await expect(tx((q) => log(q, { sku: grape, field: 'PER_KG' }, 320000, 280000))).rejects.toThrow(/không khớp/);
    await expect(tx((q) => log(q, { sku: avocado, store: storeId, field: 'PER_UNIT' }, 25000, 26000))).rejects.toThrow(
      /bản ghi đầu/,
    );

    // chỉ thêm: app_rw không có quyền; owner bị trigger chặn (kể cả TRUNCATE)
    await expect(app(`UPDATE core.price_change_logs SET new_value = 1 WHERE id = $1`, [ids[0]])).rejects.toThrow(
      /permission denied/,
    );
    await expect(app(`DELETE FROM core.price_change_logs WHERE id = $1`, [ids[0]])).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.q(`UPDATE core.price_change_logs SET new_value = 1 WHERE id = $1`, [ids[0]])).rejects.toThrow();
    await expect(db.q(`DELETE FROM core.price_change_logs WHERE id = $1`, [ids[0]])).rejects.toThrow();
    await expect(db.q(`TRUNCATE core.price_change_logs CASCADE`)).rejects.toThrow();

    const ins = (vals: string, params: unknown[]) =>
      app(
        `INSERT INTO core.price_change_logs (id, sku_id, sku_unit_id, store_id, scope, field, old_value, new_value, reason, changed_by)
         VALUES (${vals})`,
        params,
      );
    // loại giá phải hợp kiểu bán; phạm vi ↔ store_id; field SKU_UNIT ↔ sku_unit_id; đơn vị phụ chỉ giá chung
    await expect(
      ins(`$1, $2, NULL, NULL, 'GLOBAL', 'PER_UNIT', NULL, 5000, 'x', $3`, [id(), grape, userId]),
    ).rejects.toThrow(/không hợp kiểu bán/);
    await expect(
      ins(`$1, $2, NULL, NULL, 'STORE', 'PER_KG', 300000, 5000, 'x', $3`, [id(), grape, userId]),
    ).rejects.toThrow(/price_change_logs_scope/);
    await expect(
      ins(`$1, $2, NULL, NULL, 'GLOBAL', 'SKU_UNIT', NULL, 5000, 'x', $3`, [id(), grape, userId]),
    ).rejects.toThrow(/price_change_logs_field/);
    const box = await unit(grape, { unit_code: 'PACK', factor_g: 500, for_sale: true, price_per_unit: 165000 });
    await expect(
      ins(`$1, $2, $3, $4, 'STORE', 'SKU_UNIT', NULL, 5000, 'x', $5`, [id(), grape, box, storeId, userId]),
    ).rejects.toThrow(/price_change_logs_unit_global/);
    await expect(
      ins(`$1, $2, NULL, NULL, 'GLOBAL', 'PER_KG', 300000, 300000, 'x', $3`, [id(), grape, userId]),
    ).rejects.toThrow(/price_change_logs_values/);
    await expect(
      ins(`$1, $2, NULL, NULL, 'GLOBAL', 'PER_KG', 300000, 6000, '  ', $3`, [id(), grape, userId]),
    ).rejects.toThrow(/price_change_logs_reason/);
    // giá đơn vị phụ phải thuộc đúng SKU
    await expect(
      ins(`$1, $2, $3, NULL, 'GLOBAL', 'SKU_UNIT', NULL, 170000, 'x', $4`, [id(), avocado, box, userId]),
    ).rejects.toThrow(/price_change_logs_sku_unit_id_sku_id_fkey/);
  });

  it('PLU / mã vạch trùng qua đường UPDATE ⇒ từ chối', async () => {
    const a = await sku('WEIGHT', { scale_plu: '00777' });
    const b = await sku('WEIGHT');
    expect(a).toBeTruthy();
    await expect(app(`UPDATE core.skus SET scale_plu = '00777' WHERE id = $1`, [b])).rejects.toThrow(
      /skus_scale_plu_active/,
    );
    await expect(app(`UPDATE core.skus SET scale_plu = '00000' WHERE id = $1`, [b])).rejects.toThrow(/skus_plu/);
    const p1 = await sku('PACK_FIXED', { std_weight_g: 300 });
    const p2 = await sku('PACK_FIXED', { std_weight_g: 300 });
    await unit(p1, { unit_code: 'PACK', factor_units: 1, for_sale: true, barcode: '8930000000024' });
    const u2 = await unit(p2, { unit_code: 'PACK', factor_units: 1, for_sale: true });
    await expect(app(`UPDATE core.sku_units SET barcode = '8930000000024' WHERE id = $1`, [u2])).rejects.toThrow(
      /sku_units_barcode_active/,
    );
  });

  it('cây danh mục: không vòng, tối đa 5 cấp, tên không trùng trong nhánh', async () => {
    const ids = [id(), id(), id(), id(), id(), id()];
    await app(`INSERT INTO core.categories (id, name) VALUES ($1, 'C1')`, [ids[0]]);
    for (let i = 1; i < 5; i++)
      await app(`INSERT INTO core.categories (id, parent_id, name) VALUES ($1, $2, $3)`, [
        ids[i],
        ids[i - 1],
        `C${i + 1}`,
      ]);
    await expect(
      app(`INSERT INTO core.categories (id, parent_id, name) VALUES ($1, $2, 'C6')`, [ids[5], ids[4]]),
    ).rejects.toThrow(/tối đa 5 cấp/);
    await expect(app(`UPDATE core.categories SET parent_id = $1 WHERE id = $2`, [ids[3], ids[1]])).rejects.toThrow(
      /vòng/,
    );
    await expect(app(`UPDATE core.categories SET parent_id = id WHERE id = $1`, [ids[0]])).rejects.toThrow();
    // đổi cha làm cây con vượt 5 cấp
    const root2 = id();
    const mid = id();
    await app(`INSERT INTO core.categories (id, name) VALUES ($1, 'R2')`, [root2]);
    await app(`INSERT INTO core.categories (id, parent_id, name) VALUES ($1, $2, 'M')`, [mid, root2]);
    await expect(app(`UPDATE core.categories SET parent_id = $1 WHERE id = $2`, [ids[4], root2])).rejects.toThrow(
      /tối đa 5 cấp/,
    );
    await expect(
      app(`INSERT INTO core.categories (id, parent_id, name) VALUES ($1, $2, ' c2 ')`, [id(), ids[0]]),
    ).rejects.toThrow(/categories_sibling_name/);
    await expect(app(`DELETE FROM core.categories WHERE id = $1`, [mid])).rejects.toThrow(/permission denied/);
  });

  it('vị trí: đúng một chủ, một "đang vận chuyển" mỗi nơi; vị trí mặc định phải cùng cửa hàng và đang dùng', async () => {
    const wh = id();
    await app(`INSERT INTO core.warehouses (id, code, name) VALUES ($1, $2, 'Kho tổng')`, [wh, code('KT')]);
    const loc = async (store: string | null, w: string | null, type: string, c = code('L')) => {
      const lid = id();
      await app(
        `INSERT INTO core.locations (id, store_id, warehouse_id, type, code, name) VALUES ($1, $2, $3, $4, $5, 'x')`,
        [lid, store, w, type, c],
      );
      return lid;
    };
    await expect(loc(storeId, wh, 'SHELF')).rejects.toThrow(/locations_one_owner/);
    await expect(loc(null, null, 'SHELF')).rejects.toThrow(/locations_one_owner/);
    // 0010: tạo cửa hàng / kho ⇒ tự có đúng một IN_TRANSIT; thêm cái thứ hai bị chặn; không lưu trữ được
    const own = async (col: 'store_id' | 'warehouse_id', v: string) =>
      (await db.q(`SELECT id, code FROM core.locations WHERE ${col} = $1 AND type = 'IN_TRANSIT'`, [v])) as {
        id: string;
        code: string;
      }[];
    const [st] = await own('store_id', storeId);
    const [wt] = await own('warehouse_id', wh);
    expect(st?.code).toBe('IN_TRANSIT');
    expect(wt?.code).toBe('IN_TRANSIT');
    const transit = st?.id as string;
    await expect(loc(storeId, null, 'IN_TRANSIT')).rejects.toThrow(/locations_one_in_transit/);
    await expect(loc(null, wh, 'IN_TRANSIT')).rejects.toThrow(/locations_one_in_transit/);
    await expect(app(`UPDATE core.locations SET archived_at = now() WHERE id = $1`, [transit])).rejects.toThrow(
      /không lưu trữ được/,
    );
    const shelf = await loc(storeId, null, 'SHELF');
    const whCold = await loc(null, wh, 'COLD_ROOM');
    const s = await sku('WEIGHT');
    await expect(
      app(`INSERT INTO core.sku_default_locations (store_id, sku_id, location_id) VALUES ($1, $2, $3)`, [
        storeId,
        s,
        whCold,
      ]),
    ).rejects.toThrow(/sku_default_locations_location_id_store_id_fkey/);
    await expect(
      app(`INSERT INTO core.sku_default_locations (store_id, sku_id, location_id) VALUES ($1, $2, $3)`, [
        storeId,
        s,
        transit,
      ]),
    ).rejects.toThrow(/đang vận chuyển/);
    await app(`INSERT INTO core.sku_default_locations (store_id, sku_id, location_id) VALUES ($1, $2, $3)`, [
      storeId,
      s,
      shelf,
    ]);
    await expect(
      app(`UPDATE core.locations SET store_id = NULL, warehouse_id = $1 WHERE id = $2`, [wh, shelf]),
    ).rejects.toThrow(/permission denied/);
  });

  it('cửa hàng §4.6; quy tắc mã vạch; NCC mã hóa đi cặp; lượt nhập đúng trạng thái', async () => {
    await expect(app(`UPDATE core.stores SET lat = 10.77 WHERE id = $1`, [storeId])).rejects.toThrow(/stores_latlng/);
    await app(
      `UPDATE core.stores SET lat = 10.7769, lng = 106.7009, opening_hours = '{"mon":[["07:00","21:00"]]}',
              pos_status = 'OPEN', app_status = 'ONLINE', app_capacity_per_hour = 20 WHERE id = $1`,
      [storeId],
    );
    await expect(app(`UPDATE core.stores SET opening_hours = '[]' WHERE id = $1`, [storeId])).rejects.toThrow(
      /stores_opening_hours/,
    );
    await expect(app(`UPDATE core.stores SET code = 'X' WHERE id = $1`, [storeId])).rejects.toThrow(
      /permission denied/,
    );

    const rule = (type: string, pattern: string, checksum = true) =>
      app(
        `INSERT INTO core.barcode_rules (id, code, name, priority, type, pattern, ean13_checksum) VALUES ($1, $2, 'x', $3, $4, $5, $6)`,
        [id(), code('R').slice(0, 12), 1000 + Math.floor(Math.random() * 8000), type, pattern, checksum],
      );
    await expect(rule('WEIGHT', '20{PLU:5}{P:5}{C}')).rejects.toThrow(/barcode_rules_weight/);
    await expect(rule('PRICE', '21{PLU:5}{W:5}{C}')).rejects.toThrow(/barcode_rules_price/);
    await expect(rule('WEIGHT', '20{PLU:5}{W:5}')).rejects.toThrow(/barcode_rules_checksum/);
    await expect(rule('BATCH', 'MF-B{ID};DROP', false)).rejects.toThrow(/barcode_rules_pattern/);
    await rule('BATCH', 'MF-B{ID}', false);

    const sup = (enc: Buffer | null, hash: Buffer | null) =>
      app(
        `INSERT INTO core.suppliers (id, code, name, type, phone_enc, phone_hash) VALUES ($1, $2, 'NCC', 'FARM', $3, $4)`,
        [id(), code('NCC'), enc, hash],
      );
    await expect(sup(randomBytes(40), null)).rejects.toThrow(/suppliers_phone_pair/);
    await expect(sup(randomBytes(40), randomBytes(16))).rejects.toThrow(/suppliers_phone_pair/);
    await sup(randomBytes(40), randomBytes(32));

    const file = id();
    await db.q(
      `INSERT INTO core.files (id, kind, mime, storage_key, declared_bytes, declared_sha256, created_by)
       VALUES ($1, 'IMPORT', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', $2, 10, $3, $4)`,
      [file, `k/${file}`, randomBytes(32), userId],
    );
    const job = id();
    await app(
      `INSERT INTO core.import_jobs (id, type, file_id, mode_on_duplicate, dry_run, created_by) VALUES ($1, 'CATALOG', $2, 'SKIP', true, $3)`,
      [job, file, userId],
    );
    await expect(app(`UPDATE core.import_jobs SET status = 'COMPLETED' WHERE id = $1`, [job])).rejects.toThrow(
      /không hợp lệ/,
    );
    await expect(
      app(`UPDATE core.import_jobs SET status = 'FAILED', started_at = now(), finished_at = now() WHERE id = $1`, [
        job,
      ]),
    ).rejects.toThrow(/import_jobs_status/);
    // mốc do server đặt: giá trị client gửi bị ghi đè
    await app(`UPDATE core.import_jobs SET status = 'RUNNING', started_at = '2000-01-01' WHERE id = $1`, [job]);
    expect(
      (
        await db.q(`SELECT started_at > now() - interval '1 minute' AS fresh FROM core.import_jobs WHERE id = $1`, [
          job,
        ])
      )[0],
    ).toEqual({ fresh: true });
    await app(
      `UPDATE core.import_jobs SET status = 'COMPLETED', finished_at = now(), total_rows = 200, ok_rows = 197, skipped_rows = 3,
              report = '{"skipped":[]}' WHERE id = $1`,
      [job],
    );
    await expect(app(`UPDATE core.import_jobs SET mode_on_duplicate = 'UPDATE' WHERE id = $1`, [job])).rejects.toThrow(
      /permission denied/,
    );
    // chỉ đi tới; tổng dòng không vượt total; lượt mới phải PENDING
    await expect(
      app(`UPDATE core.import_jobs SET status = 'PENDING', started_at = NULL, finished_at = NULL WHERE id = $1`, [job]),
    ).rejects.toThrow(/đã kết thúc/);
    const job2 = id();
    await expect(
      app(
        `INSERT INTO core.import_jobs (id, type, file_id, mode_on_duplicate, dry_run, status, started_at, created_by)
         VALUES ($1, 'CATALOG', $2, 'SKIP', false, 'RUNNING', now(), $3)`,
        [job2, file, userId],
      ),
    ).rejects.toThrow(/phải PENDING/);
    await app(
      `INSERT INTO core.import_jobs (id, type, file_id, mode_on_duplicate, dry_run, created_by) VALUES ($1, 'CATALOG', $2, 'STOP', false, $3)`,
      [job2, file, userId],
    );
    await expect(
      app(`UPDATE core.import_jobs SET total_rows = 10, ok_rows = 9, error_rows = 2 WHERE id = $1`, [job2]),
    ).rejects.toThrow(/import_jobs_count_sum/);
    // PENDING → FAILED (file hỏng) khi có lỗi: được, mốc kết thúc do server đặt
    await app(
      `UPDATE core.import_jobs SET status = 'FAILED', error = 'file hỏng', finished_at = '2000-01-01' WHERE id = $1`,
      [job2],
    );
    expect(
      (
        await db.q(
          `SELECT started_at, finished_at > now() - interval '1 minute' AS fresh FROM core.import_jobs WHERE id = $1`,
          [job2],
        )
      )[0],
    ).toEqual({ started_at: null, fresh: true });
  });

  it('không DELETE / TRUNCATE trên bảng danh mục (lưu trữ thay vì xóa), trừ bảng nối đã liệt kê', async () => {
    const priv = async (t: string, p: string) =>
      (await db.q(`SELECT has_table_privilege('app_rw', $1, $2) AS ok`, [t, p]))[0]?.ok;
    for (const t of [
      'core.units',
      'core.categories',
      'core.products',
      'core.skus',
      'core.sku_units',
      'core.price_change_logs',
      'core.locations',
      'core.barcode_rules',
      'core.import_jobs',
      'core.reason_codes',
      'core.container_types',
      'core.brand_settings',
      'core.suppliers',
    ])
      expect({ t, d: await priv(t, 'DELETE'), tr: await priv(t, 'TRUNCATE'), u: await priv(t, 'UPDATE') }).toEqual({
        t,
        d: false,
        tr: false,
        u: false,
      });
    for (const t of ['core.store_prices', 'core.sku_default_locations', 'core.supplier_skus'])
      expect({ t, d: await priv(t, 'DELETE') }).toEqual({ t, d: true });
  });
});
