import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import { v7 as uuidv7 } from 'uuid';
import type { Principal } from '../common/access';
import { AuditOutboxService, type Tx } from '../common/audit-outbox.service';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import type { Sku, SkuUnit } from '../generated/prisma/client';
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
  scope: 'GLOBAL' | 'STORE';
  field: Field;
  storeId: string | null;
  skuUnitId: string | null;
  oldValue: bigint | null;
  newValue: bigint | null;
}

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

  async current(skuId: string) {
    const s = await this.tx.sku.findUnique({ where: { id: skuId }, include: { units: true, storePrices: true } });
    if (!s) throw notFound();
    return this.wire(s, s.units, s.storePrices);
  }

  private wire(
    s: Sku,
    units: SkuUnit[],
    stores: {
      storeId: string;
      retailPricePerKg: bigint | null;
      retailPricePerUnit: bigint | null;
      updatedAt: Date;
      updatedBy: string;
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
          updated_by: p.updatedBy,
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

  async history(skuId: string, q: { store_id?: string; field?: Field; limit: number; before?: string }) {
    if (!(await this.tx.sku.findUnique({ where: { id: skuId }, select: { id: true } }))) throw notFound();
    let beforeAt: Date | undefined;
    if (q.before) {
      const b = await this.tx.priceChangeLog.findFirst({ where: { id: q.before, skuId }, select: { changedAt: true } });
      if (!b) throw new AppError('INVALID_REQUEST', 'Con trỏ trang không hợp lệ', { field: 'before' });
      beforeAt = b.changedAt;
    }
    const rows = await this.tx.priceChangeLog.findMany({
      where: {
        skuId,
        ...(q.store_id ? { storeId: q.store_id } : {}),
        ...(q.field ? { field: q.field } : {}),
        ...(beforeAt && q.before
          ? { OR: [{ changedAt: { lt: beforeAt } }, { changedAt: beforeAt, id: { lt: q.before } }] }
          : {}),
      },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const more = rows.length > q.limit;
    const page = more ? rows.slice(0, q.limit) : rows;
    return {
      items: page.map((l) => ({
        id: l.id,
        scope: l.scope,
        field: l.field,
        store_id: l.storeId,
        sku_unit_id: l.skuUnitId,
        old_value: l.oldValue,
        new_value: l.newValue,
        reason: l.reason,
        changed_by: l.changedBy,
        changed_at: l.changedAt,
      })),
      next_before: more ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /** Giá mới nhất của một khóa giá tại thời điểm `at` (bản ghi lịch sử changed_at ≤ at). undefined = chưa từng có. */
  private async logAt(skuId: string, storeId: string | null, field: Field, unitId: string | null, at: Date) {
    const r = await this.tx.priceChangeLog.findFirst({
      where: { skuId, storeId, field, skuUnitId: unitId, changedAt: { lte: at } },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      select: { newValue: true, changedAt: true },
    });
    return r ?? undefined;
  }

  /**
   * Giá lẻ HIỆU LỰC tại thời điểm `at` (mặc định: bây giờ) — nguồn cho POS/app khi tạo dòng bán: giá riêng đơn vị (nếu
   * đơn vị có) → giá riêng cửa hàng → giá chung. Dựng lại từ `price_change_logs` nên trả đúng giá cũ cho thời điểm trước
   * lần đổi (đổi giá không hồi tố).
   */
  async effectiveAt(skuId: string, q: { store_id?: string; sku_unit_id?: string; at?: Date }) {
    const s = await this.tx.sku.findUnique({ where: { id: skuId }, select: { saleUnitType: true } });
    if (!s) throw notFound();
    const at = q.at ?? new Date();
    const f = fieldOf(s.saleUnitType as SaleUnitType);
    if (q.sku_unit_id) {
      const u = await this.tx.skuUnit.findFirst({ where: { id: q.sku_unit_id, skuId }, select: { id: true } });
      if (!u) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy đơn vị của SKU');
      const own = await this.logAt(skuId, null, 'SKU_UNIT', q.sku_unit_id, at);
      if (own?.newValue != null)
        return {
          at,
          field: 'SKU_UNIT' as const,
          source: 'SKU_UNIT' as const,
          price: own.newValue,
          changed_at: own.changedAt,
        };
    }
    if (q.store_id) {
      const st = await this.logAt(skuId, q.store_id, f, null, at);
      if (st?.newValue != null)
        return { at, field: f, source: 'STORE' as const, price: st.newValue, changed_at: st.changedAt };
    }
    const g = await this.logAt(skuId, null, f, null, at);
    if (g?.newValue != null)
      return { at, field: f, source: 'GLOBAL' as const, price: g.newValue, changed_at: g.changedAt };
    return { at, field: f, source: 'NONE' as const, price: null, changed_at: null };
  }

  // ───────── ghi ─────────

  /** Đặt giá một SKU (khóa dòng SKU trước). */
  async set(skuId: string, b: PriceSet, reason: string) {
    const out = await this.apply(skuId, b, reason);
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
    let changes = 0;
    for (const i of sorted) {
      const r = await this.apply(i.sku_id, i, reason);
      changes += r.changes.length;
      results.push(r.prices);
    }
    await this.ao.recordAudit({
      action: 'price.set_bulk',
      resourceType: 'sku',
      reason,
      after: { skus: ids.length, changes, sku_ids: ids },
    });
    return { items: results };
  }

  private async apply(skuId: string, b: PriceSet, reason: string) {
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
      const stores = await this.tx.store.findMany({
        where: { id: { in: sids } },
        select: { id: true, archivedAt: true },
      });
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
          if (st.archivedAt) throw rule('Cửa hàng đã lưu trữ — không đặt giá riêng', { store_id: r.store_id });
        }
        if (r.price !== old) {
          storeOps.push({ storeId: r.store_id, price: r.price, exists: !!row });
          logs.push({
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
        // lịch sử SAU khi đã khóa và ghi dòng giá (ERD §6.2); changed_at do trigger đặt (mốc server, tăng nghiêm ngặt)
        for (const l of logs)
          await this.tx.priceChangeLog.create({
            data: { id: uuidv7(), skuId, ...l, reason, changedBy: p.userId },
          });
      });
    }
    const fresh = await this.tx.sku.findUniqueOrThrow({
      where: { id: skuId },
      include: { units: true, storePrices: true },
    });
    return {
      version: fresh.version,
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
