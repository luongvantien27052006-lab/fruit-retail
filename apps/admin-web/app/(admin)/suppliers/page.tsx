'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert } from '../../../components/Alert';
import { bff } from '../../../lib/client/api';
import { dt, parseIntOrNull } from '../../../lib/client/format';
import type { Sku, Supplier } from '../../../lib/client/types';
import { useAction } from '../../../lib/client/use-action';

const TYPE_VI: Record<string, string> = {
  FARM: 'Nhà vườn',
  COOPERATIVE: 'Hợp tác xã',
  WHOLESALER: 'Đầu mối / bán buôn',
  IMPORTER: 'Nhập khẩu',
  OTHER: 'Khác',
};

interface SupplierSku {
  sku_id: string;
  sku_code: string;
  sku_name: string;
  sku_archived: boolean;
  supplier_sku_code: string | null;
  created_at: string;
}

/** A13 — danh bạ nhà cung cấp (NC-27): SĐT / tài khoản ngân hàng hiện dạng che; xem số tài khoản cần xác thực lại. */
export default function SuppliersPage() {
  const [items, setItems] = useState<Supplier[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [q, setQ] = useState('');
  /** từ khóa ĐÃ gửi (Xem thêm dùng cái này, không dùng ô đang gõ — review react lát 7 T10) */
  const applied = useRef('');
  /** NCC đang mở giữ riêng (không suy từ danh sách — NCC ở trang 2 vẫn mở được sau khi lưu; T7) */
  const [current, setCurrent] = useState<Supplier | null>(null);
  const a = useAction();

  const load = useCallback(async (after?: string) => {
    const p = new URLSearchParams({ include_archived: 'true', limit: '100' });
    if (applied.current) p.set('q', applied.current);
    if (after) p.set('after', after);
    const r = await bff<{ items: Supplier[]; next_after: string | null }>(`/api/admin/suppliers?${p}`);
    setItems((cur) => (after ? [...cur, ...r.items] : r.items));
    setNext(r.next_after);
  }, []);
  useEffect(() => {
    void a.load(() => load());
  }, [load, a.load]);

  /** bản mới của một NCC (sau lưu / tạo) ⇒ thay trong danh sách + panel đang mở */
  const upsert = useCallback((s: Supplier) => {
    setItems((cur) => (cur.some((x) => x.id === s.id) ? cur.map((x) => (x.id === s.id ? s : x)) : [s, ...cur]));
    setCurrent(s);
  }, []);

  function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const body = readForm(new FormData(form), a.setErr, true);
    if (!body) return;
    void a.run(async () => {
      const s = await bff<Supplier>('/api/admin/suppliers', 'POST', body);
      form.reset();
      upsert(s);
      return `Đã thêm nhà cung cấp ${s.code}`;
    });
  }

  return (
    <>
      <div className="card">
        <h1>Nhà cung cấp</h1>
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
          <button type="submit">Tìm</button>
        </form>
        <div className="table-wrap mt12">
          <table>
            <thead>
              <tr>
                <th>Mã</th>
                <th>Tên</th>
                <th>Loại</th>
                <th>Liên hệ</th>
                <th>Kỳ hạn</th>
                <th>
                  <span className="sr-only">Thao tác</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className={s.archived_at ? 'archived' : undefined}>
                  <td className="mono">{s.code}</td>
                  <td>
                    {s.name}
                    {s.archived_at ? ' (đã lưu trữ)' : ''}
                  </td>
                  <td>{TYPE_VI[s.type] ?? s.type}</td>
                  <td>
                    {s.contact_name ?? ''} <span className="mono">{s.phone_masked ?? ''}</span>
                  </td>
                  <td>{s.payment_terms_days !== null ? `${s.payment_terms_days} ngày` : '—'}</td>
                  <td>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Mở ${s.code} ${s.name}`}
                      onClick={() => setCurrent(s)}
                    >
                      Mở
                    </button>
                  </td>
                </tr>
              ))}
              {!items.length && (
                <tr>
                  <td colSpan={6} className="muted">
                    Chưa có nhà cung cấp
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {next && (
          <button type="button" className="secondary" onClick={() => void a.load(() => load(next))}>
            Xem thêm
          </button>
        )}
      </div>

      {current && <SupplierPanel key={current.id} s={current} onSaved={upsert} />}

      <div className="card">
        <h2>Thêm nhà cung cấp</h2>
        <form onSubmit={create}>
          <SupplierFields />
          <button type="submit" disabled={a.busy}>
            Thêm
          </button>
        </form>
      </div>
    </>
  );
}

/** Đọc form NCC; tạo mới ⇒ gửi cả mã. Ô SĐT / tài khoản để trống khi sửa = giữ nguyên. */
function readForm(f: FormData, fail: (m: string) => void, create: boolean): Record<string, unknown> | null {
  const s = (k: string) => String(f.get(k) ?? '').trim();
  const terms = parseIntOrNull(s('payment_terms_days'));
  if (terms === undefined) {
    fail('Kỳ hạn thanh toán phải là số ngày');
    return null;
  }
  const body: Record<string, unknown> = {
    name: s('name'),
    type: s('type'),
    contact_name: s('contact_name') || null,
    bank_name: s('bank_name') || null,
    payment_terms_days: terms,
    note: s('note') || null,
  };
  if (create) body['code'] = s('code');
  if (s('phone')) body['phone'] = s('phone');
  else if (f.get('clear_phone') === 'on') body['phone'] = null;
  if (s('account_number') || s('account_holder')) {
    if (!s('account_number') || !s('account_holder')) {
      fail('Nhập đủ số tài khoản và tên chủ tài khoản');
      return null;
    }
    body['bank_account'] = { account_number: s('account_number'), account_holder: s('account_holder') };
  } else if (f.get('clear_bank') === 'on') body['bank_account'] = null;
  return body;
}

function SupplierFields({ s }: { s?: Supplier }) {
  return (
    <div className="grid">
      {!s && (
        <label>
          Mã
          <input name="code" required maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,31}" />
        </label>
      )}
      <label>
        Tên
        <input name="name" defaultValue={s?.name} required maxLength={200} />
      </label>
      <label>
        Loại
        <select name="type" defaultValue={s?.type ?? 'WHOLESALER'}>
          {Object.entries(TYPE_VI).map(([k, vi]) => (
            <option key={k} value={k}>
              {vi}
            </option>
          ))}
        </select>
      </label>
      <label>
        Người liên hệ
        <input name="contact_name" defaultValue={s?.contact_name ?? ''} maxLength={100} />
      </label>
      <label>
        Số điện thoại {s?.phone_masked ? `(hiện: ${s.phone_masked} — để trống = giữ)` : ''}
        <input name="phone" type="tel" maxLength={20} autoComplete="off" />
      </label>
      {s?.phone_masked && (
        <label className="check">
          <input type="checkbox" name="clear_phone" /> Xóa số điện thoại
        </label>
      )}
      <label>
        Ngân hàng
        <input name="bank_name" defaultValue={s?.bank_name ?? ''} maxLength={100} />
      </label>
      <label>
        Số tài khoản {s?.bank_account_masked ? `(hiện: ${s.bank_account_masked} — để trống = giữ)` : ''}
        <input name="account_number" inputMode="numeric" maxLength={24} autoComplete="off" />
      </label>
      <label>
        Chủ tài khoản
        <input name="account_holder" maxLength={100} autoComplete="off" />
      </label>
      {s?.bank_account_masked && (
        <label className="check">
          <input type="checkbox" name="clear_bank" /> Xóa tài khoản ngân hàng
        </label>
      )}
      <label>
        Kỳ hạn thanh toán (ngày)
        <input name="payment_terms_days" defaultValue={s?.payment_terms_days ?? ''} inputMode="numeric" />
      </label>
      <label>
        Ghi chú
        <input name="note" defaultValue={s?.note ?? ''} maxLength={2000} />
      </label>
    </div>
  );
}

function SupplierPanel({ s, onSaved }: { s: Supplier; onSaved: (s: Supplier) => void }) {
  /** tăng sau mỗi lần lưu ⇒ form dựng lại từ bản mới (form.reset đưa <select> về giá trị LÚC MOUNT — review react C2) */
  const [rev, setRev] = useState(0);
  const [skus, setSkus] = useState<SupplierSku[]>([]);
  const [found, setFound] = useState<Sku[]>([]);
  const [bank, setBank] = useState<{ account_number: string; account_holder: string } | null>(null);
  const a = useAction();
  const loadSkus = useCallback(async () => {
    setSkus((await bff<{ items: SupplierSku[] }>(`/api/admin/suppliers/${s.id}/skus`)).items);
  }, [s.id]);
  useEffect(() => {
    void a.load(loadSkus);
  }, [loadSkus, a.load]);

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const body = readForm(new FormData(form), a.setErr, false);
    if (!body) return;
    void a.run(async () => {
      onSaved(await bff<Supplier>(`/api/admin/suppliers/${s.id}`, 'PATCH', body));
      setBank(null);
      setRev((r) => r + 1);
      return 'Đã lưu nhà cung cấp';
    });
  }

  function reveal() {
    void a.run(async () => {
      setBank(await bff(`/api/admin/suppliers/${s.id}/bank-account/reveal`, 'POST', {}));
    });
  }

  function link(skuId: string, code: string | null) {
    void a.run(async () => {
      await bff(`/api/admin/suppliers/${s.id}/skus/${skuId}`, 'PUT', { supplier_sku_code: code });
      await loadSkus();
      return 'Đã gắn SKU';
    });
  }

  return (
    <div className="card">
      <h2>
        <span className="mono">{s.code}</span> — {s.name}
      </h2>
      <Alert text={a.err} />
      <Alert text={a.notice} kind="notice" />
      {s.bank_account_masked && (
        <div className="row mb12">
          <span>
            Tài khoản: {s.bank_name ?? ''} <span className="mono">{s.bank_account_masked}</span>
          </span>
          {bank ? (
            <span className="mono">
              {bank.account_number} · {bank.account_holder}{' '}
              <button type="button" className="secondary" onClick={() => setBank(null)}>
                Ẩn
              </button>
            </span>
          ) : (
            <button type="button" className="secondary" disabled={a.busy} onClick={reveal}>
              Xem số tài khoản
            </button>
          )}
        </div>
      )}
      <form onSubmit={save} key={rev}>
        <SupplierFields s={s} />
        <div className="row">
          <button type="submit" disabled={a.busy}>
            Lưu
          </button>
          <button
            type="button"
            className="danger"
            disabled={a.busy}
            onClick={() =>
              void a.run(async () => {
                onSaved(await bff<Supplier>(`/api/admin/suppliers/${s.id}`, 'PATCH', { archived: !s.archived_at }));
                setRev((r) => r + 1);
                return s.archived_at ? 'Đã khôi phục' : 'Đã lưu trữ';
              })
            }
          >
            {s.archived_at ? 'Khôi phục' : 'Lưu trữ'}
          </button>
        </div>
      </form>

      <h2 className="mt16">SKU nhà cung cấp này bán</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Mã bên NCC</th>
              <th>Gắn lúc</th>
              <th>
                <span className="sr-only">Thao tác</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {skus.map((k) => (
              <tr key={k.sku_id} className={k.sku_archived ? 'archived' : undefined}>
                <td>
                  <span className="mono">{k.sku_code}</span> {k.sku_name}
                </td>
                <td className="mono">{k.supplier_sku_code ?? '—'}</td>
                <td>{dt(k.created_at)}</td>
                <td>
                  <div className="row">
                    <button
                      type="button"
                      className="secondary"
                      disabled={a.busy}
                      aria-label={`Sửa mã NCC của ${k.sku_code}`}
                      onClick={() => {
                        const c = window.prompt(
                          'Mã hàng bên nhà cung cấp (để trống = không có):',
                          k.supplier_sku_code ?? '',
                        );
                        if (c !== null) link(k.sku_id, c.trim() || null);
                      }}
                    >
                      Sửa mã
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={a.busy}
                      aria-label={`Bỏ ${k.sku_code}`}
                      onClick={() =>
                        void a.run(async () => {
                          await bff(`/api/admin/suppliers/${s.id}/skus/${k.sku_id}`, 'DELETE');
                          await loadSkus();
                          return 'Đã bỏ SKU';
                        })
                      }
                    >
                      Bỏ
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!skus.length && (
              <tr>
                <td colSpan={4} className="muted">
                  Chưa gắn SKU
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <form
        className="row mt12"

        onSubmit={(e) => {
          e.preventDefault();
          const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
          if (q)
            void a.load(async () => {
              setFound((await bff<{ items: Sku[] }>(`/api/admin/skus?q=${encodeURIComponent(q)}&limit=20`)).items);
            });
        }}
      >
        <label className="grow">
          Tìm SKU để gắn
          <input name="q" maxLength={100} />
        </label>
        <button type="submit" className="secondary">
          Tìm
        </button>
      </form>
      {found
        .filter((k) => !skus.some((x) => x.sku_id === k.id))
        .map((k) => (
          <div key={k.id} className="row mt6">
            <span>
              <span className="mono">{k.sku_code}</span> {k.name}
            </span>
            <button type="button" disabled={a.busy} aria-label={`Gắn ${k.sku_code}`} onClick={() => link(k.id, null)}>
              Gắn
            </button>
          </div>
        ))}
    </div>
  );
}
