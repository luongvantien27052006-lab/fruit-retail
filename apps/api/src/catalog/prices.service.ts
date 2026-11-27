import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import { v7 as uuidv7 } from 'uuid';
import type { Principal } from '../common/access';
import { AuditOutboxService, type Tx } from '../common/audit-outbox.service';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { ScopeService } from '../common/scope.service';
import { Prisma, type Sku, type SkuUnit } from '../generated/prisma/client';
import { catalogWrite } from './catalog-db';
import { rule, type SaleUnitType, WEIGHT_PRICED } from './catalog-rules';

/** Trần giá mọi cột giá (CHECK 0009: BETWEEN 1 AND 1 tỷ đồng) */
export const PRICE_MAX = 1_000_000_000n;

export interface PriceChange {
  /** giá lẻ chung (giá/kg cho hàng cân, giá/đơn vị cho hàng đếm) — không bỏ được */
  global?: bigint;
  /** giá riêng cửa hàng; null = bỏ giá riêng (về giá chung) */
  stores?: { store_id: string; price: bigint | null }[];
  /** giá riêng của đơn vị bán (hộp 500 g…); null = bỏ (tính theo giá SKU) */
  units?: { sku_unit_id: string; price: bigint | null }[];
}
export interface PriceSet extends PriceChange {
  version: number;
}

type Field = 'PER_KG' | 'PER_UNIT' | 'SKU_UNIT';
interface LogRow {
  skuId: string;
  scope: 'GLOBAL' | 'STORE';
  field: Field;
  storeId: string | null;
  skuUnitId: string | null;
  oldValue: bigint | null;
  newValue: bigint | null;
}

