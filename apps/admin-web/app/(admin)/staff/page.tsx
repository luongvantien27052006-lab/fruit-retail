'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { bff, errorText } from '../../../lib/client/api';

interface Role {
  id: string;
  role: string;
  scope_type: string;
  store_id: string | null;
  warehouse_id: string | null;
}
interface Staff {
  user_id: string;
  staff_code: string;
  full_name: string;
  hired_at: string | null;
  left_at: string | null;
  status: string;
  roles: Role[];
}

const STATUS_VI: Record<string, string> = { ACTIVE: 'Đang làm', LOCKED: 'Bị khóa', DISABLED: 'Vô hiệu' };
const ROLES = ['STORE_MANAGER', 'CASHIER', 'PICKER', 'SHIPPER', 'WAREHOUSE_STAFF'] as const;
const ROLE_VI: Record<string, string> = {
  STORE_MANAGER: 'Cửa hàng trưởng',
  CASHIER: 'Thu ngân',
  PICKER: 'Soạn hàng',
  SHIPPER: 'Giao hàng',
  WAREHOUSE_STAFF: 'Thủ kho',
};

/** A15 — nhân viên & phân quyền. Tạo nhân viên kèm vai trò ⇒ step-up (Master). */
export default function StaffPage() {
  const [items, setItems] = useState<Staff[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await bff<{ items: Staff[] }>('/api/admin/staff')).items);
    } catch (x) {
      setErr(errorText(x));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const role = String(f.get('role'));
    const scope = String(f.get('scope_id') ?? '').trim();
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await bff('/api/admin/staff', 'POST', {
        staff_code: String(f.get('staff_code') ?? '').trim(),
        full_name: String(f.get('full_name') ?? '').trim(),
        pin: String(f.get('pin') ?? ''),
        role: role === 'WAREHOUSE_STAFF' ? { role, warehouse_id: scope } : { role, store_id: scope },
      });
      form.reset();
      setMsg('Đã tạo nhân viên');
      await load();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }

  async function removeRole(id: string) {
    if (!window.confirm('Gỡ vai trò này?')) return;
    setErr('');
    try {
      await bff(`/api/admin/role-assignments/${id}`, 'DELETE');
      await load();
    } catch (x) {
      setErr(errorText(x));
    }
  }

  return (
    <>
      <div className="card">
        <h1>Nhân viên</h1>
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
        {msg && <p className="notice">{msg}</p>}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Mã</th>
                <th>Họ tên</th>
                <th>Trạng thái</th>
                <th>Vai trò</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.user_id}>
                  <td className="mono">{s.staff_code}</td>
                  <td>{s.full_name}</td>
                  <td>
                    {s.left_at
                      ? `Nghỉ từ ${s.left_at.split('-').reverse().join('/')}`
                      : (STATUS_VI[s.status] ?? s.status)}
                  </td>
                  <td>
                    {s.roles.map((r) => (
                      <div key={r.id} className="row">
                        <span>
                          {ROLE_VI[r.role] ?? r.role}{' '}
                          <span className="muted mono">{(r.store_id ?? r.warehouse_id ?? '').slice(0, 8)}</span>
                        </span>
                        <button type="button" className="danger" onClick={() => void removeRole(r.id)}>
                          Gỡ
                        </button>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
              {!items.length && (
                <tr>
                  <td colSpan={4} className="muted">
                    Chưa có nhân viên
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <form className="card" onSubmit={create}>
        <h2>Thêm nhân viên</h2>
        <label>
          Mã nhân viên
          <input name="staff_code" required pattern="[A-Za-z0-9_\-]{1,32}" maxLength={32} />
        </label>
        <label>
          Họ tên
          <input name="full_name" required maxLength={100} />
        </label>
        <label>
          PIN 6 số (nhân viên đổi sau)
          <input
            name="pin"
            type="password"
            inputMode="numeric"
            pattern="\d{6}"
            required
            maxLength={6}
            autoComplete="off"
          />
        </label>
        <label>
          Vai trò
          <select name="role" defaultValue="CASHIER">
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_VI[r]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Mã cửa hàng (thủ kho: mã kho)
          <input name="scope_id" required pattern="[0-9a-fA-F\-]{36}" placeholder="uuid" />
        </label>
        <button type="submit" disabled={busy}>
          Tạo nhân viên
        </button>
      </form>
    </>
  );
}
