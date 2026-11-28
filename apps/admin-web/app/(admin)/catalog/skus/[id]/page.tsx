'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Alert } from '../../../../../components/Alert';
import { bff } from '../../../../../lib/client/api';
import { dt, money, parseIntOrNull, parseMoney, UUID_RE } from '../../../../../lib/client/format';
import {
  SALE_TYPE_VI,
  WEIGHT_PRICED,
  type PriceChangeLog,
  type Sku,
  type SkuPrices,
  type SkuUnit,
  type Unit,
} from '../../../../../lib/client/types';
import { useAction } from '../../../../../lib/client/use-action';
import { useStores } from '../../../../../lib/client/use-stores';

const INT_FIELDS = [
  ['std_weight_g', 'Trọng lượng chuẩn (g)'],
  ['weight_min_g', 'Cân tối thiểu (g)'],
  ['weight_max_g', 'Cân tối đa (g)'],
  ['tare_g', 'Bì (g)'],
  ['shelf_life_days', 'Hạn dùng (ngày)'],
  ['alert_days_before_expiry', 'Cảnh báo trước hạn (ngày)'],
  ['stop_app_days_before_expiry', 'Ngừng bán app trước hạn (ngày)'],
  ['shrink_norm_bps_week', 'Định mức hao hụt (‱/tuần)'],
] as const;
const FLAGS = [
  ['has_ripeness', 'Theo dõi độ chín'],
  ['is_high_value', 'Hàng giá trị cao'],
  ['cold_required', 'Cần giữ lạnh'],
] as const;

const FIELD_VI: Record<PriceChangeLog['field'], string> = {
  PER_KG: 'Giá/kg',
  PER_UNIT: 'Giá/đơn vị',
  SKU_UNIT: 'Giá đơn vị bán',
};

