'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert } from '../../../components/Alert';
import { bff } from '../../../lib/client/api';
import { parseIntOrNull } from '../../../lib/client/format';
import {
  DAYS,
  LOCATION_VI,
  type Location,
  type LocationType,
  type OpeningHours,
  type Register,
  type Sku,
  type Store,
  type Warehouse,
} from '../../../lib/client/types';
import { useAction } from '../../../lib/client/use-action';

const KINDS: LocationType[] = ['STORAGE', 'COLD_ROOM', 'SHELF', 'CHILLER', 'RIPENING'];

/** "07:00-12:00, 13:00-21:00" ⇒ [["07:00","12:00"],["13:00","21:00"]]; sai ⇒ null */
function parseDay(s: string): [string, string][] | null {
  const t = s.trim();
  if (!t) return [];
  const out: [string, string][] = [];
  for (const part of t.split(/[,;]/)) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
    if (!m) return null;
    const hh = (h: string, mm: string) => `${h.padStart(2, '0')}:${mm}`;
    out.push([hh(m[1] ?? '', m[2] ?? ''), hh(m[3] ?? '', m[4] ?? '')]);
  }
  return out;
}
const showDay = (v: [string, string][] | undefined) => (v ?? []).map(([a, b]) => `${a}-${b}`).join(', ');

/** A11 — cửa hàng (địa chỉ, tọa độ, giờ mở, trạng thái POS / app), quầy, vị trí, vị trí mặc định; kho + vị trí kho. */
export default function OrgPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [sel, setSel] = useState<{ kind: 'store' | 'warehouse'; id: string } | null>(null);
  const a = useAction();

  const load = useCallback(async () => {
    const [s, w] = await Promise.all([
      bff<{ items: Store[] }>('/api/admin/stores?include_archived=true'),
      bff<{ items: Warehouse[] }>('/api/admin/warehouses?include_archived=true'),
    ]);
    setStores(s.items);
    setWarehouses(w.items);
  }, []);
  useEffect(() => {
    void a.load(load);
  }, [load, a.load]);

  function createStore(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const address = String(f.get('address') ?? '').trim();
    void a.run(async () => {
      const s = await bff<Store>('/api/admin/stores', 'POST', {
        code: String(f.get('code') ?? '').trim(),
        name: String(f.get('name') ?? '').trim(),
        address: address || null,
      });
      form.reset();
      await load();
      setSel({ kind: 'store', id: s.id });
      return `Đã tạo cửa hàng ${s.code} (đang đóng — bật khi sẵn sàng)`;
    });
  }

  function createWarehouse(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const address = String(f.get('address') ?? '').trim();
    void a.run(async () => {
      const w = await bff<Warehouse>('/api/admin/warehouses', 'POST', {
        code: String(f.get('code') ?? '').trim(),
        name: String(f.get('name') ?? '').trim(),
        address: address || null,
      });
      form.reset();
      await load();
      setSel({ kind: 'warehouse', id: w.id });
      return `Đã tạo kho ${w.code}`;
    });
  }

  const store = sel?.kind === 'store' ? stores.find((s) => s.id === sel.id) : undefined;
  const wh = sel?.kind === 'warehouse' ? warehouses.find((w) => w.id === sel.id) : undefined;

  return (
    <>
      <div className="card">
        <h1>Cửa hàng &amp; kho</h1>
        <Alert text={a.err} />
        <Alert text={a.notice} kind="notice" />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Mã</th>
                <th>Tên</th>
                <th>Loại</th>
                <th>Trạng thái</th>
                <th>
                  <span className="sr-only">Thao tác</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {stores.map((s) => (
                <tr key={s.id} className={s.archived_at ? 'archived' : undefined}>
                  <td className="mono">{s.code}</td>
                  <td>{s.name}</td>
                  <td>Cửa hàng</td>
                  <td>
                    {s.archived_at
                      ? 'Đã lưu trữ'
                      : `${s.status === 'ACTIVE' ? 'Hoạt động' : 'Ngừng'} · POS ${s.pos_status === 'OPEN' ? 'mở' : 'đóng'} · App ${s.app_status === 'ONLINE' ? 'nhận đơn' : 'tạm dừng'}`}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Mở cửa hàng ${s.code}`}
                      onClick={() => setSel({ kind: 'store', id: s.id })}
                    >
                      Mở
                    </button>
                  </td>
                </tr>
              ))}
              {warehouses.map((w) => (
                <tr key={w.id} className={w.archived_at ? 'archived' : undefined}>
                  <td className="mono">{w.code}</td>
                  <td>{w.name}</td>
                  <td>Kho</td>
                  <td>{w.archived_at ? 'Đã lưu trữ' : 'Đang dùng'}</td>
                  <td>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Mở kho ${w.code}`}
                      onClick={() => setSel({ kind: 'warehouse', id: w.id })}
                    >
                      Mở
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid mt16">
          <form onSubmit={createStore}>
            <h2>Thêm cửa hàng</h2>
            <label>
              Mã
              <input name="code" required maxLength={16} pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,15}" />
            </label>
            <label>
              Tên
              <input name="name" required maxLength={100} />
            </label>
            <label>
              Địa chỉ
              <input name="address" maxLength={300} />
            </label>
            <button type="submit" disabled={a.busy}>
              Thêm cửa hàng
            </button>
          </form>
          <form onSubmit={createWarehouse}>
            <h2>Thêm kho</h2>
            <label>
              Mã
              <input name="code" required maxLength={16} pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,15}" />
            </label>
            <label>
              Tên
              <input name="name" required maxLength={100} />
            </label>
            <label>
              Địa chỉ
              <input name="address" maxLength={300} />
            </label>
            <button type="submit" disabled={a.busy}>
              Thêm kho
            </button>
          </form>
        </div>
      </div>
      {store && <StorePanel key={`${store.id}`} store={store} reload={load} />}
      {wh && <WarehousePanel key={wh.id} wh={wh} reload={load} />}
    </>
  );
}

