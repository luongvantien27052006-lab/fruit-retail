'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { bff, errorText } from '../../../lib/client/api';
import { dt } from '../../../lib/client/format';

interface Session {
  id: string;
  created_at: string;
  last_used_at: string;
  user_agent: string | null;
  client_device: string | null;
  current: boolean;
}

/** Phiên của chính mình (SEC4) + sinh lại mã khôi phục (step-up). */
export default function SessionsPage() {
  const [items, setItems] = useState<Session[]>([]);
  const [codes, setCodes] = useState<string[] | null>(null);
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
      setItems((await bff<{ items: Session[] }>('/api/auth/sessions')).items);
    } catch (x) {
      setErr(errorText(x));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  function revoke(id: string) {
    void guard(async () => {
      await bff(`/api/auth/sessions/${id}`, 'DELETE');
      await load();
    });
  }

  function regenerate() {
    if (!window.confirm('Tạo bộ mã khôi phục mới? Bộ mã cũ sẽ hết hiệu lực.')) return;
    void guard(async () => {
      setCodes((await bff<{ recovery_codes: string[] }>('/api/auth/2fa/recovery-codes', 'POST', {})).recovery_codes);
    });
  }

  return (
    <>
      <div className="card">
        <h1>Phiên đăng nhập</h1>
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Thiết bị</th>
                <th>Tạo</th>
                <th>Dùng gần nhất</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td className="muted wrap">{s.client_device ?? s.user_agent ?? '—'}</td>
                  <td>{dt(s.created_at)}</td>
                  <td>{dt(s.last_used_at)}</td>
                  <td>
                    {s.current ? (
                      <span className="muted">Phiên này</span>
                    ) : (
                      <button type="button" className="danger" disabled={busy} onClick={() => revoke(s.id)}>
                        Thu hồi
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <h2>Mã khôi phục</h2>
        <button type="button" disabled={busy} onClick={() => regenerate()}>
          Tạo bộ mã mới
        </button>
        {codes && (
          <>
            <p className="notice">Cất ngay — chỉ hiện MỘT lần.</p>
            <div className="codes mono">
              {codes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
