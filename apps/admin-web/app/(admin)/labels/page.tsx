'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert } from '../../../components/Alert';
import { bff, csrfToken, saveUrl } from '../../../lib/client/api';
import type { BarcodeRule, Category, Sku } from '../../../lib/client/types';
import { useAction } from '../../../lib/client/use-action';
import { useStores } from '../../../lib/client/use-stores';

type Tab = 'shelf' | 'rules' | 'plu';

/** A10 — tem giá kệ (in hàng loạt), quy tắc mã vạch cân (thứ tự ưu tiên, thử giải mã), file PLU cho cân. */
export default function LabelsPage() {
  const [tab, setTab] = useState<Tab>('shelf');
  return (
    <>
      <div className="tabs" role="group" aria-label="Tem và mã vạch">
        {(
          [
            ['shelf', 'In tem giá kệ'],
            ['rules', 'Quy tắc mã vạch'],
            ['plu', 'File PLU cho cân'],
          ] as const
        ).map(([k, vi]) => (
          <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>
            {vi}
          </button>
        ))}
      </div>
      {tab === 'shelf' && <ShelfTab />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'plu' && <PluTab />}
    </>
  );
}

// ───────── tem giá kệ ─────────

function ShelfTab() {
  const stores = useStores();
  const [cats, setCats] = useState<Category[]>([]);
  const [by, setBy] = useState<'category' | 'skus'>('category');
  const [found, setFound] = useState<Sku[]>([]);
  const [picked, setPicked] = useState<Map<string, Sku>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const payload = useRef<HTMLInputElement>(null);
  const csrf = useRef<HTMLInputElement>(null);
  const a = useAction();

  useEffect(() => {
    void a.load(async () => {
      setCats((await bff<{ items: Category[] }>('/api/admin/categories')).items);
    });
  }, [a.load]);

  /** chạy TRƯỚC khi trình duyệt gửi form vào iframe: điền mã CSRF + yêu cầu JSON; thiếu dữ liệu ⇒ chặn gửi */
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    const f = new FormData(e.currentTarget);
    const store = String(f.get('store_id') ?? '');
    const body: Record<string, unknown> = { layout: String(f.get('layout') ?? 'A4_24') };
    if (store) body['store_id'] = store;
    if (by === 'category') {
      const c = String(f.get('category_id') ?? '');
      if (!c) {
        e.preventDefault();
        return a.setErr('Chọn danh mục');
      }
      body['category_id'] = c;
    } else {
      if (!picked.size) {
        e.preventDefault();
        return a.setErr('Chọn ít nhất một SKU');
      }
      body['sku_ids'] = [...picked.keys()];
    }
    a.setErr('');
    if (payload.current) payload.current.value = JSON.stringify(body);
    if (csrf.current) csrf.current.value = csrfToken();
    setLoaded(false);
  }

  function print() {
    try {
      frame.current?.contentWindow?.print();
    } catch {
      a.setErr('Không mở được hộp in — bấm chuột phải vào trang tem rồi chọn In');
    }
  }

  return (
    <div className="card">
      <h1>In tem giá kệ</h1>
      <Alert text={a.err} />
      <p className="muted">
        Hàng cân in giá/kg + PLU; hàng đếm in theo đơn vị bán có mã vạch (vd hộp), giá riêng của đơn vị hoặc giá SKU ×
        quy đổi. Không chọn cửa hàng = giá chung.
      </p>
      <form method="post" action="/bff/labels" target="labels-frame" onSubmit={onSubmit}>
        <input type="hidden" name="payload" ref={payload} />
        <input type="hidden" name="csrf" ref={csrf} />
        <div className="grid">
          <label>
            Cửa hàng
            <select name="store_id" defaultValue="">
              <option value="">(Giá chung)</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Khổ
            <select name="layout" defaultValue="A4_24">
              <option value="A4_24">A4 — 24 tem (3 × 8)</option>
              <option value="A4_10">A4 — 10 tem lớn (2 × 5)</option>
            </select>
          </label>
          <label>
            Chọn hàng theo
            <select value={by} onChange={(e) => setBy(e.target.value as 'category' | 'skus')}>
              <option value="category">Cả danh mục</option>
              <option value="skus">Từng SKU</option>
            </select>
          </label>
          {by === 'category' && (
            <label>
              Danh mục
              <select name="category_id" defaultValue="">
                <option value="">— chọn —</option>
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {by === 'skus' && (
          <>
            <div className="row">
              <label className="grow">
                Tìm SKU
                <input
                  id="shelf-q"
                  maxLength={100}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    const q = e.currentTarget.value.trim();
                    if (q)
                      void a.load(async () => {
                        setFound(
                          (await bff<{ items: Sku[] }>(`/api/admin/skus?q=${encodeURIComponent(q)}&limit=50`)).items,
                        );
                      });
                  }}
                />
              </label>
              <span className="muted">Enter để tìm · đã chọn {picked.size}</span>
            </div>
            <div className="table-wrap scroll-box">
              <table>
                <tbody>
                  {[...picked.values(), ...found.filter((s) => !picked.has(s.id))].map((s) => (
                    <tr key={s.id}>
                      <td>
                        <label className="check mb0">
                          <input
                            type="checkbox"
                            checked={picked.has(s.id)}
                            onChange={(e) => {
                              const on = e.target.checked;
                              if (on && picked.size >= 500) return a.setErr('Tối đa 500 SKU mỗi lần in');
                              setPicked((cur) => {
                                const m = new Map(cur);
                                if (on) m.set(s.id, s);
                                else m.delete(s.id);
                                return m;
                              });
                            }}
                          />
                          <span className="mono">{s.sku_code}</span> {s.name}
                        </label>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="row">
          <button type="submit">Tạo trang tem</button>
          <button type="button" className="secondary" disabled={!loaded} onClick={print}>
            In
          </button>
        </div>
      </form>
      <iframe
        ref={frame}
        name="labels-frame"
        title="Trang tem giá kệ"
        className="labels mt12"
        // KHÔNG allow-scripts: trang tem không chạy mã; allow-same-origin chỉ để nút In gọi print()
        sandbox="allow-same-origin allow-modals"

        // chỉ bật In khi khung có trang tem thật (trang lỗi không có .page — review react T12)
        onLoad={() => setLoaded(!!frame.current?.contentDocument?.querySelector('.page'))}
      />
    </div>
  );
}

// ───────── quy tắc mã vạch ─────────

const RULE_TYPE_VI: Record<string, string> = {
  WEIGHT: 'Tem cân theo khối lượng',
  PRICE: 'Tem cân theo tiền',
  PRODUCT: 'Mã hàng',
  BATCH: 'Lô',
  ORDER: 'Đơn',
  STAFF: 'Nhân viên',
};

function RulesTab() {
  const [rules, setRules] = useState<BarcodeRule[]>([]);
  const [order, setOrder] = useState<string[] | null>(null);
  const [decoded, setDecoded] = useState<string>('');
  const a = useAction();
  const load = useCallback(async () => {
    setRules((await bff<{ items: BarcodeRule[] }>('/api/admin/barcode-rules')).items);
    setOrder(null);
  }, []);
  useEffect(() => {
    void a.load(load);
  }, [load, a.load]);

  const shown = order ? order.map((id) => rules.find((r) => r.id === id)).filter((r): r is BarcodeRule => !!r) : rules;

  function move(i: number, d: -1 | 1) {
    const ids = shown.map((r) => r.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j] as string, ids[i] as string];
    setOrder(ids);
  }

  function saveOrder() {
    if (!order) return;
    void a.run(async () => {
      const r = await bff<{ items: BarcodeRule[] }>('/api/admin/barcode-rules/reorder', 'POST', { ids: order });
      setRules(r.items);
      setOrder(null);
      return 'Đã lưu thứ tự ưu tiên';
    });
  }

  function patch(r: BarcodeRule, body: Record<string, unknown>, msg: string) {
    void a.run(async () => {
      await bff(`/api/admin/barcode-rules/${r.id}`, 'PATCH', body);
      await load();
      return msg;
    });
  }

  function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const s = (k: string) => String(f.get(k) ?? '').trim();
    const top = rules.reduce((m, r) => Math.max(m, r.priority), 0);
    void a.run(async () => {
      await bff('/api/admin/barcode-rules', 'POST', {
        code: s('code'),
        name: s('name'),
        priority: Math.min(10000, top + 10),
        type: s('type'),
        pattern: s('pattern'),
        value_scale: Number(s('value_scale') || '1'),
        ean13_checksum: f.get('ean13_checksum') === 'on',
        enabled: false,
      });
      form.reset();
      await load();
      return 'Đã thêm quy tắc (đang tắt — bật khi đã thử)';
    });
  }

  function decode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '')
      .trim()
      .toUpperCase();
    if (!code) return;
    void a.run(async () => {
      const r = await bff<Record<string, unknown>>(`/api/admin/barcode-rules/decode?code=${encodeURIComponent(code)}`);
      if (r['ok']) {
        const sku = r['sku'] as { sku_code: string; name: string } | null;
        setDecoded(
          `Khớp ${String(r['rule'])}: PLU ${String(r['plu'] ?? '—')}, ${r['grams'] !== null ? `${String(r['grams'])} g` : ''}${r['amount'] !== null ? ` ${String(r['amount'])}đ` : ''} ⇒ ${sku ? `${sku.sku_code} ${sku.name}` : 'không thấy SKU đang dùng'}`,
        );
      } else
        setDecoded(
          r['reason'] === 'CHECKSUM'
            ? `Sai số kiểm (khớp cấu trúc quy tắc ${String(r['rule'])})`
            : 'Không khớp quy tắc nào đang bật',
        );
    });
  }

  return (
    <div className="card">
      <h1>Quy tắc mã vạch</h1>
      <Alert text={a.err} />
      <Alert text={a.notice} kind="notice" />
      <p className="muted">
        Máy quét thử các quy tắc ĐANG BẬT từ trên xuống. Tem cân bắt đầu 20–29, vd{' '}
        <span className="mono">20{'{PLU:5}{W:5}{C}'}</span>.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Thứ tự</th>
              <th>Mã</th>
              <th>Tên</th>
              <th>Loại</th>
              <th>Mẫu</th>
              <th>Bật</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={r.id}>
                <td>
                  <div className="row">
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Đưa ${r.code} lên`}
                      disabled={a.busy || i === 0}
                      onClick={() => move(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Đưa ${r.code} xuống`}
                      disabled={a.busy || i === shown.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>
                  </div>
                </td>
                <td className="mono">{r.code}</td>
                <td>{r.name}</td>
                <td>{RULE_TYPE_VI[r.type] ?? r.type}</td>
                <td className="mono">
                  {r.pattern}
                  {r.ean13_checksum ? ' · EAN-13' : ''}
                  {r.value_scale !== 1 ? ` · ×${r.value_scale}` : ''}
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Bật ${r.code}`}
                    checked={r.enabled}
                    disabled={a.busy || !!order}
                    onChange={(e) => patch(r, { enabled: e.target.checked }, e.target.checked ? 'Đã bật' : 'Đã tắt')}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {order && (
        <div className="row mt8">
          <button type="button" disabled={a.busy} onClick={saveOrder}>
            Lưu thứ tự
          </button>
          <button type="button" className="secondary" disabled={a.busy} onClick={() => setOrder(null)}>
            Hủy
          </button>
        </div>
      )}

      <h2 className="mt16">Thử một mã vạch</h2>
      <form onSubmit={decode} className="row">
        <label className="grow">
          Mã vạch
          <input name="code" maxLength={64} pattern="[0-9A-Za-z\-]{1,64}" />
        </label>
        <button type="submit" disabled={a.busy}>
          Thử
        </button>
      </form>
      {decoded && (
        <p className="notice" role="status">
          {decoded}
        </p>
      )}

      <h2 className="mt16">Thêm quy tắc</h2>
      <form onSubmit={create} className="grid">
        <label>
          Mã
          <input name="code" required maxLength={16} />
        </label>
        <label>
          Tên
          <input name="name" required maxLength={100} />
        </label>
        <label>
          Loại
          <select name="type" defaultValue="WEIGHT">
            {Object.entries(RULE_TYPE_VI).map(([k, vi]) => (
              <option key={k} value={k}>
                {vi}
              </option>
            ))}
          </select>
        </label>
        <label>
          Mẫu
          <input name="pattern" required maxLength={64} placeholder="21{PLU:5}{W:5}{C}" />
        </label>
        <label>
          Hệ số phần nhúng
          <select name="value_scale" defaultValue="1">
            <option value="1">1 (gram / đồng)</option>
            <option value="10">10</option>
            <option value="100">100</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" name="ean13_checksum" defaultChecked /> Kiểm số EAN-13
        </label>
        <div>
          <button type="submit" disabled={a.busy}>
            Thêm quy tắc
          </button>
        </div>
      </form>
    </div>
  );
}

// ───────── file PLU ─────────

function PluTab() {
  const stores = useStores();
  const [skipped, setSkipped] = useState<string[]>([]);
  const a = useAction();
  function run(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const store = String(f.get('store_id') ?? '');
    void a.run(async () => {
      const r = await bff<{ url: string; rows: number; skipped_no_price: string[] }>('/api/admin/plu-export', 'POST', {
        format: String(f.get('format') ?? 'CSV'),
        ...(store ? { store_id: store } : {}),
      });
      setSkipped(r.skipped_no_price);
      saveUrl(r.url);
      return `Đã xuất ${r.rows} PLU (link tải hiệu lực 60 giây)`;
    });
  }
  return (
    <div className="card">
      <h1>File PLU cho cân</h1>
      <Alert text={a.err} />
      <Alert text={a.notice} kind="notice" />
      <p className="muted">Chỉ SKU bán qua cân có PLU và có giá; mỗi lần xuất được ghi nhật ký.</p>
      <form onSubmit={run} className="grid">
        <label>
          Cửa hàng
          <select name="store_id" defaultValue="">
            <option value="">(Giá chung)</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} — {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Định dạng
          <select name="format" defaultValue="CSV">
            <option value="CSV">CSV (UTF-8)</option>
            <option value="XLSX">Excel</option>
          </select>
        </label>
        <div>
          <button type="submit" disabled={a.busy}>
            Xuất file PLU
          </button>
        </div>
      </form>
      {skipped.length > 0 && (
        <p className="notice">
          Bỏ qua vì chưa có giá: <span className="mono">{skipped.join(', ')}</span>
        </p>
      )}
    </div>
  );
}
