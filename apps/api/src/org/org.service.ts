import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { v7 as uuidv7 } from 'uuid';
import { AuditOutboxService, type Tx } from '../common/audit-outbox.service';
import { findSqlState } from '../common/db-errors';
import { AppError } from '../common/errors';
import { ScopeService } from '../common/scope.service';
import { catalogWrite } from '../catalog/catalog-db';
import { rule } from '../catalog/catalog-rules';
import { Prisma } from '../generated/prisma/client';
import { locationWire, registerWire, storeWire, warehouseWire } from './org-wire';

export type OpeningHours = Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', [string, string][]>>;
export type LocationKind = 'STORAGE' | 'COLD_ROOM' | 'SHELF' | 'CHILLER' | 'RIPENING';

export interface StoreCreate {
  code: string;
  name: string;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  opening_hours?: OpeningHours | null;
  app_capacity_per_hour?: number | null;
}
export interface StoreUpdate {
  name?: string;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  opening_hours?: OpeningHours | null;
  status?: 'ACTIVE' | 'INACTIVE';
  pos_status?: 'OPEN' | 'CLOSED';
  app_status?: 'ONLINE' | 'PAUSED';
  app_capacity_per_hour?: number | null;
  archived?: boolean;
}

/** Địa chỉ cửa hàng / kho là dữ liệu công khai (không che trong audit — json-safe mặc định che `address`). */
const PUBLIC = ['address'] as const;
const notFound = (what: string) => new AppError('RESOURCE_NOT_FOUND', `Không tìm thấy ${what}`);
const forbidden = (msg: string) => new AppError('ACTION_FORBIDDEN', msg);
const json = (v: OpeningHours | null | undefined) =>
  v === undefined ? undefined : v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue);
const archivedAt = (archived: boolean | undefined, current: Date | null): Date | null | undefined =>
  archived === undefined ? undefined : archived ? (current ?? new Date()) : null;

/**
 * Tổ chức (CP04 lát 4, §4.6): cửa hàng, kho, vị trí, quầy, vị trí mặc định theo SKU (§21.3.19). Không xóa — chỉ lưu trữ.
 * Phạm vi: đọc theo `x-scope: store` (cửa hàng trưởng chỉ thấy cửa hàng mình); ghi `store:write` theo phạm vi cửa hàng — tạo /
 * lưu trữ cửa hàng, kho và vị trí của kho cần phạm vi ALL (Master). Khóa (ERD §6.2): `skus` (FOR SHARE) → `stores` /
 * `warehouses` (FOR SHARE khi gắn con, FOR NO KEY UPDATE khi sửa chính nó) → `registers` / `locations` → `sku_default_locations`.
 */