/** timestamptz ⇒ ISO-8601 UTC đủ micro-giây (Date của JS cắt còn mili-giây) */
const ISO_US = (col: string) => Prisma.raw(`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

const notFound = () => new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy SKU');
const fieldOf = (t: SaleUnitType): 'PER_KG' | 'PER_UNIT' => (WEIGHT_PRICED.has(t) ? 'PER_KG' : 'PER_UNIT');

/** Giá phải là số nguyên đồng 1 … 1 tỷ (âm / 0 / quá trần ⇒ 422 — cổng lát 3). */
function assertPrice(v: bigint, field: string): void {
  if (v < 1n || v > PRICE_MAX)
    throw rule('Giá phải từ 1 đến 1.000.000.000 đồng', { field, reason: v < 1n ? 'NOT_POSITIVE' : 'ABOVE_MAX' });
}

/**
 * Giá lẻ (CP04 lát 3, §4.4): giá chung của SKU, giá riêng theo cửa hàng (`store_prices`), giá riêng của đơn vị bán.
 * Mọi thay đổi ghi `price_change_logs` CÙNG transaction (ai, khi nào — mốc server, cũ → mới, lý do); constraint trigger
 * hoãn của 0009 rollback nếu giá và lịch sử lệch nhau. Thứ tự khóa (ERD §6.2): skus (sku_id tăng dần) → sku_units (id) →
 * store_prices (store_id) → INSERT price_change_logs. Đổi giá tăng `skus.version` (POS/app đồng bộ thấy thay đổi).
 * Giá thực thu là giá CHỤP trên dòng bán lúc giao dịch ⇒ đổi giá chỉ áp cho giao dịch mới (`effectiveAt`).
 */
@Injectable()
export class PricesService {
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly ao: AuditOutboxService,
    private readonly cls: ClsService<RequestStore>,
    private readonly scope: ScopeService,
  ) {}

  private get tx() {
    return this.txHost.tx;
  }

  private principal(): Principal {
    const p = this.cls.get('principal');
    if (!p) throw new AppError('AUTHENTICATION_REQUIRED', 'Cần đăng nhập');
    return p;
  }

  // ───────── đọc ─────────

  /** Đọc bằng SQL thô cần transaction (tx-prisma); REPEATABLE READ ⇒ mọi bước tra cùng một snapshot (review TS N2). */
  private readTx<T>(fn: () => Promise<T>): Promise<T> {
    return this.txHost.withTransaction({ isolationLevel: 'RepeatableRead' }, fn);
  }

  /** Giá hiện hành; giá riêng cửa hàng chỉ của các cửa hàng trong phạm vi `price:read` (x-scope: store — ADR-024). */
  async current(skuId: string) {
    const s = await this.tx.sku.findUnique({ where: { id: skuId }, include: { units: true, storePrices: true } });
    if (!s) throw notFound();
    const sc = await this.scope.stores('price:read');
    return this.wire(s, s.units, sc === 'ALL' ? s.storePrices : s.storePrices.filter((p) => sc.has(p.storeId)));
  }

  private wire(
    s: Sku,
    units: SkuUnit[],
    stores: {
      storeId: string;
      retailPricePerKg: bigint | null;
      retailPricePerUnit: bigint | null;
      updatedAt: Date;
    }[],
  ) {
    const f = fieldOf(s.saleUnitType as SaleUnitType);
    const pick = (kg: bigint | null, unit: bigint | null) => (f === 'PER_KG' ? kg : unit);
    return {
      sku_id: s.id,
      sale_unit_type: s.saleUnitType,
      price_field: f,
      version: s.version,
      global: pick(s.retailPricePerKg, s.retailPricePerUnit),
      stores: [...stores]
        .sort((a, b) => a.storeId.localeCompare(b.storeId))
        .map((p) => ({
          store_id: p.storeId,
          price: pick(p.retailPricePerKg, p.retailPricePerUnit),
          updated_at: p.updatedAt,
        })),
      units: [...units]
        .filter((u) => u.archivedAt === null || u.pricePerUnit !== null)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
        .map((u) => ({
          sku_unit_id: u.id,
          name: u.name,
          for_sale: u.forSale,
          archived_at: u.archivedAt,
          price: u.pricePerUnit,
        })),
    };
  }

  /**
   * Lịch sử giá (mới → cũ). Con trỏ `before` = id bản ghi cuối trang trước; so (changed_at, id) HOÀN TOÀN trong SQL —
   * Date của JS chỉ tới mili-giây, changed_at tới micro-giây (review TS lát 3 C1: cắt mili-giây làm mất bản ghi).
   */
  history(skuId: string, q: { store_id?: string; field?: Field; limit: number; before?: string }) {
    return this.readTx(() => this.historyTx(skuId, q));
  }

  private async historyTx(skuId: string, q: { store_id?: string; field?: Field; limit: number; before?: string }) {
    if (!(await this.tx.sku.findUnique({ where: { id: skuId }, select: { id: true } }))) throw notFound();
    if (q.before) {
      const b = await this.tx.priceChangeLog.findFirst({ where: { id: q.before, skuId }, select: { id: true } });
      if (!b) throw new AppError('INVALID_REQUEST', 'Con trỏ trang không hợp lệ', { field: 'before' });
    }
    const rows = await this.tx.$queryRaw<
      {
        id: string;
        scope: 'GLOBAL' | 'STORE';
        field: Field;
        store_id: string | null;
        sku_unit_id: string | null;
        old_value: bigint | null;
        new_value: bigint | null;
        reason: string;
        changed_by: string;
        changed_at: string;
      }[]
    >`
      SELECT l.id::text, l.scope::text AS scope, l.field::text AS field, l.store_id::text, l.sku_unit_id::text,
             l.old_value, l.new_value, l.reason, l.changed_by::text, ${ISO_US('l.changed_at')} AS changed_at
      FROM core.price_change_logs l
      WHERE l.sku_id = ${skuId}::uuid
        AND (${q.store_id ?? null}::uuid IS NULL OR l.store_id = ${q.store_id ?? null}::uuid)
        AND (${q.field ?? null}::text IS NULL OR l.field::text = ${q.field ?? null}::text)
        AND (${q.before ?? null}::uuid IS NULL OR (l.changed_at, l.id) <
             (SELECT b.changed_at, b.id FROM core.price_change_logs b WHERE b.id = ${q.before ?? null}::uuid))
      ORDER BY l.changed_at DESC, l.id DESC
      LIMIT ${q.limit + 1}`;
    const more = rows.length > q.limit;
    const page = more ? rows.slice(0, q.limit) : rows;
    return { items: page, next_before: more ? (page[page.length - 1]?.id ?? null) : null };
  }

  /**
   * Giá lẻ HIỆU LỰC tại thời điểm `at` — nguồn cho POS/app khi tạo dòng bán: giá riêng đơn vị (nếu đơn vị có) → giá riêng
   * cửa hàng → giá chung. Dựng lại từ `price_change_logs` (changed_at ≤ at, so trong SQL đủ micro-giây) nên trả đúng giá
   * cũ cho thời điểm trước lần đổi (đổi giá không hồi tố). Không truyền `at` ⇒ bản ghi mới nhất đã COMMIT (= giá hiện hành,
   * constraint price_log_required bảo đảm khớp) — không dùng giờ máy app. MỘT câu lệnh ⇒ một snapshot.
   */
  effectiveAt(skuId: string, q: { store_id?: string; sku_unit_id?: string; at?: string }) {
    return this.readTx(() => this.effectiveTx(skuId, q));
  }

  private async effectiveTx(skuId: string, q: { store_id?: string; sku_unit_id?: string; at?: string }) {
    const s = await this.tx.sku.findUnique({ where: { id: skuId }, select: { saleUnitType: true } });
    if (!s) throw notFound();
    // nhân viên trên máy POS: mặc định cửa hàng của thiết bị (quên store_id không được ra giá chung — review bảo mật G8)
    const pos = this.cls.get('principal')?.posStoreId;
    if (!q.store_id && pos) q = { ...q, store_id: pos };
    if (q.store_id) {
      // cửa hàng ngoài phạm vi / không tồn tại ⇒ 404 (không lộ giá riêng cửa hàng khác — ADR-024)
      await this.scope.assertStore('price:read', q.store_id);
      if (!(await this.tx.store.findUnique({ where: { id: q.store_id }, select: { id: true } })))
        throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy cửa hàng');
    }
    if (q.sku_unit_id) {
      const u = await this.tx.skuUnit.findFirst({ where: { id: q.sku_unit_id, skuId }, select: { id: true } });
      if (!u) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy đơn vị của SKU');
    }
    const f = fieldOf(s.saleUnitType as SaleUnitType);
    const at = q.at ?? null;
    const unit = q.sku_unit_id ?? null;
    const store = q.store_id ?? null;
    const [r] = await this.tx.$queryRaw<
      {
        at: string;
        u_val: bigint | null;
        u_at: string | null;
        s_val: bigint | null;
        s_at: string | null;
        g_val: bigint | null;
        g_at: string | null;
      }[]
    >`
      WITH k AS (SELECT COALESCE(${at}::timestamptz, 'infinity'::timestamptz) AS lim,
                        COALESCE(${at}::timestamptz, clock_timestamp()) AS at)
      SELECT ${ISO_US('k.at')} AS at,
             u.new_value AS u_val, ${ISO_US('u.changed_at')} AS u_at,
             st.new_value AS s_val, ${ISO_US('st.changed_at')} AS s_at,
             g.new_value AS g_val, ${ISO_US('g.changed_at')} AS g_at
      FROM k
      LEFT JOIN LATERAL (SELECT l.new_value, l.changed_at FROM core.price_change_logs l
        WHERE ${unit}::uuid IS NOT NULL AND l.sku_id = ${skuId}::uuid AND l.field = 'SKU_UNIT'
          AND l.sku_unit_id = ${unit}::uuid AND l.changed_at <= k.lim
        ORDER BY l.changed_at DESC, l.id DESC LIMIT 1) u ON true
      LEFT JOIN LATERAL (SELECT l.new_value, l.changed_at FROM core.price_change_logs l
        WHERE ${store}::uuid IS NOT NULL AND l.sku_id = ${skuId}::uuid AND l.field = ${f}::core."PriceField"
          AND l.store_id = ${store}::uuid AND l.changed_at <= k.lim
        ORDER BY l.changed_at DESC, l.id DESC LIMIT 1) st ON true
      LEFT JOIN LATERAL (SELECT l.new_value, l.changed_at FROM core.price_change_logs l
        WHERE l.sku_id = ${skuId}::uuid AND l.field = ${f}::core."PriceField" AND l.store_id IS NULL
          AND l.changed_at <= k.lim
        ORDER BY l.changed_at DESC, l.id DESC LIMIT 1) g ON true`;
    if (!r) throw new Error('effectiveAt: không có dòng');
    if (r.u_val !== null)
      return { at: r.at, field: 'SKU_UNIT' as const, source: 'SKU_UNIT' as const, price: r.u_val, changed_at: r.u_at };
    if (r.s_val !== null) return { at: r.at, field: f, source: 'STORE' as const, price: r.s_val, changed_at: r.s_at };
    if (r.g_val !== null) return { at: r.at, field: f, source: 'GLOBAL' as const, price: r.g_val, changed_at: r.g_at };
    return { at: r.at, field: f, source: 'NONE' as const, price: null, changed_at: null };
  }

  // ───────── ghi ─────────

  /** Đặt giá một SKU (khóa dòng SKU trước). */
  async set(skuId: string, b: PriceSet, reason: string) {
    const out = await this.apply(skuId, b);
    await this.writeLogs(out.logs, reason);
    await this.ao.recordAudit({
      action: 'price.set',
      resourceType: 'sku',
      resourceId: skuId,
      reason,
      before: { version: b.version },
      after: { version: out.version, changes: out.changes },
    });
    return out.prices;
  }

  /** Đổi giá hàng loạt (step-up): khóa SKU theo sku_id tăng dần ⇒ hai lô song song không khóa chéo. */
  async setMany(items: ({ sku_id: string } & PriceSet)[], reason: string) {
    const seen = new Set<string>();
    for (const i of items) {
      if (seen.has(i.sku_id)) throw new AppError('INVALID_REQUEST', 'Trùng SKU trong lô', { sku_id: i.sku_id });
      seen.add(i.sku_id);
    }
    const sorted = [...items].sort((a, b) => a.sku_id.localeCompare(b.sku_id));
    // khóa hết dòng SKU theo thứ tự trước khi ghi (một lô = một transaction)
    const ids = sorted.map((i) => i.sku_id);
    const locked = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM core.skus WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
    if (locked.length !== ids.length) {
      const have = new Set(locked.map((r) => r.id));
      throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy SKU', { sku_id: ids.find((x) => !have.has(x)) });
    }
    const results = [];
    const pending: LogRow[] = [];
    let changes = 0;
    for (const i of sorted) {
      const r = await this.apply(i.sku_id, i);
      changes += r.changes.length;
      pending.push(...r.logs);
      results.push(r.prices);
    }
    await this.writeLogs(pending, reason);
    await this.ao.recordAudit({
      action: 'price.set_bulk',
      resourceType: 'sku',
      reason,
      after: { skus: ids.length, changes, sku_ids: ids },
    });
    return { items: results };
  }

  /**
   * Ghi lịch sử CUỐI transaction, sau khi mọi dòng giá đã khóa và ghi (ERD §6.2). changed_at = mốc server lúc INSERT (trigger)
   * ⇒ cách lúc COMMIT ≤ phần còn lại của transaction: ghi cuối để sai số nhỏ nhất (review bảo mật lát 3 N1).
   */
  private async writeLogs(logs: LogRow[], reason: string): Promise<void> {
    if (!logs.length) return;
    const p = this.principal();
    await catalogWrite(async () => {
      for (const l of logs)
        await this.tx.priceChangeLog.create({ data: { id: uuidv7(), ...l, reason, changedBy: p.userId } });
    });
  }

  private async apply(skuId: string, b: PriceSet) {
    const p = this.principal();
    const lk = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM core.skus WHERE id = ${skuId}::uuid FOR NO KEY UPDATE`;
    if (!lk.length) throw notFound();
    const sku = await this.tx.sku.findUniqueOrThrow({ where: { id: skuId } });
    if (sku.version !== b.version)
      throw new AppError('VERSION_CONFLICT', 'SKU đã được sửa bởi người khác — tải lại', {
        reason: 'VERSION',
        sku_id: skuId,
        current_version: sku.version,
      });
    if (sku.archivedAt) throw rule('SKU đã lưu trữ — không đổi giá', { sku_id: skuId });
    const t = sku.saleUnitType as SaleUnitType;
    const f = fieldOf(t);
    const logs: LogRow[] = [];

    // 1) giá chung (dòng skus đã khóa)
    const curGlobal = f === 'PER_KG' ? sku.retailPricePerKg : sku.retailPricePerUnit;
    if (b.global !== undefined) {
      assertPrice(b.global, 'global');
      if (b.global !== curGlobal)
        logs.push({
          skuId,
          scope: 'GLOBAL',
          field: f,
          storeId: null,
          skuUnitId: null,
          oldValue: curGlobal,
          newValue: b.global,
        });
    }

    // 2) đơn vị (id tăng dần)
    const unitReq = [...(b.units ?? [])].sort((x, y) => x.sku_unit_id.localeCompare(y.sku_unit_id));
    if (new Set(unitReq.map((u) => u.sku_unit_id)).size !== unitReq.length)
      throw new AppError('INVALID_REQUEST', 'Trùng đơn vị trong yêu cầu', { field: 'units' });
    const unitUpdates: { id: string; price: bigint | null }[] = [];
    if (unitReq.length) {
      const uids = unitReq.map((u) => u.sku_unit_id);
      await this.tx.$queryRaw`
        SELECT id FROM core.sku_units WHERE id = ANY(${uids}::uuid[]) AND sku_id = ${skuId}::uuid ORDER BY id FOR NO KEY UPDATE`;
      const units = await this.tx.skuUnit.findMany({ where: { id: { in: uids }, skuId }, include: { unit: true } });
      for (const r of unitReq) {
        const u = units.find((x) => x.id === r.sku_unit_id);
        if (!u)
          throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy đơn vị của SKU', { sku_unit_id: r.sku_unit_id });
        if (r.price !== null) {
          assertPrice(r.price, 'units.price');
          if (u.archivedAt) throw rule('Đơn vị đã lưu trữ — không đặt giá', { sku_unit_id: u.id });
          if (!u.forSale) throw rule('Đơn vị không để bán — không đặt giá', { sku_unit_id: u.id });
          // một nguồn giá (khớp trigger sku_units_kind_guard): đơn vị gốc / quả theo cân dùng giá SKU
          if (
            t === 'PIECE_BY_WEIGHT' ||
            (WEIGHT_PRICED.has(t) && u.unit.kind === 'WEIGHT') ||
            (!WEIGHT_PRICED.has(t) && u.factorUnits === 1)
          )
            throw rule('Đơn vị gốc / quả theo cân dùng giá của SKU — không đặt giá riêng', { sku_unit_id: u.id });
        }
        if (r.price !== u.pricePerUnit) {
          unitUpdates.push({ id: u.id, price: r.price });
          logs.push({
            skuId,
            scope: 'GLOBAL',
            field: 'SKU_UNIT',
            storeId: null,
            skuUnitId: u.id,
            oldValue: u.pricePerUnit,
            newValue: r.price,
          });
        }
      }
    }

    // 3) giá cửa hàng (store_id tăng dần)
    const storeReq = [...(b.stores ?? [])].sort((x, y) => x.store_id.localeCompare(y.store_id));
    if (new Set(storeReq.map((s) => s.store_id)).size !== storeReq.length)
      throw new AppError('INVALID_REQUEST', 'Trùng cửa hàng trong yêu cầu', { field: 'stores' });
    const storeOps: { storeId: string; price: bigint | null; exists: boolean }[] = [];
    if (storeReq.length) {
      const sids = storeReq.map((s) => s.store_id);
      // FOR SHARE: chặn lưu trữ cửa hàng song song (thứ tự: skus → sku_units → stores → store_prices)
      const stores = await this.tx.$queryRaw<{ id: string; archived: boolean }[]>`
        SELECT id::text, archived_at IS NOT NULL AS archived FROM core.stores WHERE id = ANY(${sids}::uuid[]) ORDER BY id FOR SHARE`;
      await this.tx.$queryRaw`
        SELECT store_id FROM core.store_prices WHERE sku_id = ${skuId}::uuid AND store_id = ANY(${sids}::uuid[])
        ORDER BY store_id FOR UPDATE`;
      const cur = await this.tx.storePrice.findMany({ where: { skuId, storeId: { in: sids } } });
      for (const r of storeReq) {
        const st = stores.find((x) => x.id === r.store_id);
        if (!st) throw rule('Cửa hàng không tồn tại', { store_id: r.store_id });
        const row = cur.find((x) => x.storeId === r.store_id);
        const old = row ? (f === 'PER_KG' ? row.retailPricePerKg : row.retailPricePerUnit) : null;
        if (r.price !== null) {
          assertPrice(r.price, 'stores.price');
          if (st.archived) throw rule('Cửa hàng đã lưu trữ — không đặt giá riêng', { store_id: r.store_id });
        }
        if (r.price !== old) {
          storeOps.push({ storeId: r.store_id, price: r.price, exists: !!row });
          logs.push({
            skuId,
            scope: 'STORE',
            field: f,
            storeId: r.store_id,
            skuUnitId: null,
            oldValue: old,
            newValue: r.price,
          });
        }
      }
    }

    if (logs.length) {
      await catalogWrite(async () => {
        await this.tx.sku.update({
          where: { id: skuId },
          data: {
            ...(b.global !== undefined && b.global !== curGlobal
              ? f === 'PER_KG'
                ? { retailPricePerKg: b.global }
                : { retailPricePerUnit: b.global }
              : {}),
            version: { increment: 1 },
          },
        });
        for (const u of unitUpdates)
          await this.tx.skuUnit.update({ where: { id: u.id }, data: { pricePerUnit: u.price } });
        for (const o of storeOps) {
          const val = f === 'PER_KG' ? { retailPricePerKg: o.price } : { retailPricePerUnit: o.price };
          if (o.price === null)
            await this.tx.storePrice.delete({ where: { storeId_skuId: { storeId: o.storeId, skuId } } });
          else if (o.exists)
            await this.tx.storePrice.update({
              where: { storeId_skuId: { storeId: o.storeId, skuId } },
              data: { ...val, updatedBy: p.userId },
            });
          else await this.tx.storePrice.create({ data: { storeId: o.storeId, skuId, ...val, updatedBy: p.userId } });
        }
      });
    }
    const fresh = await this.tx.sku.findUniqueOrThrow({
      where: { id: skuId },
      include: { units: true, storePrices: true },
    });
    return {
      version: fresh.version,
      logs,
      changes: logs.map((l) => ({
        field: l.field,
        store_id: l.storeId,
        sku_unit_id: l.skuUnitId,
        old_value: l.oldValue,
        new_value: l.newValue,
      })),
      prices: this.wire(fresh, fresh.units, fresh.storePrices),
    };
  }
}
