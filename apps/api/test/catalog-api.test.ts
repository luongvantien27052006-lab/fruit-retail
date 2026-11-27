import type { INestApplication } from '@nestjs/common';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { generateKeyPairSync, type KeyObject, randomBytes, randomUUID, sign } from 'node:crypto';
import { generateSync } from 'otplib';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAuthKeys } from '../src/auth/auth-config';
import { enrollmentCodeHash, newEnrollmentCode, normalizeEnrollmentCode, proofMessage } from '../src/auth/device-proof';
import { ARGON_PROFILES, hashSecret } from '../src/auth/password';
import { PiiCipher, totpAad } from '../src/auth/pii-cipher';
import { createApp } from '../src/bootstrap';
import { stockQuantityOf } from '../src/catalog/catalog-rules';
import { createMaster } from '../src/cli/create-master';
import { loadEnv } from '../src/config/env';
import { testAuthEnv } from './helpers/auth-env';
import { schemaErrors } from './helpers/contract';
import { type MigratedDb, startMigratedDb } from './helpers/db';
import { relaxedRatePolicies } from './helpers/rate-limit';

// CP04 lát 2 — API danh mục (đơn vị tính, cây danh mục, sản phẩm, SKU + đơn vị bán/mua) trên PostgreSQL + Redis thật.
// Cổng: quy đổi đơn vị (hộp 500 g ⇒ 500 g; thùng danh nghĩa không quy đổi cứng); SKU sai kiểu bán ⇒ 422; quyền.

interface Device {
  id: string;
  key: KeyObject;
}