/** A10 — chi tiết SKU: thuộc tính (theo version), đơn vị bán/mua, giá lẻ chung / cửa hàng / đơn vị, lịch sử giá. */
export default function SkuPage() {
  const { id } = useParams<{ id: string }>();
  const valid = typeof id === 'string' && UUID_RE.test(id);
  const [sku, setSku] = useState<Sku | null>(null);
  const [prices, setPrices] = useState<SkuPrices | null>(null);
  const [history, setHistory] = useState<PriceChangeLog[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const stores = useStores(true);
  const a = useAction();

  const load = useCallback(async () => {
    if (!valid) return;
    const [s, p, h] = await Promise.all([
      bff<Sku>(`/api/admin/skus/${id}`),
      bff<SkuPrices>(`/api/admin/prices/${id}`),
      bff<{ items: PriceChangeLog[] }>(`/api/admin/prices/${id}/history?limit=100`),
    ]);
    setSku(s);
    setPrices(p);
    setHistory(h.items);
  }, [id, valid]);
  useEffect(() => {
    void a.load(async () => {
      await load();
      setUnits((await bff<{ items: Unit[] }>('/api/admin/units')).items);
    });
  }, [load, a.load]);

  const storeName = useMemo(() => new Map(stores.map((s) => [s.id, `${s.code} — ${s.name}`])), [stores]);

  if (!valid) return <p className="error">Mã SKU không hợp lệ</p>;
  if (!sku)
    return (
      <div className="card">
        <Alert text={a.err} />
        <p className="muted">Đang tải…</p>
      </div>
    );

  const weighted = WEIGHT_PRICED.has(sku.sale_unit_type);
  const noWeight = sku.sale_unit_type === 'BUNDLE' || sku.sale_unit_type === 'SERVICE';

  function saveAttrs(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!sku) return;
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = { version: sku.version, name: String(f.get('name') ?? '').trim() };
    for (const [k, vi] of INT_FIELDS) {
      if (!f.has(k)) continue;
      const v = parseIntOrNull(String(f.get(k) ?? ''));
      if (v === undefined) return a.setErr(`${vi}: phải là số nguyên`);
      body[k] = v;
    }
    for (const [k] of FLAGS) if (f.has(`${k}__shown`)) body[k] = f.get(k) === 'on';
    if (weighted) {
      const plu = String(f.get('scale_plu') ?? '').trim();
      body['scale_plu'] = plu || null;
      body['sold_by_scale'] = plu ? f.get('sold_by_scale') === 'on' : false;
    }
    const note = String(f.get('storage_note') ?? '').trim();
    body['storage_note'] = note || null;
    void a.run(async () => {
      setSku(await bff<Sku>(`/api/admin/skus/${sku.id}`, 'PATCH', body));
      return 'Đã lưu thuộc tính';
    });
  }

  function toggleArchive() {
    if (!sku) return;
    if (!sku.archived_at && !window.confirm(`Lưu trữ SKU ${sku.sku_code}? SKU sẽ ngừng bán.`)) return;
    void a.run(async () => {
      setSku(
        await bff<Sku>(`/api/admin/skus/${sku.id}`, 'PATCH', { version: sku.version, archived: !sku.archived_at }),
      );
      return sku.archived_at ? 'Đã khôi phục' : 'Đã lưu trữ';
    });
  }

  function patchUnit(u: SkuUnit, body: Record<string, unknown>, msg: string) {
    void a.run(async () => {
      await bff(`/api/admin/skus/${u.sku_id}/units/${u.id}`, 'PATCH', body);
      await load();
      return msg;
    });
  }

  function addUnit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!sku) return;
    const form = e.currentTarget;
    const f = new FormData(form);
    const fg = parseIntOrNull(String(f.get('factor_g') ?? ''));
    const fu = parseIntOrNull(String(f.get('factor_units') ?? ''));
    if (fg === undefined || fu === undefined) return a.setErr('Hệ số quy đổi phải là số nguyên');
    const barcode = String(f.get('barcode') ?? '').trim();
    void a.run(async () => {
      await bff(`/api/admin/skus/${sku.id}/units`, 'POST', {
        unit_code: String(f.get('unit_code') ?? ''),
        name: String(f.get('name') ?? '').trim(),
        factor_g: fg,
        factor_units: fu,
        is_variable: f.get('is_variable') === 'on',
        for_sale: f.get('for_sale') === 'on',
        for_purchase: f.get('for_purchase') === 'on',
        ...(barcode ? { barcode } : {}),
      });
      form.reset();
      await load();
      return 'Đã thêm đơn vị';
    });
  }

  function savePrices(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!prices) return;
    const form = e.currentTarget;
    const f = new FormData(form);
    const reason = String(f.get('reason') ?? '').trim();
    if (reason.length < 3) return a.setErr('Nhập lý do đổi giá (ít nhất 3 ký tự)');
    const body: Record<string, unknown> = { reason, version: prices.version };
    const g = parseMoney(String(f.get('global') ?? ''));
    if (g === undefined) return a.setErr('Giá chung: chỉ nhập số (vd 52000 hoặc 52.000)');
    if (g !== prices.global) {
      if (g === null) return a.setErr('Không xóa được giá chung — nhập giá mới');
      body['global'] = g;
    }
    const cur = new Map(prices.stores.map((s) => [s.store_id, s.price]));
    const storesChanged: { store_id: string; price: string | null }[] = [];
    for (const s of stores) {
      if (!f.has(`store_${s.id}`)) continue;
      const v = parseMoney(String(f.get(`store_${s.id}`) ?? ''));
      if (v === undefined) return a.setErr(`Giá cửa hàng ${s.code}: chỉ nhập số`);
      if (v !== (cur.get(s.id) ?? null)) storesChanged.push({ store_id: s.id, price: v });
    }
    if (storesChanged.length) body['stores'] = storesChanged;
    const unitsChanged: { sku_unit_id: string; price: string | null }[] = [];
    for (const u of prices.units) {
      if (!f.has(`unit_${u.sku_unit_id}`)) continue;
      const v = parseMoney(String(f.get(`unit_${u.sku_unit_id}`) ?? ''));
      if (v === undefined) return a.setErr(`Giá ${u.name}: chỉ nhập số`);
      if (v !== u.price) unitsChanged.push({ sku_unit_id: u.sku_unit_id, price: v });
    }
    if (unitsChanged.length) body['units'] = unitsChanged;
    if (Object.keys(body).length === 2) return a.setNotice('Không có giá nào thay đổi');
    void a.run(async () => {
      await bff(`/api/admin/prices/${prices.sku_id}`, 'PUT', body);
      form.reset();
      await load();
      return 'Đã đổi giá — chỉ áp cho giao dịch mới';
    });
  }

  const unitName = (uid: string | null) => (uid ? (sku.units.find((u) => u.id === uid)?.name ?? uid.slice(0, 8)) : '');
  const storePrice = new Map(prices?.stores.map((s) => [s.store_id, s.price]) ?? []);
  const per = weighted ? '/kg' : '';

  return (
    <>
      <p>
        <Link href="/catalog">← Danh mục</Link>
      </p>
      <div className="card">
        <h1>
          <span className="mono">{sku.sku_code}</span> — {sku.name}{' '}
          {sku.archived_at && <span className="muted">(đã lưu trữ)</span>}
        </h1>
        <p className="muted">
          {SALE_TYPE_VI[sku.sale_unit_type]} · tồn theo{' '}
          {sku.stock_base === 'GRAM' ? 'gram' : sku.stock_base === 'COUNT' ? 'số đơn vị' : '— (không tồn)'} · cập nhật{' '}
          {dt(sku.updated_at)}
        </p>
        <Alert text={a.err} />
        <Alert text={a.notice} kind="notice" />
        <form onSubmit={saveAttrs} key={`attrs-${sku.version}`}>
          <div className="grid">
            <label>
              Tên SKU
              <input name="name" defaultValue={sku.name} required maxLength={200} />
            </label>
            {weighted && (
              <>
                <label>
                  PLU cân (5 số)
                  <input
                    name="scale_plu"
                    defaultValue={sku.scale_plu ?? ''}
                    inputMode="numeric"
                    pattern="\d{5}"
                    maxLength={5}
                  />
                </label>
                <label className="check">
                  <input type="checkbox" name="sold_by_scale" defaultChecked={sku.sold_by_scale} /> Bán qua cân in tem
                </label>
              </>
            )}
            {INT_FIELDS.filter(
              ([k]) =>
                !(noWeight && ['std_weight_g', 'weight_min_g', 'weight_max_g', 'tare_g'].includes(k)) &&
                !(sku.sale_unit_type === 'SERVICE' && !['std_weight_g'].includes(k)),
            ).map(([k, vi]) => (
              <label key={k}>
                {vi}
                <input name={k} defaultValue={sku[k] ?? ''} inputMode="numeric" />
              </label>
            ))}
            {sku.sale_unit_type !== 'SERVICE' &&
              FLAGS.map(([k, vi]) => (
                <label key={k} className="check">
                  <input type="hidden" name={`${k}__shown`} value="1" />
                  <input type="checkbox" name={k} defaultChecked={sku[k]} /> {vi}
                </label>
              ))}
            <label>
              Ghi chú bảo quản
              <input name="storage_note" defaultValue={sku.storage_note ?? ''} maxLength={500} />
            </label>
          </div>
          <div className="row">
            <button type="submit" disabled={a.busy}>
              Lưu thuộc tính
            </button>
            <button type="button" className="danger" disabled={a.busy} onClick={toggleArchive}>
              {sku.archived_at ? 'Khôi phục SKU' : 'Lưu trữ SKU'}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h2>Đơn vị bán / mua</h2>
        <p className="muted">Hệ số quy đổi không sửa được — sai thì lưu trữ đơn vị và thêm đơn vị mới.</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tên</th>
                <th>Quy đổi</th>
                <th>Bán</th>
                <th>Mua</th>
                <th>Mã vạch</th>
                <th>
                  <span className="sr-only">Thao tác</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sku.units.map((u) => (
                <tr key={u.id} className={u.archived_at ? 'archived' : undefined}>
                  <td>
                    {u.name} <span className="muted mono">({u.unit_code})</span>
                    {u.archived_at ? ' (đã lưu trữ)' : ''}
                  </td>
                  <td>
                    {u.is_variable
                      ? 'danh nghĩa (cân thực tế)'
                      : u.factor_g !== null
                        ? `${u.factor_g} g`
                        : u.factor_units !== null
                          ? `${u.factor_units} đơn vị`
                          : '—'}
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Bán theo ${u.name}`}
                      checked={u.for_sale}
                      disabled={a.busy || !!u.archived_at}
                      onChange={(e) => patchUnit(u, { for_sale: e.target.checked }, 'Đã lưu')}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Mua theo ${u.name}`}
                      checked={u.for_purchase}
                      disabled={a.busy || !!u.archived_at}
                      onChange={(e) => patchUnit(u, { for_purchase: e.target.checked }, 'Đã lưu')}
                    />
                  </td>
                  <td className="mono">{u.barcode ?? '—'}</td>
                  <td>
                    <div className="row">
                      <button
                        type="button"
                        className="secondary"
                        disabled={a.busy || !!u.archived_at}
                        aria-label={`Sửa ${u.name}`}
                        onClick={() => {
                          const name = window.prompt('Tên đơn vị:', u.name);
                          if (name === null) return;
                          const bc = window.prompt('Mã vạch (để trống = không có):', u.barcode ?? '');
                          if (bc === null) return;
                          patchUnit(u, { name: name.trim() || u.name, barcode: bc.trim() || null }, 'Đã lưu');
                        }}
                      >
                        Sửa
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={a.busy}
                        aria-label={`${u.archived_at ? 'Khôi phục' : 'Lưu trữ'} ${u.name}`}
                        onClick={() =>
                          patchUnit(u, { archived: !u.archived_at }, u.archived_at ? 'Đã khôi phục' : 'Đã lưu trữ')
                        }
                      >
                        {u.archived_at ? 'Khôi phục' : 'Lưu trữ'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!sku.archived_at && (
          <form onSubmit={addUnit} className="mt12">
            <h2>Thêm đơn vị</h2>
            <div className="grid">
              <label>
                Đơn vị
                <select name="unit_code" required defaultValue="">
                  <option value="" disabled>
                    — chọn —
                  </option>
                  {units.map((u) => (
                    <option key={u.code} value={u.code}>
                      {u.name} ({u.code})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Tên hiển thị (vd Hộp 500 g)
                <input name="name" required maxLength={100} />
              </label>
              {sku.stock_base === 'GRAM' && (
                <label>
                  Quy đổi (g)
                  <input name="factor_g" inputMode="numeric" />
                </label>
              )}
              {sku.stock_base === 'COUNT' && (
                <label>
                  Quy đổi (số đơn vị gốc)
                  <input name="factor_units" inputMode="numeric" />
                </label>
              )}
              <label className="check">
                <input type="checkbox" name="is_variable" /> Thùng danh nghĩa (cân thực tế khi nhận)
              </label>
              <label className="check">
                <input type="checkbox" name="for_sale" /> Bán theo đơn vị này
              </label>
              <label className="check">
                <input type="checkbox" name="for_purchase" defaultChecked /> Mua theo đơn vị này
              </label>
              <label>
                Mã vạch (tùy chọn)
                <input name="barcode" maxLength={32} />
              </label>
            </div>
            <button type="submit" disabled={a.busy}>
              Thêm đơn vị
            </button>
          </form>
        )}
      </div>

      {prices && (
        <div className="card">
          <h2>Giá bán lẻ</h2>
          <p className="muted">
            Đổi giá chỉ áp cho giao dịch mới; mọi thay đổi ghi lịch sử (người, lúc, lý do). Cần xác thực lại nếu được
            hỏi.
          </p>
          <form onSubmit={savePrices} key={`prices-${prices.version}`}>
            <div className="grid">
              <label>
                Giá chung {per} (đ)
                <input name="global" defaultValue={prices.global ?? ''} inputMode="numeric" maxLength={20} />
              </label>
            </div>
            {stores.length > 0 && (
              <>
                <h2>Giá riêng theo cửa hàng (để trống = dùng giá chung)</h2>
                <div className="grid">
                  {stores
                    .filter((s) => !s.archived_at || storePrice.has(s.id))
                    .map((s) => (
                      <label key={s.id}>
                        {s.code} — {s.name} {per}
                        <input
                          name={`store_${s.id}`}
                          defaultValue={storePrice.get(s.id) ?? ''}
                          inputMode="numeric"
                          maxLength={20}
                        />
                      </label>
                    ))}
                </div>
              </>
            )}
            {prices.units.some((u) => u.for_sale && !u.archived_at) && (
              <>
                <h2>Giá riêng của đơn vị bán (để trống = giá SKU × quy đổi)</h2>
                <div className="grid">
                  {prices.units
                    .filter((u) => u.for_sale && !u.archived_at)
                    .map((u) => (
                      <label key={u.sku_unit_id}>
                        {u.name}
                        <input
                          name={`unit_${u.sku_unit_id}`}
                          defaultValue={u.price ?? ''}
                          inputMode="numeric"
                          maxLength={20}
                        />
                      </label>
                    ))}
                </div>
              </>
            )}
            <label>
              Lý do đổi giá
              <input name="reason" required minLength={3} maxLength={500} />
            </label>
            <button type="submit" disabled={a.busy}>
              Lưu giá
            </button>
          </form>
        </div>
      )}

      <div className="card">
        <h2>Lịch sử giá</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Lúc</th>
                <th>Phạm vi</th>
                <th>Loại</th>
                <th>Cũ → mới</th>
                <th>Lý do</th>
                <th>Người đổi</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{dt(h.changed_at)}</td>
                  <td>{h.scope === 'GLOBAL' ? 'Chung' : (storeName.get(h.store_id ?? '') ?? 'Cửa hàng')}</td>
                  <td>
                    {FIELD_VI[h.field]} {unitName(h.sku_unit_id)}
                  </td>
                  <td>
                    {money(h.old_value)} → {money(h.new_value)}
                  </td>
                  <td className="wrap">{h.reason}</td>
                  <td className="mono">{h.changed_by.slice(0, 8)}</td>
                </tr>
              ))}
              {!history.length && (
                <tr>
                  <td colSpan={6} className="muted">
                    Chưa có thay đổi giá
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
