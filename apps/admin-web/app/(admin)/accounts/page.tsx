'use client';
import { useRef, useState, type FormEvent } from 'react';
import { askReason, bff, errorText } from '../../../lib/client/api';
import { dt, UUID_RE } from '../../../lib/client/format';

interface Created {
  user_id: string;
  email: string;
  role: string;
  temporary_password: string;
}
interface AdminSession {
  id: string;
  user_type: string;
  amr: string[];
  created_at: string;
  last_used_at: string;
  user_agent: string | null;
  active: boolean;
}

/** A15+ — tạo Master/Viewer, khóa/mở, reset 2FA, xem/thu hồi phiên. Mọi thao tác đều step-up. */
export default function AccountsPage() {
  const [created, setCreated] = useState<Created | null>(null);
  const [target, setTarget] = useState('');
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [role, setRole] = useState('VIEW_ONLY_ADMIN');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false); // chặn bấm đúp trong cùng nhịp (state chưa kịp render)

  async function run(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await fn();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    void run(async () => {
      setCreated(
        await bff<Created>('/api/admin/admin-accounts', 'POST', {
          email: String(f.get('email') ?? '').trim(),
          role,
          ...(role === 'VIEW_ONLY_ADMIN' ? { viewer_profile_id: String(f.get('viewer_profile_id') ?? '').trim() } : {}),
        }),
      );
      form.reset();
      setRole('VIEW_ONLY_ADMIN');
    });
  }

  const id = target.trim();
  const valid = UUID_RE.test(id);
  const reason = () => askReason();

  return (
    <>
      <form className="card" onSubmit={create}>
        <h1>Tài khoản admin</h1>
        <label>
          Email
          <input name="email" type="email" required maxLength={254} autoComplete="off" />
        </label>
        <label>
          Vai trò
          <select name="role" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="VIEW_ONLY_ADMIN">Admin chỉ xem</option>
            <option value="MASTER_ADMIN">Master Admin</option>
          </select>
        </label>
        <label>
          Hồ sơ xem (bắt buộc với Admin chỉ xem — mã hồ sơ)
          <input
            name="viewer_profile_id"
            pattern="[0-9a-fA-F-]{36}"
            placeholder="uuid"
            required={role === 'VIEW_ONLY_ADMIN'}
            disabled={role !== 'VIEW_ONLY_ADMIN'}
          />
        </label>
        <button type="submit" disabled={busy}>
          Tạo tài khoản
        </button>
        {created && (
          <div className="notice">
            <p>
              Đã tạo <strong>{created.email}</strong> (
              {created.role === 'MASTER_ADMIN' ? 'Master Admin' : 'Admin chỉ xem'}). Mật khẩu tạm — chỉ hiện MỘT lần,
              gửi qua kênh an toàn; hết hạn sau 72 giờ nếu chưa kích hoạt:
            </p>
            <p className="mono">{created.temporary_password}</p>
            <button type="button" className="secondary" onClick={() => setCreated(null)}>
              Đã ghi lại — ẩn
            </button>
          </div>
        )}
      </form>

      <div className="card">
        <h2>Thao tác trên tài khoản</h2>
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
        {msg && <p className="notice">{msg}</p>}
        <label>
          Mã tài khoản (user id — xem ở Nhật ký)
          <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="uuid" />
        </label>
        <div className="row">
          <button
            type="button"
            disabled={!valid || busy}
            onClick={() =>
              void run(async () => {
                const r = reason();
                if (!r) return;
                await bff(`/api/admin/users/${id}/lock`, 'POST', { reason: r });
                setMsg('Đã khóa tài khoản và thu hồi phiên');
              })
            }
            className="danger"
          >
            Khóa
          </button>
          <button
            type="button"
            disabled={!valid || busy}
            className="secondary"
            onClick={() =>
              void run(async () => {
                const r = reason();
                if (!r) return;
                await bff(`/api/admin/users/${id}/unlock`, 'POST', { reason: r });
                setMsg('Đã mở khóa');
              })
            }
          >
            Mở khóa
          </button>
          <button
            type="button"
            disabled={!valid || busy}
            className="danger"
            onClick={() =>
              void run(async () => {
                const r = reason();
                if (!r) return;
                await bff(`/api/admin/users/${id}/2fa/reset`, 'POST', { reason: r });
                setMsg('Đã reset 2FA — người dùng phải đăng ký lại ở lần đăng nhập tới');
              })
            }
          >
            Reset 2FA
          </button>
          <button
            type="button"
            disabled={!valid || busy}
            className="secondary"
            onClick={() =>
              void run(async () => {
                setSessions((await bff<{ items: AdminSession[] }>(`/api/admin/users/${id}/sessions`)).items);
              })
            }
          >
            Xem phiên
          </button>
        </div>
        {sessions && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tạo</th>
                  <th>Dùng gần nhất</th>
                  <th>Trình duyệt / thiết bị</th>
                  <th>
                    <span className="sr-only">Thao tác</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{dt(s.created_at)}</td>
                    <td>{dt(s.last_used_at)}</td>
                    <td className="muted">{s.user_agent ?? '—'}</td>
                    <td>
                      {s.active && (
                        <button
                          type="button"
                          className="danger"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              const r = reason();
                              if (!r) return;
                              await bff(`/api/admin/sessions/${s.id}/revoke`, 'POST', { reason: r });
                              setSessions(
                                (await bff<{ items: AdminSession[] }>(`/api/admin/users/${id}/sessions`)).items,
                              );
                            })
                          }
                        >
                          Thu hồi
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