describe('API danh mục (CP04 lát 2)', () => {
  let db: MigratedDb;
  let redis: StartedRedisContainer;
  let app: INestApplication;
  let cipher: PiiCipher;
  let master: string;
  let masterId: string;
  const http = () => request(app.getHttpServer());
  const rows = (sql: string, p: unknown[] = []) => db.q(sql, p);
  const hex = (n = 3) => randomBytes(n).toString('hex').toUpperCase();
  const get = (u: string) => http().get(`/v1${u}`).set('Authorization', master);
  const post = (u: string, b: object) => http().post(`/v1${u}`).set('Authorization', master).send(b);
  const patch = (u: string, b: object) => http().patch(`/v1${u}`).set('Authorization', master).send(b);
  const err = (r: { status: number; body: { code?: string } }) => [r.status, r.body.code];

  async function totp(userId: string): Promise<string> {
    const [u] = await rows(`SELECT totp_secret_enc FROM core.users WHERE id = $1`, [userId]);
    return generateSync({ secret: cipher.decrypt(u?.totp_secret_enc as Buffer, totpAad(userId)).toString('utf8') });
  }

  async function storeManagerClient() {
    const storeId = randomUUID();
    const sc = `S${hex()}`;
    await rows(`INSERT INTO core.stores (id, code, name) VALUES ($1, $2, $2)`, [storeId, sc]);
    const userId = randomUUID();
    const code = `NV${hex()}`;
    const pin = '246813';
    await rows(`INSERT INTO core.users (id, type, pin_hash) VALUES ($1, 'STAFF', $2)`, [
      userId,
      await hashSecret(pin, ARGON_PROFILES.PASSWORD),
    ]);
    await rows(`INSERT INTO core.staff (user_id, staff_code, full_name) VALUES ($1, $2, $2)`, [userId, code]);
    await rows(
      `INSERT INTO core.user_role_assignments (id, user_id, role, scope_type, scope_id) VALUES ($1, $2, 'STORE_MANAGER', 'STORE', $3)`,
      [randomUUID(), userId, storeId],
    );
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const d: Device = { id: randomUUID(), key: privateKey };
    const pub = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
    const proof = (purpose: 'register' | 'pin', binding: string) => {
      const ts = Math.floor(Date.now() / 1000);
      const nonce = randomBytes(16).toString('base64url');
      return {
        ts,
        nonce,
        signature: sign(null, proofMessage(purpose, d.id, ts, nonce, binding), d.key).toString('base64url'),
      };
    };
    const enroll = newEnrollmentCode();
    await rows(
      `INSERT INTO core.pos_enrollment_codes (id, store_id, code_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '30 minutes')`,
      [randomUUID(), storeId, Buffer.from(enrollmentCodeHash(enroll)), masterId],
    );
    const reg = await http()
      .post('/v1/auth/devices/register')
      .set('X-Device-Id', d.id)
      .send({
        enrollment_code: enroll,
        name: 'Quầy',
        platform: 'windows',
        public_key: pub,
        device_proof: proof('register', `${normalizeEnrollmentCode(enroll)}\n${pub}`),
      });
    expect(reg.status).toBe(201);
    expect(
      (await post(`/admin/pos-devices/${d.id}/activate`, { pairing_code: reg.body.pairing_code as string })).status,
    ).toBe(200);
    const l = await http()
      .post('/v1/auth/pin')
      .set('X-Device-Id', d.id)
      .send({ staff_code: code, pin, device_proof: proof('pin', code) });
    expect(l.status).toBe(200);
    const bearer = `Bearer ${l.body.access_token as string}`;
    return {
      get: (u: string) => http().get(`/v1${u}`).set('Authorization', bearer).set('X-Device-Id', d.id),
      post: (u: string, b: object) =>
        http().post(`/v1${u}`).set('Authorization', bearer).set('X-Device-Id', d.id).send(b),
    };
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
    cipher = new PiiCipher(loadAuthKeys(env));
    app = await createApp(env, { logger: false }, { providers: [relaxedRatePolicies] });
    await app.init();
    const m = await createMaster(db.roleUrl('app_rw'), `m-${hex().toLowerCase()}@fruit.test`, {
      mustChangePassword: false,
    });
    masterId = m.userId;
    const l = await http().post('/v1/auth/login').send({ email: m.email, password: m.password });
    const b = `Bearer ${l.body.access_token as string}`;
    await http().post('/v1/auth/2fa/setup').set('Authorization', b).send({});
    const c = await http()
      .post('/v1/auth/2fa/confirm')
      .set('Authorization', b)
      .send({ code: await totp(m.userId) });
    expect(c.status).toBe(200);
    master = `Bearer ${c.body.access_token as string}`;
  });
  afterAll(async () => {
    await app?.close();
    await Promise.allSettled([db?.pg.stop(), redis?.stop()]);
  });

  async function category(parentId: string | null = null) {
    const r = await post('/admin/categories', { parent_id: parentId, name: `DM ${hex()}` });
    expect(r.status).toBe(201);
    return r.body.id as string;
  }
  async function product(categoryId?: string) {
    const r = await post('/admin/products', { category_id: categoryId ?? (await category()), name: `SP ${hex()}` });
    expect(r.status).toBe(201);
    return r.body.id as string;
  }
  const plu = () => String(10000 + Math.floor(Math.random() * 89999));
  async function sku(body: Record<string, unknown> = {}) {
    const r = await post('/admin/skus', {
      product_id: await product(),
      sku_code: `SKU-${hex()}`,
      name: `SKU ${hex()}`,
      sale_unit_type: 'WEIGHT',
      ...body,
    });
    return r;
  }
  async function audits(resourceId: string) {
    return rows(`SELECT action, before, after FROM audit.logs WHERE resource_id = $1 ORDER BY at, id`, [resourceId]);
  }

  it('đơn vị tính: tạo / sửa / lưu trữ; kg không lưu trữ được; WEIGHT phải có fixed_g; đơn vị lưu trữ không dùng cho SKU mới', async () => {
    const list = await get('/admin/units');
    expect(list.status).toBe(200);
    expect(schemaErrors('UnitList', list.body)).toEqual([]);
    expect((list.body.items as { code: string }[]).map((u) => u.code)).toContain('KG');

    const code = `TUI${hex(2)}`;
    const c = await post('/admin/units', { code: code.toLowerCase(), name: 'túi lưới', kind: 'COUNT' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ code, kind: 'COUNT', fixed_g: null, archived_at: null });
    expect(schemaErrors('Unit', c.body)).toEqual([]);
    expect(err(await post('/admin/units', { code, name: 'trùng', kind: 'COUNT' }))).toEqual([409, 'VERSION_CONFLICT']);
    expect(err(await post('/admin/units', { code: `G${hex(2)}`, name: 'lạng', kind: 'WEIGHT' }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    expect(err(await post('/admin/units', { code: `C${hex(2)}`, name: 'x', kind: 'COUNT', fixed_g: 100 }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    expect(err(await patch('/admin/units/KG', { archived: true }))).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    expect(err(await get('/admin/units/KHONGCO'))).toEqual([404, 'RESOURCE_NOT_FOUND']);
    // không đổi được loại / số gram (trường lạ ⇒ 400)
    expect(err(await patch(`/admin/units/${code}`, { kind: 'WEIGHT' }))).toEqual([400, 'INVALID_REQUEST']);

    const a = await patch(`/admin/units/${code}`, { archived: true, name: 'túi lưới (cũ)' });
    expect(a.status).toBe(200);
    expect(a.body.archived_at).not.toBeNull();
    expect((await get('/admin/units')).body.items.map((u: { code: string }) => u.code)).not.toContain(code);
    expect((await get('/admin/units?include_archived=true')).body.items.map((u: { code: string }) => u.code)).toContain(
      code,
    );
    const s = await sku({ sale_unit_type: 'PIECE_FIXED' });
    expect(s.status).toBe(201);
    const u = await post(`/admin/skus/${s.body.id as string}/units`, {
      unit_code: code,
      name: 'Túi 6 quả',
      factor_units: 6,
      for_sale: true,
      for_purchase: false,
    });
    expect(err(u)).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    expect((await audits(code)).map((x) => x.action)).toEqual(['unit.create', 'unit.update']);
  });

  it('cây danh mục: con/sản phẩm không gắn vào cha lưu trữ; không lưu trữ cha còn con; vòng / quá 5 cấp ⇒ 422; trùng tên cùng cha ⇒ 409', async () => {
    const root = await category();
    const child = await category(root);
    const g = await get(`/admin/categories/${child}`);
    expect(g.status).toBe(200);
    expect(schemaErrors('Category', g.body)).toEqual([]);
    expect(g.body.parent_id).toBe(root);
    expect(schemaErrors('CategoryList', (await get('/admin/categories')).body)).toEqual([]);

    const dupName = (await get(`/admin/categories/${child}`)).body.name as string;
    expect(err(await post('/admin/categories', { parent_id: root, name: dupName }))).toEqual([409, 'VERSION_CONFLICT']);
    // vòng: gắn cha vào con của chính nó (trigger categories_tree_guard ⇒ 422)
    expect(err(await patch(`/admin/categories/${root}`, { parent_id: child }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    // sâu tối đa 5 cấp
    let p = child;
    for (let i = 0; i < 3; i++) p = await category(p);
    expect(err(await post('/admin/categories', { parent_id: p, name: `L6 ${hex()}` }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);

    // không lưu trữ cha còn con / sản phẩm đang dùng
    const r1 = await patch(`/admin/categories/${root}`, { archived: true });
    expect(err(r1)).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    expect(r1.body.details).toMatchObject({ active_children: 1 });
    const leaf = await category();
    const prod = await product(leaf);
    expect((await patch(`/admin/categories/${leaf}`, { archived: true })).body.details).toMatchObject({
      active_products: 1,
    });
    expect((await patch(`/admin/products/${prod}`, { archived: true })).status).toBe(200);
    expect((await patch(`/admin/categories/${leaf}`, { archived: true })).status).toBe(200);
    // gắn vào danh mục lưu trữ ⇒ 422
    expect(err(await post('/admin/categories', { parent_id: leaf, name: 'x' }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    expect(err(await post('/admin/products', { category_id: leaf, name: 'x' }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    expect(err(await patch(`/admin/products/${prod}`, { archived: false }))).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    expect(err(await post('/admin/products', { category_id: randomUUID(), name: 'x' }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    // mở lại danh mục ⇒ mở lại sản phẩm được
    expect((await patch(`/admin/categories/${leaf}`, { archived: false })).status).toBe(200);
    const reopened = await patch(`/admin/products/${prod}`, { archived: false, origin: 'Hàn Quốc' });
    expect(reopened.status).toBe(200);
    expect(schemaErrors('Product', reopened.body)).toEqual([]);
    expect(reopened.body.archived_at).toBeNull();
    expect((await audits(prod)).map((x) => x.action)).toEqual(['product.create', 'product.update', 'product.update']);
    expect(err(await get(`/admin/products/${randomUUID()}`))).toEqual([404, 'RESOURCE_NOT_FOUND']);
    const pl = await get(`/admin/products?category_id=${leaf}`);
    expect(schemaErrors('ProductList', pl.body)).toEqual([]);
    expect(pl.body.items.map((x: { id: string }) => x.id)).toEqual([prod]);
  });

  it('cổng quy đổi đơn vị: kg = 1000 g, hộp 500 g ⇒ 500 g tồn, thùng danh nghĩa không quy đổi cứng (§21.3.1)', async () => {
    const r = await sku({
      scale_plu: plu(),
      sold_by_scale: true,
      units: [
        {
          unit_code: 'PACK',
          name: 'Hộp 500 g',
          factor_g: 500,
          for_sale: true,
          for_purchase: false,
          barcode: '8930000000019',
        },
        { unit_code: 'BOX', name: 'Thùng ~5 kg', is_variable: true, for_sale: false, for_purchase: true },
      ],
    });
    expect(r.status).toBe(201);
    expect(schemaErrors('Sku', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ stock_base: 'GRAM', version: 0, retail_price_per_kg: null });
    const units = r.body.units as {
      id: string;
      unit_code: string;
      factor_g: number | null;
      factor_units: number | null;
      is_variable: boolean;
    }[];
    expect(units.map((u) => [u.unit_code, u.factor_g, u.is_variable])).toEqual([
      ['KG', 1000, false],
      ['PACK', 500, false],
      ['BOX', null, true],
    ]);
    // quy đổi trên chính bản ghi DB (helper @fruit/money_weight dùng chung TS/Dart)
    const db1 = await rows(
      `SELECT unit_code, factor_g, factor_units, is_variable FROM core.sku_units WHERE sku_id = $1 ORDER BY created_at, id`,
      [r.body.id],
    );
    const conv = (u: Record<string, unknown> | undefined) => ({
      factorG: (u?.factor_g ?? null) as number | null,
      factorUnits: (u?.factor_units ?? null) as number | null,
      isVariable: u?.is_variable === true,
    });
    expect(stockQuantityOf('WEIGHT', conv(db1[0]), 2)).toEqual({ base: 'GRAM', amount: 2000 });
    expect(stockQuantityOf('WEIGHT', conv(db1[1]), 1)).toEqual({ base: 'GRAM', amount: 500 });
    expect(stockQuantityOf('WEIGHT', conv(db1[1]), 3)).toEqual({ base: 'GRAM', amount: 1500 });
    expect(() => stockQuantityOf('WEIGHT', conv(db1[2]), 1)).toThrowError(
      expect.objectContaining({ code: 'CATALOG_RULE_VIOLATION', details: { reason: 'VARIABLE_UNIT' } }),
    );
    // hàng đếm: thùng 24 quả ⇒ 48 quả
    const c = await sku({
      sale_unit_type: 'PIECE_FIXED',
      units: [{ unit_code: 'BOX', name: 'Thùng 24 quả', factor_units: 24, for_sale: false, for_purchase: true }],
    });
    expect(c.status).toBe(201);
    expect(c.body.stock_base).toBe('COUNT');
    const box = (c.body.units as { factor_units: number }[])[1] ?? { factor_units: 0 };
    expect(
      stockQuantityOf('PIECE_FIXED', { factorG: null, factorUnits: box.factor_units, isVariable: false }, 2),
    ).toEqual({
      base: 'COUNT',
      amount: 48,
    });
    const svc = await sku({ sale_unit_type: 'SERVICE' });
    expect(svc.status).toBe(201);
    expect(svc.body).toMatchObject({ stock_base: 'NONE' });
    expect((svc.body.units as { unit_code: string; for_purchase: boolean }[])[0]).toMatchObject({
      unit_code: 'SERVICE',
      for_purchase: false,
    });
    expect(stockQuantityOf('SERVICE', { factorG: null, factorUnits: 1, isVariable: false }, 1)).toBeNull();
    // audit: tạo SKU kèm đơn vị
    const [a] = await audits(r.body.id as string);
    expect(a?.action).toBe('sku.create');
    expect((a?.after as { units: unknown[] }).units).toHaveLength(3);
  });

  it('SKU sai kiểu bán ⇒ 422 CATALOG_RULE_VIOLATION (thuộc tính và đơn vị)', async () => {
    const bad: [string, Record<string, unknown>][] = [
      ['PLU cho hàng đếm', { sale_unit_type: 'PIECE_FIXED', scale_plu: plu() }],
      ['bán qua cân không PLU', { sold_by_scale: true }],
      ['dịch vụ có cân', { sale_unit_type: 'SERVICE', std_weight_g: 100 }],
      ['dịch vụ có hạn dùng', { sale_unit_type: 'SERVICE', shelf_life_days: 3 }],
      ['giỏ có bì', { sale_unit_type: 'BUNDLE', tare_g: 50 }],
      ['hộp cố định thiếu định lượng', { sale_unit_type: 'PACK_FIXED' }],
      ['khoảng cân ngược', { weight_min_g: 500, weight_max_g: 300 }],
      ['cảnh báo quá hạn dùng', { shelf_life_days: 5, alert_days_before_expiry: 6 }],
      ['hàng cân đổi đơn vị gốc', { base_unit_code: 'PIECE' }],
      ['hàng đếm dùng kg làm gốc', { sale_unit_type: 'PIECE_FIXED', base_unit_code: 'KG' }],
      [
        'đơn vị đếm cho hàng chỉ tồn gram',
        { units: [{ unit_code: 'PIECE', name: 'quả', factor_units: 1, for_sale: true, for_purchase: false }] },
      ],
      [
        'kg quy đổi sai',
        { units: [{ unit_code: 'KG', name: 'nửa kg', factor_g: 500, for_sale: true, for_purchase: false }] },
      ],
      [
        'danh nghĩa để bán',
        { units: [{ unit_code: 'BOX', name: 'Thùng', is_variable: true, for_sale: true, for_purchase: true }] },
      ],
      [
        'danh nghĩa cho hàng đếm',
        {
          sale_unit_type: 'PIECE_FIXED',
          units: [{ unit_code: 'BOX', name: 'Thùng', is_variable: true, for_sale: false, for_purchase: true }],
        },
      ],
      [
        'gram cho hàng đếm',
        {
          sale_unit_type: 'PACK_FIXED',
          std_weight_g: 250,
          units: [{ unit_code: 'BOX', name: 'Thùng', factor_g: 5000, for_sale: false, for_purchase: true }],
        },
      ],
      [
        'dịch vụ để mua',
        {
          sale_unit_type: 'SERVICE',
          units: [{ unit_code: 'SERVICE', name: 'x', factor_units: 2, for_sale: true, for_purchase: true }],
        },
      ],
      [
        'hai cách quy đổi',
        {
          units: [
            { unit_code: 'PACK', name: 'Hộp', factor_g: 500, is_variable: true, for_sale: false, for_purchase: true },
          ],
        },
      ],
    ];
    for (const [why, body] of bad) {
      const r = await sku(body);
      expect([why, ...err(r)]).toEqual([why, 422, 'CATALOG_RULE_VIOLATION']);
    }
    // lỗi ở đơn vị xảy ra SAU khi đã INSERT skus + đơn vị gốc ⇒ transaction rollback hết, mã SKU dùng lại được
    const code = `RB-${hex()}`;
    const r1 = await sku({
      sku_code: code,
      units: [{ unit_code: 'KG', name: 'nửa kg', factor_g: 500, for_sale: true, for_purchase: false }],
    });
    expect(err(r1)).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    const [n] = await rows(
      `SELECT (SELECT count(*)::int FROM core.skus WHERE sku_code = $1) AS skus,
              (SELECT count(*)::int FROM core.sku_units u JOIN core.skus s ON s.id = u.sku_id WHERE s.sku_code = $1) AS units`,
      [code],
    );
    expect(n).toEqual({ skus: 0, units: 0 });
    expect((await sku({ sku_code: code })).status).toBe(201);
    // kiểu bán sai ⇒ 400 (zod); giá không nhận ở đây
    expect(err(await sku({ sale_unit_type: 'KG' }))).toEqual([400, 'INVALID_REQUEST']);
    expect(err(await sku({ retail_price_per_kg: '95000' }))).toEqual([400, 'INVALID_REQUEST']);
    // thêm đơn vị sai kiểu bán vào SKU có sẵn
    const s = await sku();
    const u = await post(`/admin/skus/${s.body.id as string}/units`, {
      unit_code: 'PACK',
      name: 'Hộp 6 quả',
      factor_units: 6,
      for_sale: true,
      for_purchase: false,
    });
    expect(err(u)).toEqual([422, 'CATALOG_RULE_VIOLATION']);
  });

  it('trùng mã SKU / PLU / mã vạch ⇒ 409; lưu trữ SKU trả PLU; mã vạch sai số kiểm tra ⇒ 422; dải tem cân ⇒ 400', async () => {
    const p = plu();
    const a = await sku({ scale_plu: p, barcode: '8930000000026' });
    expect(a.status).toBe(201);
    expect(a.body.sku_code).toMatch(/^SKU-/);
    const dupCode = await sku({ sku_code: (a.body.sku_code as string).toLowerCase() });
    expect([...err(dupCode), dupCode.body.details?.field]).toEqual([409, 'VERSION_CONFLICT', 'sku_code']);
    const dupPlu = await sku({ scale_plu: p });
    expect([...err(dupPlu), dupPlu.body.details?.field]).toEqual([409, 'VERSION_CONFLICT', 'scale_plu']);
    const dupBar = await sku({ sale_unit_type: 'PIECE_FIXED', barcode: '8930000000026' });
    expect([...err(dupBar), dupBar.body.details?.field]).toEqual([409, 'VERSION_CONFLICT', 'barcode']);
    expect(err(await sku({ barcode: '8930000000027' }))).toEqual([422, 'BARCODE_CHECKSUM_INVALID']);
    expect(err(await sku({ barcode: '2012345000013' }))).toEqual([400, 'INVALID_REQUEST']);
    // mã nội bộ có chữ: không kiểm số kiểm tra
    expect((await sku({ sale_unit_type: 'PIECE_FIXED', barcode: `NB-${hex()}` })).status).toBe(201);

    // lưu trữ SKU ⇒ PLU dùng lại được; mở lại SKU cũ ⇒ 409 trùng PLU
    const arch = await patch(`/admin/skus/${a.body.id as string}`, { version: 0, archived: true });
    expect(arch.status).toBe(200);
    expect(arch.body).toMatchObject({ version: 1 });
    const b = await sku({ scale_plu: p });
    expect(b.status).toBe(201);
    const reopen = await patch(`/admin/skus/${a.body.id as string}`, { version: 1, archived: false });
    expect([...err(reopen), reopen.body.details?.field]).toEqual([409, 'VERSION_CONFLICT', 'scale_plu']);
    // mã vạch của SKU lưu trữ vẫn giữ (đơn vị chưa lưu trữ) — muốn dùng lại thì lưu trữ đơn vị
    expect(err(await sku({ sale_unit_type: 'PIECE_FIXED', barcode: '8930000000026' }))).toEqual([
      409,
      'VERSION_CONFLICT',
    ]);

    // review lát 2 C1: SKU lưu trữ + lưu trữ hết đơn vị bán vẫn mở lại được (mở lại / thêm đơn vị trước, rồi mở lại SKU)
    const z = await sku({ sale_unit_type: 'PIECE_FIXED' });
    const zid = z.body.id as string;
    const zbase = (z.body.units as { id: string }[])[0]?.id ?? '';
    expect((await patch(`/admin/skus/${zid}`, { version: 0, archived: true })).status).toBe(200);
    expect((await patch(`/admin/skus/${zid}/units/${zbase}`, { archived: true })).status).toBe(200);
    const stuck = await patch(`/admin/skus/${zid}`, { version: 1, archived: false });
    expect(err(stuck)).toEqual([422, 'CATALOG_RULE_VIOLATION']);
    // UPDATE đã chạy rồi mới kiểm ⇒ rollback: version không tăng
    expect((await get(`/admin/skus/${zid}`)).body).toMatchObject({ version: 1 });
    const added = await post(`/admin/skus/${zid}/units`, {
      unit_code: 'PACK',
      name: 'Hộp 2 quả',
      factor_units: 2,
      for_sale: true,
      for_purchase: false,
    });
    expect(added.status).toBe(201);
    expect((await patch(`/admin/skus/${zid}/units/${zbase}`, { archived: false })).status).toBe(200);
    const back = await patch(`/admin/skus/${zid}`, { version: 1, archived: false });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ version: 2, archived_at: null });
    // mã vạch sai số kiểm tra bị chặn cả khi sửa đơn vị đang lưu trữ
    expect(
      err(
        await patch(`/admin/skus/${zid}/units/${added.body.id as string}`, {
          archived: true,
          barcode: '8930000000027',
        }),
      ),
    ).toEqual([422, 'BARCODE_CHECKSUM_INVALID']);
  });

  it('sửa SKU: version lệch ⇒ 409; mã / kiểu bán / giá bất biến ở đây; audit trước–sau; sản phẩm lưu trữ ⇒ 422', async () => {
    const s = await sku({ shelf_life_days: 7 });
    const id = s.body.id as string;
    expect(err(await patch(`/admin/skus/${id}`, { version: 5, name: 'x' }))).toEqual([409, 'VERSION_CONFLICT']);
    for (const f of [{ sku_code: 'NEW' }, { sale_unit_type: 'PIECE_FIXED' }, { retail_price_per_kg: '1000' }])
      expect(err(await patch(`/admin/skus/${id}`, { version: 0, ...f }))).toEqual([400, 'INVALID_REQUEST']);
    expect(err(await patch(`/admin/skus/${id}`, { version: 0 }))).toEqual([400, 'INVALID_REQUEST']);
    // gộp với bản cũ: cảnh báo > hạn dùng đang có ⇒ 422
    expect(err(await patch(`/admin/skus/${id}`, { version: 0, alert_days_before_expiry: 8 }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    const ok = await patch(`/admin/skus/${id}`, {
      version: 0,
      name: 'Nho Mẫu Đơn HQ',
      has_ripeness: false,
      is_high_value: true,
      storage_note: 'Giữ lạnh 2–4°C',
    });
    expect(ok.status).toBe(200);
    expect(schemaErrors('Sku', ok.body)).toEqual([]);
    expect(ok.body).toMatchObject({
      version: 1,
      name: 'Nho Mẫu Đơn HQ',
      is_high_value: true,
      sku_code: s.body.sku_code,
    });
    const [, upd] = await audits(id);
    expect(upd?.action).toBe('sku.update');
    expect(upd?.before).toMatchObject({ version: 0, is_high_value: false });
    expect(upd?.after).toMatchObject({ version: 1, is_high_value: true });
    // không chuyển sang sản phẩm lưu trữ
    const p2 = await product();
    await patch(`/admin/products/${p2}`, { archived: true });
    expect(err(await patch(`/admin/skus/${id}`, { version: 1, product_id: p2 }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    // sản phẩm còn SKU đang dùng ⇒ không lưu trữ
    expect(err(await patch(`/admin/products/${s.body.product_id as string}`, { archived: true }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    expect(err(await get(`/admin/skus/${randomUUID()}`))).toEqual([404, 'RESOURCE_NOT_FOUND']);
  });

  it('đơn vị của SKU: còn ít nhất một đơn vị bán; trùng tên ⇒ 409; lưu trữ rồi mở lại kiểm trùng mã vạch', async () => {
    const s = await sku({ sale_unit_type: 'PIECE_FIXED' });
    const id = s.body.id as string;
    const base = (s.body.units as { id: string }[])[0]?.id ?? '';
    const pack = await post(`/admin/skus/${id}/units`, {
      unit_code: 'PACK',
      name: 'Hộp 4 quả',
      factor_units: 4,
      for_sale: true,
      for_purchase: false,
      barcode: '8930000000033',
    });
    expect(pack.status).toBe(201);
    expect(schemaErrors('SkuUnit', pack.body)).toEqual([]);
    expect(
      err(
        await post(`/admin/skus/${id}/units`, {
          unit_code: 'BAG',
          name: 'hộp 4 QUẢ ',
          factor_units: 4,
          for_sale: true,
          for_purchase: false,
        }),
      ),
    ).toEqual([409, 'VERSION_CONFLICT']);
    // hệ số / mã đơn vị bất biến
    expect(err(await patch(`/admin/skus/${id}/units/${base}`, { factor_units: 2 }))).toEqual([400, 'INVALID_REQUEST']);
    // lưu trữ đơn vị gốc được vì còn hộp để bán; tắt bán hộp nữa ⇒ 422
    expect((await patch(`/admin/skus/${id}/units/${base}`, { archived: true })).status).toBe(200);
    expect(err(await patch(`/admin/skus/${id}/units/${pack.body.id as string}`, { for_sale: false }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    // lưu trữ hộp ⇒ mã vạch dùng lại được; mở lại hộp cũ ⇒ 409
    expect(err(await patch(`/admin/skus/${id}/units/${pack.body.id as string}`, { archived: true }))).toEqual([
      422,
      'CATALOG_RULE_VIOLATION',
    ]);
    expect((await patch(`/admin/skus/${id}/units/${base}`, { archived: false })).status).toBe(200);
    expect((await patch(`/admin/skus/${id}/units/${pack.body.id as string}`, { archived: true })).status).toBe(200);
    expect((await sku({ sale_unit_type: 'PIECE_FIXED', barcode: '8930000000033' })).status).toBe(201);
    const re = await patch(`/admin/skus/${id}/units/${pack.body.id as string}`, { archived: false });
    expect([...err(re), re.body.details?.field]).toEqual([409, 'VERSION_CONFLICT', 'barcode']);
    // đơn vị của SKU khác ⇒ 404
    expect(err(await patch(`/admin/skus/${randomUUID()}/units/${base}`, { name: 'x' }))).toEqual([
      404,
      'RESOURCE_NOT_FOUND',
    ]);
    const g = await get(`/admin/skus/${id}`);
    expect(schemaErrors('Sku', g.body)).toEqual([]);
    expect((await audits(pack.body.id as string)).map((x) => x.action)).toEqual(['sku_unit.create', 'sku_unit.update']);
  });

  it('danh sách SKU: lọc + phân trang theo mã; tìm theo mã vạch / PLU', async () => {
    const prod = await product();
    const tag = hex(2);
    for (let i = 0; i < 5; i++) {
      const r = await post('/admin/skus', {
        product_id: prod,
        sku_code: `PG${tag}-${i}`,
        name: `Trang ${i}`,
        sale_unit_type: 'PIECE_FIXED',
        ...(i === 3 ? { barcode: `BC${tag}` } : {}),
      });
      expect(r.status).toBe(201);
    }
    const p1 = await get(`/admin/skus?product_id=${prod}&limit=2`);
    expect(p1.status).toBe(200);
    expect(schemaErrors('SkuList', p1.body)).toEqual([]);
    expect(p1.body.items.map((x: { sku_code: string }) => x.sku_code)).toEqual([`PG${tag}-0`, `PG${tag}-1`]);
    const p3 = await get(`/admin/skus?product_id=${prod}&limit=2&after=${p1.body.next_after as string}`);
    const p4 = await get(`/admin/skus?product_id=${prod}&limit=2&after=${p3.body.next_after as string}`);
    expect(p4.body.items.map((x: { sku_code: string }) => x.sku_code)).toEqual([`PG${tag}-4`]);
    expect(p4.body.next_after).toBeNull();
    const byBar = await get(`/admin/skus?q=bc${tag.toLowerCase()}`);
    expect(byBar.body.items.map((x: { sku_code: string }) => x.sku_code)).toEqual([`PG${tag}-3`]);
    expect(err(await get('/admin/skus?limit=501'))).toEqual([400, 'INVALID_REQUEST']);
  });

  it('quyền: cửa hàng trưởng chỉ đọc danh mục (catalog:read); ghi ⇒ 403', async () => {
    const sm = await storeManagerClient();
    expect((await sm.get('/admin/skus')).status).toBe(200);
    expect((await sm.get('/admin/units')).status).toBe(200);
    expect((await sm.post('/admin/categories', { name: 'x' })).status).toBe(403);
    expect((await sm.post('/admin/units', { code: 'XX', name: 'x', kind: 'COUNT' })).status).toBe(403);
    expect((await http().get('/v1/admin/skus')).status).toBe(401);
  });
  it('trùng đi qua index (dòng song song chưa commit, kiểm trước không thấy) ⇒ 409 kèm trường; tìm kiếm thoát % và _', async () => {
    /** owner giữ INSERT chưa commit ⇒ API INSERT chờ index ⇒ owner COMMIT ⇒ API nhận 23505 */
    async function racing(
      holdSql: string,
      holdParams: unknown[],
      call: () => Promise<{ status: number; body: { code?: string; details?: { field?: string } } }>,
    ) {
      const c = new Client({ connectionString: db.ownerUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(holdSql, holdParams);
        const pending = call();
        // chờ API chạm tới INSERT và bị chặn bởi khóa của index
        for (let i = 0; i < 50; i++) {
          const w = await rows(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND usename = 'app_rw'`,
          );
          if ((w[0]?.n as number) > 0) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        await c.query('COMMIT');
        const r = await pending;
        return [r.status, r.body.code, r.body.details?.field];
      } finally {
        await c.end();
      }
    }
    const prod = await product();
    const p = plu();
    expect(
      await racing(
        `INSERT INTO core.skus (id, product_id, sku_code, name, sale_unit_type, scale_plu) VALUES ($1, $2, $3, $3, 'WEIGHT', $4)`,
        [randomUUID(), prod, `RACE-${hex()}`, p],
        () =>
          post('/admin/skus', {
            product_id: prod,
            sku_code: `RACE-${hex()}`,
            name: 'x',
            sale_unit_type: 'WEIGHT',
            scale_plu: p,
          }),
      ),
    ).toEqual([409, 'VERSION_CONFLICT', 'scale_plu']);
    const root = await category();
    const nm = `DM ${hex()}`;
    expect(
      await racing(
        `INSERT INTO core.categories (id, parent_id, name) VALUES ($1, $2, $3)`,
        [randomUUID(), root, nm],
        () => post('/admin/categories', { parent_id: root, name: nm }),
      ),
    ).toEqual([409, 'VERSION_CONFLICT', 'name']);
    const s = await sku({ sale_unit_type: 'PIECE_FIXED' });
    expect(
      await racing(
        `INSERT INTO core.sku_units (id, sku_id, unit_code, name, factor_units, for_sale) VALUES ($1, $2, 'PACK', 'Hộp 3', 3, true)`,
        [randomUUID(), s.body.id],
        () =>
          post(`/admin/skus/${s.body.id as string}/units`, {
            unit_code: 'BAG',
            name: 'Hộp 3',
            factor_units: 3,
            for_sale: true,
            for_purchase: false,
          }),
      ),
    ).toEqual([409, 'VERSION_CONFLICT', 'name']);

    // ký tự đại diện LIKE được thoát: "%" / "_" không khớp mọi SKU
    expect((await get('/admin/skus?q=%25')).body.items).toEqual([]);
    expect((await get('/admin/skus?q=_')).body.items).toEqual([]);
    const tag = hex(2);
    const under = await sku({ sku_code: `U_${tag}`, name: `Giảm 100% ${tag}` });
    expect(under.status).toBe(201);
    await sku({ sku_code: `UX${tag}` });
    expect((await get(`/admin/skus?q=u_${tag.toLowerCase()}`)).body.items.map((x: { id: string }) => x.id)).toEqual([
      under.body.id,
    ]);
    expect(
      (await get(`/admin/skus?q=${encodeURIComponent(`100% ${tag}`)}`)).body.items.map((x: { id: string }) => x.id),
    ).toEqual([under.body.id]);
    expect((await get('/admin/products?q=_')).body.items).toEqual([]);
  });

  it('song song: tạo con dưới P cùng lúc đổi cha của P ⇒ không deadlock (khóa cây trước khóa dòng)', async () => {
    for (let round = 0; round < 8; round++) {
      const x = await category();
      const p = await category();
      const rs = await Promise.all([
        post('/admin/categories', { parent_id: p, name: `A ${hex()}` }),
        patch(`/admin/categories/${p}`, { parent_id: x }),
        post('/admin/categories', { parent_id: p, name: `B ${hex()}` }),
      ]);
      expect(rs.map((r) => r.status)).toEqual([201, 200, 201]);
    }
  });
});