@Injectable()
export class OrgService {
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly ao: AuditOutboxService,
    private readonly scope: ScopeService,
  ) {}

  private get tx() {
    return this.txHost.tx;
  }

  private async assertAll(permission: string, msg: string) {
    if (!(await this.scope.isAll(permission))) throw forbidden(msg);
  }

  // ───────── cửa hàng ─────────

  async listStores(includeArchived: boolean) {
    const s = await this.scope.stores('report:read');
    const rows = await this.tx.store.findMany({
      where: {
        ...(includeArchived ? {} : { archivedAt: null }),
        ...(s === 'ALL' ? {} : { id: { in: [...s] } }),
      },
      orderBy: [{ code: 'asc' }],
    });
    return { items: rows.map(storeWire) };
  }

  async getStore(id: string) {
    await this.scope.assertStore('report:read', id);
    const s = await this.tx.store.findUnique({ where: { id } });
    if (!s) throw notFound('cửa hàng');
    return storeWire(s);
  }

  async createStore(b: StoreCreate) {
    await this.assertAll('store:write', 'Chỉ người có quyền toàn chuỗi mới tạo cửa hàng');
    // cửa hàng mới: CLOSED + PAUSED (Master bật khi sẵn sàng); trigger 0010 thêm vị trí "đang vận chuyển"
    const s = await catalogWrite(() =>
      this.tx.store.create({
        data: {
          id: uuidv7(),
          code: b.code,
          name: b.name,
          address: b.address ?? null,
          lat: b.lat ?? null,
          lng: b.lng ?? null,
          openingHours: json(b.opening_hours ?? null),
          appCapacityPerHour: b.app_capacity_per_hour ?? null,
        },
      }),
    ).catch(orgUnique);
    await this.ao.recordAudit({
      action: 'store.create',
      resourceType: 'store',
      resourceId: s.id,
      after: storeWire(s),
      publicKeys: PUBLIC,
    });
    return storeWire(s);
  }

  async updateStore(id: string, b: StoreUpdate) {
    await this.scope.assertStore('store:write', id);
    if (b.archived !== undefined || b.status !== undefined)
      await this.assertAll('store:write', 'Chỉ người có quyền toàn chuỗi mới lưu trữ / ngừng hoạt động cửa hàng');
    // FOR NO KEY UPDATE: chờ lô giá đang giữ FOR SHARE (lát 3) xong — lô giá không khóa gì sau stores ⇒ không vòng chờ
    const locked = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM core.stores WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
    if (!locked.length) throw notFound('cửa hàng');
    const before = await this.tx.store.findUniqueOrThrow({ where: { id } });

    const archived = b.archived ?? before.archivedAt !== null;
    let status = b.status ?? before.status;
    let pos = b.pos_status ?? before.posStatus;
    let app = b.app_status ?? before.appStatus;
    if (archived) {
      if (b.status === 'ACTIVE' || b.pos_status === 'OPEN' || b.app_status === 'ONLINE')
        throw rule('Cửa hàng đã lưu trữ — không mở bán / nhận đơn', { field: 'archived' });
      status = 'INACTIVE';
      pos = 'CLOSED';
      app = 'PAUSED';
    }
    if (b.archived === true && before.archivedAt === null) {
      const [n] = await this.tx.$queryRaw<{ devices: number }[]>`
        SELECT count(*)::int AS devices FROM core.pos_devices WHERE store_id = ${id}::uuid AND status = 'ACTIVE'`;
      if (n && n.devices > 0)
        throw rule('Cửa hàng còn máy POS đang hoạt động — thu hồi máy trước', { active_pos_devices: n.devices });
    }
    if (status === 'INACTIVE' && !archived && (b.pos_status === 'OPEN' || b.app_status === 'ONLINE'))
      throw rule('Cửa hàng ngừng hoạt động — không mở bán / nhận đơn', { field: 'status' });
    if (status === 'INACTIVE') {
      pos = 'CLOSED';
      app = 'PAUSED';
    }
    const lat = b.lat === undefined ? before.lat : b.lat;
    const hours = b.opening_hours === undefined ? before.openingHours : b.opening_hours;
    const cap = b.app_capacity_per_hour === undefined ? before.appCapacityPerHour : b.app_capacity_per_hour;
    // nhận đơn app cần tọa độ (vùng giao M13), giờ mở cửa và năng lực/giờ > 0 (§4.6)
    if (app === 'ONLINE' && (lat === null || hours === null || !cap))
      throw rule('Nhận đơn app cần tọa độ, giờ mở cửa và năng lực đơn/giờ > 0', { field: 'app_status' });

    const s = await catalogWrite(() =>
      this.tx.store.update({
        where: { id },
        data: {
          name: b.name,
          address: b.address,
          lat: b.lat,
          lng: b.lng,
          openingHours: json(b.opening_hours),
          appCapacityPerHour: b.app_capacity_per_hour,
          status,
          posStatus: pos,
          appStatus: app,
          archivedAt: archivedAt(b.archived, before.archivedAt),
        },
      }),
    );
    await this.ao.recordAudit({
      action: 'store.update',
      resourceType: 'store',
      resourceId: id,
      before: storeWire(before),
      after: storeWire(s),
      publicKeys: PUBLIC,
    });
    return storeWire(s);
  }

  // ───────── kho ─────────

  async listWarehouses(includeArchived: boolean) {
    const rows = await this.tx.warehouse.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: [{ code: 'asc' }],
    });
    return { items: rows.map(warehouseWire) };
  }

  async getWarehouse(id: string) {
    const w = await this.tx.warehouse.findUnique({ where: { id } });
    if (!w) throw notFound('kho');
    return warehouseWire(w);
  }

  async createWarehouse(b: { code: string; name: string; address?: string | null }) {
    await this.assertAll('store:write', 'Chỉ người có quyền toàn chuỗi mới tạo kho');
    const w = await catalogWrite(() =>
      this.tx.warehouse.create({ data: { id: uuidv7(), code: b.code, name: b.name, address: b.address ?? null } }),
    ).catch(orgUnique);
    await this.ao.recordAudit({
      action: 'warehouse.create',
      resourceType: 'warehouse',
      resourceId: w.id,
      after: warehouseWire(w),
      publicKeys: PUBLIC,
    });
    return warehouseWire(w);
  }

  async updateWarehouse(id: string, b: { name?: string; address?: string | null; archived?: boolean }) {
    await this.assertAll('store:write', 'Chỉ người có quyền toàn chuỗi mới sửa kho');
    const locked = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM core.warehouses WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
    if (!locked.length) throw notFound('kho');
    const before = await this.tx.warehouse.findUniqueOrThrow({ where: { id } });
    const w = await catalogWrite(() =>
      this.tx.warehouse.update({
        where: { id },
        data: { name: b.name, address: b.address, archivedAt: archivedAt(b.archived, before.archivedAt) },
      }),
    );
    await this.ao.recordAudit({
      action: 'warehouse.update',
      resourceType: 'warehouse',
      resourceId: id,
      before: warehouseWire(before),
      after: warehouseWire(w),
      publicKeys: PUBLIC,
    });
    return warehouseWire(w);
  }

  // ───────── vị trí ─────────

  /** Chủ của vị trí: cửa hàng ⇒ kiểm phạm vi (ngoài phạm vi ⇒ 404); kho ⇒ ghi cần phạm vi ALL. */
  private async assertOwner(permission: string, owner: { storeId: string | null; warehouseId: string | null }) {
    if (owner.storeId) await this.scope.assertStore(permission, owner.storeId, () => notFound('vị trí'));
    else if (permission !== 'stock:read')
      await this.assertAll(permission, 'Chỉ người có quyền toàn chuỗi mới sửa vị trí của kho');
  }

  /** Khóa chia sẻ chủ (cửa hàng / kho) đang dùng — chặn lưu trữ song song khi gắn vị trí. */
  private async shareOwner(owner: { storeId: string | null; warehouseId: string | null }) {
    const r = owner.storeId
      ? await this.tx.$queryRaw<{ archived: boolean }[]>`
          SELECT archived_at IS NOT NULL AS archived FROM core.stores WHERE id = ${owner.storeId}::uuid FOR SHARE`
      : await this.tx.$queryRaw<{ archived: boolean }[]>`
          SELECT archived_at IS NOT NULL AS archived FROM core.warehouses WHERE id = ${owner.warehouseId}::uuid FOR SHARE`;
    if (!r.length) throw owner.storeId ? notFound('cửa hàng') : notFound('kho');
    if (r[0]?.archived) throw rule(owner.storeId ? 'Cửa hàng đã lưu trữ' : 'Kho đã lưu trữ', {});
  }

  async listLocations(q: { store_id?: string; warehouse_id?: string; type?: string; include_archived: boolean }) {
    const owner = { storeId: q.store_id ?? null, warehouseId: q.warehouse_id ?? null };
    await this.assertOwner('stock:read', owner);
    const rows = await this.tx.location.findMany({
      where: {
        ...(owner.storeId ? { storeId: owner.storeId } : { warehouseId: owner.warehouseId }),
        ...(q.type ? { type: q.type as LocationKind } : {}),
        ...(q.include_archived ? {} : { archivedAt: null }),
      },
      // thứ tự lộ trình nhặt hàng (§21.3.19)
      orderBy: [{ sort: 'asc' }, { code: 'asc' }],
    });
    return { items: rows.map(locationWire) };
  }

  async createLocation(b: {
    store_id?: string;
    warehouse_id?: string;
    type: LocationKind;
    code: string;
    name: string;
    sort?: number;
  }) {
    const owner = { storeId: b.store_id ?? null, warehouseId: b.warehouse_id ?? null };
    await this.assertOwner('store:write', owner);
    await this.shareOwner(owner);
    const l = await catalogWrite(() =>
      this.tx.location.create({
        data: {
          id: uuidv7(),
          storeId: owner.storeId,
          warehouseId: owner.warehouseId,
          type: b.type,
          code: b.code,
          name: b.name,
          sort: b.sort ?? 0,
        },
      }),
    ).catch(orgUnique);
    await this.ao.recordAudit({
      action: 'location.create',
      resourceType: 'location',
      resourceId: l.id,
      after: locationWire(l),
    });
    return locationWire(l);
  }

  async updateLocation(id: string, b: { name?: string; sort?: number; archived?: boolean }) {
    const cur = await this.tx.location.findUnique({ where: { id }, select: { storeId: true, warehouseId: true } });
    if (!cur) throw notFound('vị trí');
    await this.assertOwner('store:write', cur);
    // thứ tự khóa: chủ (FOR SHARE) → vị trí (ERD §6.2) — mở lại vị trí của chủ đã lưu trữ ⇒ 422
    if (b.archived === false) await this.shareOwner(cur);
    const locked = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM core.locations WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
    if (!locked.length) throw notFound('vị trí');
    const before = await this.tx.location.findUniqueOrThrow({ where: { id } });
    if (b.archived === true && before.archivedAt === null) {
      if (before.type === 'IN_TRANSIT')
        throw rule('Vị trí "đang vận chuyển" không lưu trữ được', { field: 'archived' });
      const [n] = await this.tx.$queryRaw<{ defaults: number }[]>`
        SELECT count(*)::int AS defaults FROM core.sku_default_locations WHERE location_id = ${id}::uuid`;
      if (n && n.defaults > 0)
        throw rule('Vị trí đang là vị trí mặc định của SKU — đổi vị trí mặc định trước', { sku_defaults: n.defaults });
    }
    const l = await catalogWrite(() =>
      this.tx.location.update({
        where: { id },
        data: { name: b.name, sort: b.sort, archivedAt: archivedAt(b.archived, before.archivedAt) },
      }),
    );
    await this.ao.recordAudit({
      action: 'location.update',
      resourceType: 'location',
      resourceId: id,
      before: locationWire(before),
      after: locationWire(l),
    });
    return locationWire(l);
  }

  // ───────── quầy ─────────

  async listRegisters(storeId: string, includeArchived: boolean) {
    await this.scope.assertStore('report:read', storeId, () => notFound('cửa hàng'));
    const rows = await this.tx.register.findMany({
      where: { storeId, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: [{ code: 'asc' }],
    });
    return { items: rows.map(registerWire) };
  }

  async createRegister(storeId: string, b: { code: string; name?: string | null }) {
    await this.scope.assertStore('store:write', storeId, () => notFound('cửa hàng'));
    await this.shareOwner({ storeId, warehouseId: null });
    const r = await catalogWrite(() =>
      this.tx.register.create({ data: { id: uuidv7(), storeId, code: b.code, name: b.name ?? null } }),
    ).catch(orgUnique);
    await this.ao.recordAudit({
      action: 'register.create',
      resourceType: 'register',
      resourceId: r.id,
      after: registerWire(r),
    });
    return registerWire(r);
  }

  async updateRegister(id: string, b: { code?: string; name?: string | null; archived?: boolean }) {
    const cur = await this.tx.register.findUnique({ where: { id }, select: { storeId: true } });
    if (!cur) throw notFound('quầy');
    await this.scope.assertStore('store:write', cur.storeId, () => notFound('quầy'));
    if (b.archived === false) await this.shareOwner({ storeId: cur.storeId, warehouseId: null });
    const locked = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM core.registers WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
    if (!locked.length) throw notFound('quầy');
    const before = await this.tx.register.findUniqueOrThrow({ where: { id } });
    if (b.archived === true && before.archivedAt === null) {
      // máy kích hoạt vào quầy khóa quầy FOR SHARE (pos-device.service) ⇒ đếm ở đây thấy máy vừa kích hoạt
      const [n] = await this.tx.$queryRaw<{ devices: number }[]>`
        SELECT count(*)::int AS devices FROM core.pos_devices WHERE register_id = ${id}::uuid AND status = 'ACTIVE'`;
      if (n && n.devices > 0)
        throw rule('Quầy còn máy POS đang hoạt động — thu hồi / chuyển máy trước', { active_pos_devices: n.devices });
    }
    const r = await catalogWrite(() =>
      this.tx.register.update({
        where: { id },
        data: { code: b.code, name: b.name, archivedAt: archivedAt(b.archived, before.archivedAt) },
      }),
    ).catch(orgUnique);
    await this.ao.recordAudit({
      action: 'register.update',
      resourceType: 'register',
      resourceId: id,
      before: registerWire(before),
      after: registerWire(r),
    });
    return registerWire(r);
  }

  // ───────── vị trí mặc định theo SKU (§21.3.19) ─────────

  async listDefaultLocations(storeId: string, skuId?: string) {
    await this.scope.assertStore('stock:read', storeId, () => notFound('cửa hàng'));
    const rows = await this.tx.skuDefaultLocation.findMany({
      where: { storeId, ...(skuId ? { skuId } : {}) },
      include: { location: true, sku: { select: { skuCode: true, name: true } } },
      take: 5000,
    });
    // lộ trình nhặt hàng: theo thứ tự vị trí, rồi mã SKU
    rows.sort(
      (a, b) =>
        a.location.sort - b.location.sort ||
        a.location.code.localeCompare(b.location.code) ||
        a.sku.skuCode.localeCompare(b.sku.skuCode),
    );
    return {
      items: rows.map((r) => ({
        sku_id: r.skuId,
        sku_code: r.sku.skuCode,
        sku_name: r.sku.name,
        location_id: r.locationId,
        location_code: r.location.code,
        location_name: r.location.name,
        location_sort: r.location.sort,
      })),
    };
  }

  async setDefaultLocation(storeId: string, skuId: string, locationId: string | null) {
    await this.scope.assertStore('store:write', storeId, () => notFound('cửa hàng'));
    // ERD §6.2: skus → stores → locations (trigger sku_default_locations_guard khóa FOR SHARE) → sku_default_locations
    const sku = await this.tx.$queryRaw<{ archived: boolean }[]>`
      SELECT archived_at IS NOT NULL AS archived FROM core.skus WHERE id = ${skuId}::uuid FOR SHARE`;
    if (!sku.length) throw notFound('SKU');
    if (locationId && sku[0]?.archived) throw rule('SKU đã lưu trữ', { field: 'sku_id' });
    await this.shareOwner({ storeId, warehouseId: null });
    const [before] = await this.tx.$queryRaw<{ location_id: string }[]>`
      SELECT location_id::text FROM core.sku_default_locations
      WHERE store_id = ${storeId}::uuid AND sku_id = ${skuId}::uuid FOR UPDATE`;
    if (locationId === null) {
      if (!before) throw notFound('vị trí mặc định');
      await this.tx.$executeRaw`
        DELETE FROM core.sku_default_locations WHERE store_id = ${storeId}::uuid AND sku_id = ${skuId}::uuid`;
    } else {
      // kiểm trước để báo lỗi rõ (trigger + FK vẫn là lớp chặn cuối)
      const [loc] = await this.tx.$queryRaw<{ store_id: string | null; type: string; archived: boolean }[]>`
        SELECT store_id::text, type::text, archived_at IS NOT NULL AS archived FROM core.locations
        WHERE id = ${locationId}::uuid FOR SHARE`;
      if (loc?.store_id !== storeId) throw rule('Vị trí không thuộc cửa hàng này', { field: 'location_id' });
      if (loc.archived || loc.type === 'IN_TRANSIT')
        throw rule('Vị trí đã lưu trữ hoặc là "đang vận chuyển"', { field: 'location_id' });
      await this.tx.$executeRaw`
        INSERT INTO core.sku_default_locations (store_id, sku_id, location_id)
        VALUES (${storeId}::uuid, ${skuId}::uuid, ${locationId}::uuid)
        ON CONFLICT (store_id, sku_id) DO UPDATE SET location_id = EXCLUDED.location_id`.catch((e: unknown) => {
        // FK (location_id, store_id): vị trí của nơi khác / không tồn tại; trigger: lưu trữ / đang vận chuyển
        const s = findSqlState(e);
        if (s === '23503') throw rule('Vị trí không thuộc cửa hàng này', { field: 'location_id' });
        if (s === '23514') throw rule('Vị trí đã lưu trữ hoặc là "đang vận chuyển"', { field: 'location_id' });
        throw e;
      });
    }
    const after = { store_id: storeId, sku_id: skuId, location_id: locationId };
    await this.ao.recordAudit({
      action: 'sku_default_location.set',
      resourceType: 'sku_default_location',
      resourceId: `${storeId}:${skuId}`,
      before: before ? { ...after, location_id: before.location_id } : null,
      after,
    });
    return after;
  }
}

/** trùng mã (cửa hàng / kho / vị trí / quầy) ⇒ 409 field `code` */
function orgUnique(e: unknown): never {
  if (e instanceof AppError && e.code === 'VERSION_CONFLICT') {
    throw new AppError('VERSION_CONFLICT', 'Trùng mã với bản ghi khác', { reason: 'UNIQUE', field: 'code' });
  }
  throw e;
}
