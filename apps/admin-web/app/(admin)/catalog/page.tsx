'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Alert } from '../../../components/Alert';
import { bff } from '../../../lib/client/api';
import { money, parseIntOrNull } from '../../../lib/client/format';
import {
  SALE_TYPE_VI,
  WEIGHT_PRICED,
  type Category,
  type Product,
  type SaleUnitType,
  type Sku,
  type Unit,
} from '../../../lib/client/types';
import { useAction } from '../../../lib/client/use-action';

type Tab = 'tree' | 'skus' | 'units';

/** A10 — danh mục: cây danh mục + sản phẩm, SKU (tìm, tạo), đơn vị tính. Sửa SKU / đơn vị / giá ở trang chi tiết SKU. */
export default function CatalogPage() {
  const [tab, setTab] = useState<Tab>('tree');
  return (
    <>
      <div className="tabs" role="group" aria-label="Danh mục">
        {(
          [
            ['tree', 'Danh mục & sản phẩm'],
            ['skus', 'SKU'],
            ['units', 'Đơn vị tính'],
          ] as const
        ).map(([k, vi]) => (
          <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>
            {vi}
          </button>
        ))}
      </div>
      {tab === 'tree' && <TreeTab />}
      {tab === 'skus' && <SkusTab />}
      {tab === 'units' && <UnitsTab />}
    </>
  );
}

// ───────── cây danh mục + sản phẩm ─────────