function StorePanel({ store, reload }: { store: Store; reload: () => Promise<void> }) {
  const a = useAction();
  const [locRev, setLocRev] = useState(0);

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? '').trim();
    const hours: OpeningHours = {};
    for (const d of DAYS) {
      const v = parseDay(s(`h_${d.key}`));
      if (v === null) return a.setErr(`${d.vi}: nhập dạng 07:00-12:00, 13:00-21:00`);
      if (v.length) hours[d.key] = v;
    }
    const latS = s('lat');
    const lngS = s('lng');
    if (!!latS !== !!lngS) return a.setErr('Nhập cả vĩ độ và kinh độ (hoặc bỏ trống cả hai)');
    const lat = latS ? Number(latS) : null;
    const lng = lngS ? Number(lngS) : null;
    if ((lat !== null && !Number.isFinite(lat)) || (lng !== null && !Number.isFinite(lng)))
      return a.setErr('Tọa độ phải là số (vd 21.0285, 105.8542)');
    const cap = parseIntOrNull(s('cap'));
    if (cap === undefined) return a.setErr('Năng lực đơn / giờ phải là số nguyên');
    void a.run(async () => {
      await bff(`/api/admin/stores/${store.id}`, 'PATCH', {
        name: s('name'),
        address: s('address') || null,
        lat,
        lng,
        opening_hours: Object.keys(hours).length ? hours : null,
        app_capacity_per_hour: cap,
        status: s('status'),
        pos_status: s('pos_status'),
        app_status: s('app_status'),
      });
      await reload();
      return 'Đã lưu cửa hàng';
    });
  }

  function archive() {
    if (!store.archived_at && !window.confirm(`Lưu trữ cửa hàng ${store.code}?`)) return;
    void a.run(async () => {
      await bff(`/api/admin/stores/${store.id}`, 'PATCH', { archived: !store.archived_at });
      await reload();
      return store.archived_at ? 'Đã khôi phục' : 'Đã lưu trữ';
    });
  }

  return (
    <>
      <div className="card">
        <h2>
          Cửa hàng <span className="mono">{store.code}</span>
        </h2>
        <Alert text={a.err} />
        <Alert text={a.notice} kind="notice" />
        <form onSubmit={save} key={store.id}>
          <div className="grid">
            <label>
              Tên
              <input name="name" defaultValue={store.name} required maxLength={100} />
            </label>
            <label>
              Địa chỉ
              <input name="address" defaultValue={store.address ?? ''} maxLength={300} />
            </label>
            <label>
              Vĩ độ
              <input name="lat" defaultValue={store.lat ?? ''} inputMode="decimal" />
            </label>
            <label>
              Kinh độ
              <input name="lng" defaultValue={store.lng ?? ''} inputMode="decimal" />
            </label>
            <label>
              Năng lực đơn app / giờ
              <input name="cap" defaultValue={store.app_capacity_per_hour ?? ''} inputMode="numeric" />
            </label>
            <label>
              Trạng thái
              <select name="status" defaultValue={store.status}>
                <option value="ACTIVE">Hoạt động</option>
                <option value="INACTIVE">Ngừng</option>
              </select>
            </label>
            <label>
              Bán tại quầy (POS)
              <select name="pos_status" defaultValue={store.pos_status}>
                <option value="OPEN">Mở</option>
                <option value="CLOSED">Đóng</option>
              </select>
            </label>
            <label>
              Đơn app
              <select name="app_status" defaultValue={store.app_status}>
                <option value="ONLINE">Nhận đơn</option>
                <option value="PAUSED">Tạm dừng</option>
              </select>
            </label>
          </div>
          <h2>Giờ mở cửa</h2>
          <p className="muted">Mỗi ngày tối đa 3 khung, vd 07:00-12:00, 13:00-21:00. Bỏ trống = nghỉ.</p>
          <div className="grid">
            {DAYS.map((d) => (
              <label key={d.key}>
                {d.vi}
                <input name={`h_${d.key}`} defaultValue={showDay(store.opening_hours?.[d.key])} maxLength={60} />
              </label>
            ))}
          </div>
          <p className="muted">Nhận đơn app cần đủ tọa độ, giờ mở và năng lực đơn / giờ.</p>
          <div className="row">
            <button type="submit" disabled={a.busy || !!store.archived_at}>
              Lưu cửa hàng
            </button>
            <button type="button" className="danger" disabled={a.busy} onClick={archive}>
              {store.archived_at ? 'Khôi phục' : 'Lưu trữ'}
            </button>
          </div>
        </form>
      </div>
      <Registers store={store} />
      <Locations
        owner={{ store_id: store.id }}
        archived={!!store.archived_at}
        onChanged={() => setLocRev((r) => r + 1)}
      />
      <DefaultLocations store={store} rev={locRev} />
    </>
  );
}

