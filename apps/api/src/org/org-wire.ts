import type { Location, Register, Store, Warehouse } from '../generated/prisma/client';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function storeWire(s: Store) {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    address: s.address,
    status: s.status,
    lat: s.lat,
    lng: s.lng,
    opening_hours: (s.openingHours ?? null) as Record<string, [string, string][]> | null,
    pos_status: s.posStatus,
    app_status: s.appStatus,
    app_capacity_per_hour: s.appCapacityPerHour,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
    archived_at: iso(s.archivedAt),
  };
}

export function warehouseWire(w: Warehouse) {
  return {
    id: w.id,
    code: w.code,
    name: w.name,
    address: w.address,
    created_at: w.createdAt.toISOString(),
    archived_at: iso(w.archivedAt),
  };
}

export function locationWire(l: Location) {
  return {
    id: l.id,
    store_id: l.storeId,
    warehouse_id: l.warehouseId,
    type: l.type,
    code: l.code,
    name: l.name,
    sort: l.sort,
    created_at: l.createdAt.toISOString(),
    archived_at: iso(l.archivedAt),
  };
}

export function registerWire(r: Register) {
  return {
    id: r.id,
    store_id: r.storeId,
    code: r.code,
    name: r.name,
    created_at: r.createdAt.toISOString(),
    archived_at: iso(r.archivedAt),
  };
}
