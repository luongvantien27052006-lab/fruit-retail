'use client';
import { Alert } from '../../../components/Alert';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { askReason, bff, errorText } from '../../../lib/client/api';
import { dt } from '../../../lib/client/format';

interface Device {
  id: string;
  store_id: string;
  name: string;
  platform: string;
  status: 'PENDING' | 'ACTIVE' | 'REVOKED';
  registered_at: string;
  activated_at: string | null;
  last_seen_at: string | null;
}

const STATUS_VI: Record<Device['status'], string> = {
  PENDING: 'Chờ kích hoạt',
  ACTIVE: 'Đang dùng',
  REVOKED: 'Đã thu hồi',
};

/** A11 (phần POS) — mã ghi danh, kích hoạt bằng mã ghép, thu hồi thiết bị. */
export default function DevicesPage() {
  const [items, setItems] = useState<Device[]>([]);
  const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  async function guard(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErr('');
    try {
      await fn();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const load = useCallback(async () => {
    try {
      setItems((await bff<{ items: Device[] }>('/api/admin/pos-devices')).items);
    } catch (x) {
      setErr(errorText(x));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  function newCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const store = String(new FormData(e.currentTarget).get('store_id') ?? '').trim();
    void guard(async () => {
      setCode(await bff('/api/admin/pos-devices/enrollment-codes', 'POST', { store_id: store }));
    });
  }

  function activate(id: string) {
    const pairing = window.prompt('Mã ghép hiện trên thiết bị (10 ký tự):');
    if (!pairing) return;
    const raw = window.prompt('Tên thiết bị (vd Quầy 1, tối đa 100 ký tự):');
    if (raw === null) return;
    const name = raw.trim() || undefined;
    if (name && name.length > 100) {
      window.alert('Tên thiết bị tối đa 100 ký tự.');
      return;
    }
    void guard(async () => {
      await bff(`/api/admin/pos-devices/${id}/activate`, 'POST', {
        pairing_code: pairing.trim(),
        ...(name ? { name } : {}),
      });
      await load();
    });
  }

  function revoke(id: string) {
    const reason = askReason('Lý do thu hồi (ít nhất 3 ký tự):');
    if (!reason) return;
    void guard(async () => {
      await bff(`/api/admin/pos-devices/${id}/revoke`, 'POST', { reason });
      await load();
    });
  }

  return (
    <>
      <div className="card">
        <h1>Thiết bị POS</h1>
        <Alert text={err} />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tên</th>
                <th>Trạng thái</th>
                <th>Đăng ký</th>
                <th>Lần cuối</th>
                <th>
                  <span className="sr-only">Thao tác</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id}>
                  <td>
                    {d.name} <span className="muted">({d.platform})</span>
                  </td>
                  <td>{STATUS_VI[d.status]}</td>
                  <td>{dt(d.registered_at)}</td>
                  <td>{dt(d.last_seen_at)}</td>
                  <td>
                    <div className="row">
                      {d.status === 'PENDING' && (
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`Kích hoạt ${d.name}`}
                          onClick={() => activate(d.id)}
                        >
                          Kích hoạt
                        </button>
                      )}
                      {d.status !== 'REVOKED' && (
                        <button
                          type="button"
                          className="danger"
                          disabled={busy}
                          aria-label={`Thu hồi ${d.name}`}
                          onClick={() => revoke(d.id)}
                        >
                          Thu hồi
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!items.length && (
                <tr>
                  <td colSpan={5} className="muted">
                    Chưa có thiết bị
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <form className="card" onSubmit={newCode}>
        <h2>Mã ghi danh thiết bị mới</h2>
        <label>
          Mã cửa hàng
          <input name="store_id" required pattern="[0-9a-fA-F\-]{36}" placeholder="uuid" />
        </label>
        <button type="submit" disabled={busy}>
          Tạo mã
        </button>
        {code && (
          <p className="notice">
            Nhập trên thiết bị: <strong className="mono">{code.code}</strong> — hết hạn {dt(code.expires_at)}
          </p>
        )}
      </form>
    </>
  );
}