function WarehousePanel({ wh, reload }: { wh: Warehouse; reload: () => Promise<void> }) {
  const a = useAction();
  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void a.run(async () => {
      await bff(`/api/admin/warehouses/${wh.id}`, 'PATCH', {
        name: String(f.get('name') ?? '').trim(),
        address: String(f.get('address') ?? '').trim() || null,
      });
      await reload();
      return 'Đã lưu kho';
    });
  }
  return (
    <>
      <div className="card">
        <h2>
          Kho <span className="mono">{wh.code}</span>
        </h2>
        <Alert text={a.err} />
        <Alert text={a.notice} kind="notice" />
        <form onSubmit={save} className="grid">
          <label>
            Tên
            <input name="name" defaultValue={wh.name} required maxLength={100} />
          </label>
          <label>
            Địa chỉ
            <input name="address" defaultValue={wh.address ?? ''} maxLength={300} />
          </label>
          <div className="row">
            <button type="submit" disabled={a.busy || !!wh.archived_at}>
              Lưu kho
            </button>
            <button
              type="button"
              className="danger"
              disabled={a.busy}
              onClick={() =>
                void a.run(async () => {
                  await bff(`/api/admin/warehouses/${wh.id}`, 'PATCH', { archived: !wh.archived_at });
                  await reload();
                  return wh.archived_at ? 'Đã khôi phục' : 'Đã lưu trữ';
                })
              }
            >
              {wh.archived_at ? 'Khôi phục' : 'Lưu trữ'}
            </button>
          </div>
        </form>
      </div>
      <Locations owner={{ warehouse_id: wh.id }} archived={!!wh.archived_at} />
    </>
  );
}