function TreeTab() {
  const [cats, setCats] = useState<Category[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const a = useAction();

  const loadCats = useCallback(async () => {
    setCats((await bff<{ items: Category[] }>('/api/admin/categories?include_archived=true')).items);
  }, []);
  /** danh mục đang chọn — phản hồi muộn của danh mục chọn trước bị bỏ (review react lát 7 T9) */
  const selRef = useRef<string | null>(null);
  selRef.current = sel;
  const loadProducts = useCallback(async (id: string | null) => {
    if (!id) return setProducts([]);
    const r = await bff<{ items: Product[] }>(`/api/admin/products?category_id=${id}&include_archived=true`);
    if (selRef.current === id) setProducts(r.items);
  }, []);
  useEffect(() => {
    void a.load(loadCats);
  }, [loadCats, a.load]);
  useEffect(() => {
    // đổi danh mục ⇒ xóa bảng cũ ngay (không để sản phẩm danh mục trước nằm dưới tiêu đề mới — review react cổng CP04 T6)
    setProducts([]);
    void a.load(() => loadProducts(sel));
  }, [sel, loadProducts, a.load]);

  const children = useMemo(() => {
    const m = new Map<string | null, Category[]>();
    for (const c of cats) {
      if (!showArchived && c.archived_at) continue;
      const k = c.parent_id;
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    for (const l of m.values()) l.sort((x, y) => x.sort - y.sort || x.name.localeCompare(y.name, 'vi'));
    return m;
  }, [cats, showArchived]);
  const current = cats.find((c) => c.id === sel) ?? null;

  function addCategory(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const name = String(f.get('name') ?? '').trim();
    const asChild = f.get('child') === 'on';
    void a.run(async () => {
      await bff('/api/admin/categories', 'POST', { name, parent_id: asChild && sel ? sel : null });
      form.reset();
      await loadCats();
      return `Đã thêm danh mục "${name}"`;
    });
  }

  function patchCategory(c: Category, body: Record<string, unknown>, msg: string) {
    void a.run(async () => {
      await bff(`/api/admin/categories/${c.id}`, 'PATCH', body);
      await loadCats();
      return msg;
    });
  }

  function renameCategory(c: Category) {
    const name = window.prompt('Tên mới của danh mục:', c.name)?.trim();
    if (!name || name === c.name) return;
    patchCategory(c, { name }, 'Đã đổi tên');
  }

  function moveCategory(c: Category, parent: string) {
    patchCategory(c, { parent_id: parent || null }, 'Đã chuyển danh mục');
  }

  function addProduct(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!sel) return;
    const form = e.currentTarget;
    const f = new FormData(form);
    const origin = String(f.get('origin') ?? '').trim();
    void a.run(async () => {
      await bff('/api/admin/products', 'POST', {
        category_id: sel,
        name: String(f.get('name') ?? '').trim(),
        origin: origin || null,
      });
      form.reset();
      await loadProducts(sel);
      return 'Đã thêm sản phẩm';
    });
  }

  function patchProduct(p: Product, body: Record<string, unknown>, msg: string) {
    void a.run(async () => {
      await bff(`/api/admin/products/${p.id}`, 'PATCH', body);
      await loadProducts(sel);
      return msg;
    });
  }

  const renderTree = (parent: string | null) => {
    const list = children.get(parent) ?? [];
    if (!list.length) return null;
    return (
      <ul className="tree">
        {list.map((c) => (
          <li key={c.id} className={c.archived_at ? 'archived' : undefined}>
            <button type="button" className="link" aria-pressed={sel === c.id} onClick={() => setSel(c.id)}>
              {c.name}
              {c.archived_at ? ' (đã lưu trữ)' : ''}
            </button>
            {renderTree(c.id)}
          </li>
        ))}
      </ul>
    );
  };

  // không cho chọn chính nó / con cháu làm cha
  const descendants = useMemo(() => {
    const out = new Set<string>();
    if (!sel) return out;
    const walk = (id: string) => {
      out.add(id);
      for (const c of cats) if (c.parent_id === id) walk(c.id);
    };
    walk(sel);
    return out;
  }, [cats, sel]);

  return (
    <>
      <div className="card">
        <h1>Cây danh mục</h1>
        <Alert text={a.err} />
        <Alert text={a.notice} kind="notice" />
        <label className="check">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Hiện danh mục đã lưu trữ
        </label>
        {renderTree(null) ?? <p className="muted">Chưa có danh mục</p>}
        <form onSubmit={addCategory} className="row mt12">
          <label className="grow">
            Tên danh mục mới
            <input name="name" required maxLength={100} />
          </label>
          {sel && (
            <label className="check mb0">
              <input type="checkbox" name="child" defaultChecked /> Là danh mục con của “{current?.name}”
            </label>
          )}
          <button type="submit" disabled={a.busy}>
            Thêm danh mục
          </button>
        </form>
      </div>

      {current && (
        <div className="card">
          <h2>
            {current.name} {current.archived_at && <span className="muted">(đã lưu trữ)</span>}
          </h2>
          <div className="row mb12">
            <button type="button" className="secondary" disabled={a.busy} onClick={() => renameCategory(current)}>
              Đổi tên
            </button>
            <label className="mb0">
              <span className="sr-only">Chuyển vào danh mục</span>
              <select
                value={current.parent_id ?? ''}
                disabled={a.busy}
                onChange={(e) => moveCategory(current, e.target.value)}
              >
                <option value="">(Gốc — không có danh mục cha)</option>
                {current.parent_id && !cats.some((c) => c.id === current.parent_id && !c.archived_at) && (
                  <option value={current.parent_id} disabled>
                    Trong: {cats.find((c) => c.id === current.parent_id)?.name ?? '?'} (đã lưu trữ)
                  </option>
                )}
                {cats
                  .filter((c) => !c.archived_at && !descendants.has(c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      Trong: {c.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              className="danger"
              disabled={a.busy}
              onClick={() =>
                patchCategory(
                  current,
                  { archived: !current.archived_at },
                  current.archived_at ? 'Đã khôi phục' : 'Đã lưu trữ',
                )
              }
            >
              {current.archived_at ? 'Khôi phục' : 'Lưu trữ'}
            </button>
          </div>

          <h2>Sản phẩm trong danh mục</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tên</th>
                  <th>Xuất xứ</th>
                  <th>
                    <span className="sr-only">Thao tác</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id} className={p.archived_at ? 'archived' : undefined}>
                    <td>
                      {p.name}
                      {p.archived_at ? ' (đã lưu trữ)' : ''}
                    </td>
                    <td>{p.origin ?? '—'}</td>
                    <td>
                      <div className="row">
                        <button
                          type="button"
                          className="secondary"
                          disabled={a.busy}
                          aria-label={`Đổi tên ${p.name}`}
                          onClick={() => {
                            const name = window.prompt('Tên mới của sản phẩm:', p.name)?.trim();
                            if (name && name !== p.name) patchProduct(p, { name }, 'Đã đổi tên sản phẩm');
                          }}
                        >
                          Đổi tên
                        </button>
                        <button
                          type="button"
                          className="danger"
                          disabled={a.busy}
                          aria-label={`${p.archived_at ? 'Khôi phục' : 'Lưu trữ'} ${p.name}`}
                          onClick={() =>
                            patchProduct(p, { archived: !p.archived_at }, p.archived_at ? 'Đã khôi phục' : 'Đã lưu trữ')
                          }
                        >
                          {p.archived_at ? 'Khôi phục' : 'Lưu trữ'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!products.length && (
                  <tr>
                    <td colSpan={3} className="muted">
                      Chưa có sản phẩm
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {!current.archived_at && (
            <form onSubmit={addProduct} className="grid mt12">
              <label>
                Tên sản phẩm mới
                <input name="name" required maxLength={200} />
              </label>
              <label>
                Xuất xứ
                <input name="origin" maxLength={100} />
              </label>
              <div>
                <button type="submit" disabled={a.busy}>
                  Thêm sản phẩm
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </>
  );
}

// ───────── SKU ─────────

function SkusTab() {
  const [items, setItems] = useState<Sku[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [q, setQ] = useState('');
  /** từ khóa ĐÃ gửi — "Xem thêm" không dùng ô đang gõ (review react T10) */
  const applied = useRef('');
  const [archived, setArchived] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [type, setType] = useState<SaleUnitType>('WEIGHT');
  const a = useAction();

  const load = useCallback(
    async (after?: string) => {
      const p = new URLSearchParams({ limit: '100' });
      if (applied.current) p.set('q', applied.current);
      if (archived) p.set('include_archived', 'true');
      if (after) p.set('after', after);
      const r = await bff<{ items: Sku[]; next_after: string | null }>(`/api/admin/skus?${p}`);
      setItems((cur) => (after ? [...cur, ...r.items] : r.items));
      setNext(r.next_after);
    },
    [archived],
  );
  useEffect(() => {
    void a.load(async () => {
      const [p, u] = await Promise.all([
        bff<{ items: Product[] }>('/api/admin/products'),
        bff<{ items: Unit[] }>('/api/admin/units'),
      ]);
      setProducts(p.items);
      setUnits(u.items);
    });
  }, [a.load]);
  // tìm lại khi đổi bộ lọc lưu trữ; ô tìm gửi bằng nút
  useEffect(() => {
    void a.load(() => load());
  }, [load, a.load]);

  const weighted = WEIGHT_PRICED.has(type);
  const noWeight = type === 'BUNDLE' || type === 'SERVICE';
  const baseUnits = units.filter((u) => !u.archived_at && (weighted ? u.kind === 'WEIGHT' : u.kind === 'COUNT'));

  function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const s = (k: string) => String(f.get(k) ?? '').trim();
    const ints: Record<string, number | null> = {};
    for (const k of ['std_weight_g', 'weight_min_g', 'weight_max_g', 'tare_g', 'shelf_life_days']) {
      const v = parseIntOrNull(s(k));
      if (v === undefined) {
        a.setErr(`Ô ${k} phải là số nguyên`);
        return;
      }
      if (v !== null) ints[k] = v;
    }
    const body: Record<string, unknown> = {
      product_id: s('product_id'),
      sku_code: s('sku_code'),
      name: s('name'),
      sale_unit_type: type,
      ...ints,
    };
    if (s('base_unit_code')) body['base_unit_code'] = s('base_unit_code');
    if (s('barcode')) body['barcode'] = s('barcode');
    if (weighted && s('scale_plu')) {
      body['scale_plu'] = s('scale_plu');
      body['sold_by_scale'] = f.get('sold_by_scale') === 'on';
    }
    void a.run(async () => {
      const sku = await bff<Sku>('/api/admin/skus', 'POST', body);
      form.reset();
      await load();
      return `Đã tạo SKU ${sku.sku_code} — đặt giá ở trang chi tiết`;
    });
  }

  return (
    <>
      <div className="card">
        <h1>SKU</h1>
        <Alert text={a.err} />
        <Alert text={a.notice} kind="notice" />
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            applied.current = q.trim();
            void a.load(() => load());
          }}
        >
          <label className="grow">
            Tìm theo mã / tên
            <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} />
          </label>
          <label className="check mb0">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Gồm SKU đã lưu
            trữ
          </label>
          <button type="submit" disabled={a.busy}>
            Tìm
          </button>
        </form>
        <div className="table-wrap mt12">
          <table>
            <thead>
              <tr>
                <th>Mã</th>
                <th>Tên</th>
                <th>Kiểu bán</th>
                <th>PLU</th>
                <th>Giá lẻ chung</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className={s.archived_at ? 'archived' : undefined}>
                  <td className="mono">
                    <Link href={`/catalog/skus/${s.id}`}>{s.sku_code}</Link>
                  </td>
                  <td>
                    {s.name}
                    {s.archived_at ? ' (đã lưu trữ)' : ''}
                  </td>
                  <td>{SALE_TYPE_VI[s.sale_unit_type]}</td>
                  <td className="mono">{s.scale_plu ?? '—'}</td>
                  <td>
                    {WEIGHT_PRICED.has(s.sale_unit_type)
                      ? `${money(s.retail_price_per_kg)}/kg`
                      : money(s.retail_price_per_unit)}
                  </td>
                </tr>
              ))}
              {!items.length && (
                <tr>
                  <td colSpan={5} className="muted">
                    Không có SKU
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {next && (
          <button type="button" className="secondary" disabled={a.busy} onClick={() => void a.run(() => load(next))}>
            Xem thêm
          </button>
        )}
      </div>

      <div className="card">
        <h2>Tạo SKU</h2>
        <p className="muted">
          Mã SKU, kiểu bán và hệ số quy đổi không sửa được sau khi tạo — nhập sai thì lưu trữ rồi tạo SKU mới.
        </p>
        <form onSubmit={create}>
          <div className="grid">
            <label>
              Sản phẩm
              <select name="product_id" required defaultValue="">
                <option value="" disabled>
                  — chọn —
                </option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Mã SKU
              <input name="sku_code" required maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{0,31}" />
            </label>
            <label>
              Tên SKU
              <input name="name" required maxLength={200} />
            </label>
            <label>
              Kiểu bán
              <select value={type} onChange={(e) => setType(e.target.value as SaleUnitType)}>
                {Object.entries(SALE_TYPE_VI).map(([k, vi]) => (
                  <option key={k} value={k}>
                    {vi}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Đơn vị gốc
              <select name="base_unit_code" defaultValue="">
                <option value="">(mặc định theo kiểu bán)</option>
                {baseUnits.map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.name} ({u.code})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Mã vạch (tùy chọn)
              <input name="barcode" maxLength={32} />
            </label>
            {weighted && (
              <>
                <label>
                  PLU cân (5 số)
                  <input name="scale_plu" inputMode="numeric" pattern="\d{5}" maxLength={5} />
                </label>
                <label className="check">
                  <input type="checkbox" name="sold_by_scale" /> Bán qua cân in tem
                </label>
              </>
            )}
            {!noWeight && (
              <>
                <label>
                  Trọng lượng chuẩn (g){type === 'PACK_FIXED' ? ' — bắt buộc' : ''}
                  <input name="std_weight_g" inputMode="numeric" required={type === 'PACK_FIXED'} />
                </label>
                <label>
                  Cân tối thiểu (g)
                  <input name="weight_min_g" inputMode="numeric" />
                </label>
                <label>
                  Cân tối đa (g)
                  <input name="weight_max_g" inputMode="numeric" />
                </label>
                <label>
                  Bì (g)
                  <input name="tare_g" inputMode="numeric" />
                </label>
              </>
            )}
            {type !== 'SERVICE' && (
              <label>
                Hạn dùng (ngày)
                <input name="shelf_life_days" inputMode="numeric" />
              </label>
            )}
          </div>
          <button type="submit" disabled={a.busy}>
            Tạo SKU
          </button>
        </form>
      </div>
    </>
  );
}

// ───────── đơn vị tính ─────────

function UnitsTab() {
  const [items, setItems] = useState<Unit[]>([]);
  const a = useAction();
  const load = useCallback(async () => {
    setItems((await bff<{ items: Unit[] }>('/api/admin/units?include_archived=true')).items);
  }, []);
  useEffect(() => {
    void a.load(load);
  }, [load, a.load]);

  function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const fixed = parseIntOrNull(String(f.get('fixed_g') ?? ''));
    if (fixed === undefined) return a.setErr('Khối lượng cố định phải là số nguyên (g)');
    void a.run(async () => {
      await bff('/api/admin/units', 'POST', {
        code: String(f.get('code') ?? '').trim(),
        name: String(f.get('name') ?? '').trim(),
        kind: String(f.get('kind')),
        ...(fixed !== null ? { fixed_g: fixed } : {}),
      });
      form.reset();
      await load();
      return 'Đã thêm đơn vị';
    });
  }

  function patch(u: Unit, body: Record<string, unknown>, msg: string) {
    void a.run(async () => {
      await bff(`/api/admin/units/${encodeURIComponent(u.code)}`, 'PATCH', body);
      await load();
      return msg;
    });
  }

  return (
    <div className="card">
      <h1>Đơn vị tính</h1>
      <Alert text={a.err} />
      <Alert text={a.notice} kind="notice" />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Mã</th>
              <th>Tên</th>
              <th>Loại</th>
              <th>Khối lượng cố định</th>
              <th>
                <span className="sr-only">Thao tác</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((u) => (
              <tr key={u.code} className={u.archived_at ? 'archived' : undefined}>
                <td className="mono">{u.code}</td>
                <td>{u.name}</td>
                <td>{u.kind === 'WEIGHT' ? 'Khối lượng' : 'Đếm'}</td>
                <td>{u.fixed_g !== null ? `${u.fixed_g} g` : '—'}</td>
                <td>
                  <div className="row">
                    <button
                      type="button"
                      className="secondary"
                      disabled={a.busy}
                      aria-label={`Đổi tên ${u.code}`}
                      onClick={() => {
                        const name = window.prompt('Tên mới:', u.name)?.trim();
                        if (name && name !== u.name) patch(u, { name }, 'Đã đổi tên');
                      }}
                    >
                      Đổi tên
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={a.busy}
                      aria-label={`${u.archived_at ? 'Khôi phục' : 'Lưu trữ'} ${u.code}`}
                      onClick={() =>
                        patch(u, { archived: !u.archived_at }, u.archived_at ? 'Đã khôi phục' : 'Đã lưu trữ')
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
      <h2 className="mt16">Thêm đơn vị</h2>
      <form onSubmit={create} className="grid">
        <label>
          Mã (chữ HOA)
          <input name="code" required maxLength={16} pattern="[A-Za-z][A-Za-z0-9_]{0,15}" />
        </label>
        <label>
          Tên
          <input name="name" required maxLength={50} />
        </label>
        <label>
          Loại
          <select name="kind" defaultValue="COUNT">
            <option value="COUNT">Đếm (quả, hộp, thùng…)</option>
            <option value="WEIGHT">Khối lượng</option>
          </select>
        </label>
        <label>
          Khối lượng cố định (g, tùy chọn)
          <input name="fixed_g" inputMode="numeric" />
        </label>
        <div>
          <button type="submit" disabled={a.busy}>
            Thêm đơn vị
          </button>
        </div>
      </form>
    </div>
  );
}