function Registers({ store }: { store: Store }) {
  const [items, setItems] = useState<Register[]>([]);
  const a = useAction();
  const load = useCallback(async () => {
    setItems((await bff<{ items: Register[] }>(`/api/admin/stores/${store.id}/registers?include_archived=true`)).items);
  }, [store.id]);
  useEffect(() => {
    void a.load(load);
  }, [load, a.load]);

  function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    void a.run(async () => {
      await bff(`/api/admin/stores/${store.id}/registers`, 'POST', {
        code: String(f.get('code') ?? '').trim(),
        name: String(f.get('name') ?? '').trim() || null,
      });
      form.reset();
      await load();
      return 'Đã thêm quầy';
    });
  }

  return (
    <div className="card">
      <h2>Quầy thu ngân</h2>
      <Alert text={a.err} />
      <Alert text={a.notice} kind="notice" />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Mã</th>
              <th>Tên</th>
              <th>
                <span className="sr-only">Thao tác</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id} className={r.archived_at ? 'archived' : undefined}>
                <td className="mono">{r.code}</td>
                <td>{r.name ?? '—'}</td>
                <td>
                  <button
                    type="button"
                    className="danger"
                    disabled={a.busy}
                    aria-label={`${r.archived_at ? 'Khôi phục' : 'Lưu trữ'} quầy ${r.code}`}
                    onClick={() =>
                      void a.run(async () => {
                        await bff(`/api/admin/registers/${r.id}`, 'PATCH', { archived: !r.archived_at });
                        await load();
                        return r.archived_at ? 'Đã khôi phục quầy' : 'Đã lưu trữ quầy';
                      })
                    }
                  >
                    {r.archived_at ? 'Khôi phục' : 'Lưu trữ'}
                  </button>
                </td>
              </tr>
            ))}
            {!items.length && (
              <tr>
                <td colSpan={3} className="muted">
                  Chưa có quầy
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {!store.archived_at && (
        <form onSubmit={add} className="grid mt12">
          <label>
            Mã quầy
            <input name="code" required maxLength={16} pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,15}" />
          </label>
          <label>
            Tên (vd Quầy 1)
            <input name="name" maxLength={100} />
          </label>
          <div>
            <button type="submit" disabled={a.busy}>
              Thêm quầy
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Locations({
  owner,
  onChanged,
  archived = false,
}: {
  owner: { store_id: string } | { warehouse_id: string };
  onChanged?: () => void;
  /** nơi đã lưu trữ ⇒ không cho thêm vị trí (API trả 422 — review react cổng CP04 T3) */
  archived?: boolean;
}) {
  const [items, setItems] = useState<Location[]>([]);
  const a = useAction();
  const q = 'store_id' in owner ? `store_id=${owner.store_id}` : `warehouse_id=${owner.warehouse_id}`;
  const reload = useCallback(async () => {
    setItems((await bff<{ items: Location[] }>(`/api/admin/locations?${q}&include_archived=true`)).items);
  }, [q]);
  const load = useCallback(async () => {
    await reload();
    onChanged?.();
  }, [reload, onChanged]);
  // tải đầu chỉ đọc (không báo onChanged — prop là hàm mới mỗi lần render)
  useEffect(() => {
    void a.load(reload);
  }, [reload, a.load]);

  function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const sort = parseIntOrNull(String(f.get('sort') ?? ''));
    if (sort === undefined) return a.setErr('Thứ tự phải là số nguyên');
    void a.run(async () => {
      await bff('/api/admin/locations', 'POST', {
        ...owner,
        type: String(f.get('type')),
        code: String(f.get('code') ?? '').trim(),
        name: String(f.get('name') ?? '').trim(),
        ...(sort !== null ? { sort } : {}),
      });
      form.reset();
      await load();
      return 'Đã thêm vị trí';
    });
  }

  function patch(l: Location, body: Record<string, unknown>, msg: string) {
    void a.run(async () => {
      await bff(`/api/admin/locations/${l.id}`, 'PATCH', body);
      await load();
      return msg;
    });
  }

  return (
    <div className="card">
      <h2>Vị trí</h2>
      <Alert text={a.err} />
      <Alert text={a.notice} kind="notice" />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Thứ tự</th>
              <th>Mã</th>
              <th>Tên</th>
              <th>Loại</th>
              <th>
                <span className="sr-only">Thao tác</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((l) => (
              <tr key={l.id} className={l.archived_at ? 'archived' : undefined}>
                <td>{l.sort}</td>
                <td className="mono">{l.code}</td>
                <td>{l.name}</td>
                <td>{LOCATION_VI[l.type]}</td>
                <td>
                  {l.type !== 'IN_TRANSIT' && (
                    <div className="row">
                      <button
                        type="button"
                        className="secondary"
                        disabled={a.busy || !!l.archived_at}
                        aria-label={`Sửa ${l.code}`}
                        onClick={() => {
                          const name = window.prompt('Tên vị trí:', l.name);
                          if (name === null) return;
                          const so = window.prompt('Thứ tự (lộ trình nhặt hàng):', String(l.sort));
                          if (so === null) return;
                          const n = parseIntOrNull(so);
                          if (n === undefined || n === null) return a.setErr('Thứ tự phải là số nguyên');
                          patch(l, { name: name.trim() || l.name, sort: n }, 'Đã lưu vị trí');
                        }}
                      >
                        Sửa
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={a.busy}
                        aria-label={`${l.archived_at ? 'Khôi phục' : 'Lưu trữ'} ${l.code}`}
                        onClick={() =>
                          patch(l, { archived: !l.archived_at }, l.archived_at ? 'Đã khôi phục' : 'Đã lưu trữ')
                        }
                      >
                        {l.archived_at ? 'Khôi phục' : 'Lưu trữ'}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!archived && (
        <form onSubmit={add} className="grid mt12">
          <label>
            Loại
            <select name="type" defaultValue="SHELF">
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {LOCATION_VI[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Mã
            <input name="code" required maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,31}" />
          </label>
          <label>
            Tên
            <input name="name" required maxLength={100} />
          </label>
          <label>
            Thứ tự
            <input name="sort" inputMode="numeric" />
          </label>
          <div>
            <button type="submit" disabled={a.busy}>
              Thêm vị trí
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

interface DefaultLoc {
  sku_id: string;
  sku_code: string;
  sku_name: string;
  location_id: string;
  location_code: string;
  location_name: string;
}

function DefaultLocations({ store, rev }: { store: Store; rev: number }) {
  const [items, setItems] = useState<DefaultLoc[]>([]);
  const [locs, setLocs] = useState<Location[]>([]);
  const [found, setFound] = useState<Sku[]>([]);
  const a = useAction();
  const load = useCallback(async () => {
    const [d, l] = await Promise.all([
      bff<{ items: DefaultLoc[] }>(`/api/admin/stores/${store.id}/default-locations`),
      bff<{ items: Location[] }>(`/api/admin/locations?store_id=${store.id}`),
    ]);
    setItems(d.items);
    setLocs(l.items.filter((x) => x.type !== 'IN_TRANSIT'));
    void rev;
  }, [store.id, rev]);
  useEffect(() => {
    void a.load(load);
  }, [load, a.load]);

  function set(skuId: string, locationId: string | null) {
    void a.run(async () => {
      await bff(`/api/admin/stores/${store.id}/default-locations/${skuId}`, 'PUT', { location_id: locationId });
      await load();
      return locationId ? 'Đã đặt vị trí mặc định' : 'Đã bỏ vị trí mặc định';
    });
  }

  function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    if (!q) return;
    void a.load(async () => {
      setFound((await bff<{ items: Sku[] }>(`/api/admin/skus?q=${encodeURIComponent(q)}&limit=20`)).items);
    });
  }

  const select = (skuId: string, value: string) => (
    <select
      aria-label="Vị trí mặc định"
      value={value}
      disabled={a.busy}
      onChange={(e) => set(skuId, e.target.value || null)}
    >
      <option value="">(không có)</option>
      {/* vị trí hiện tại đã lưu trữ (không còn trong danh sách) ⇒ vẫn hiện đúng (review react T6) */}
      {value && !locs.some((l) => l.id === value) && (
        <option value={value} disabled>
          {items.find((d) => d.location_id === value)?.location_code ?? 'Vị trí'} (đã lưu trữ)
        </option>
      )}
      {locs.map((l) => (
        <option key={l.id} value={l.id}>
          {l.code} — {l.name}
        </option>
      ))}
    </select>
  );

  return (
    <div className="card">
      <h2>Vị trí mặc định của SKU</h2>
      <Alert text={a.err} />
      <Alert text={a.notice} kind="notice" />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Vị trí</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.sku_id}>
                <td>
                  <span className="mono">{d.sku_code}</span> {d.sku_name}
                </td>
                <td>{select(d.sku_id, d.location_id)}</td>
              </tr>
            ))}
            {!items.length && (
              <tr>
                <td colSpan={2} className="muted">
                  Chưa đặt
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <form onSubmit={search} className="row mt12">
        <label className="grow">
          Tìm SKU để đặt vị trí
          <input name="q" maxLength={100} />
        </label>
        <button type="submit" className="secondary">
          Tìm
        </button>
      </form>
      {found.length > 0 && (
        <table className="mt8">
          <tbody>
            {found
              .filter((s) => !items.some((d) => d.sku_id === s.id))
              .map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="mono">{s.sku_code}</span> {s.name}
                  </td>
                  <td>{select(s.id, '')}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
