'use client';
import { useCallback, useEffect, useState } from 'react';
import { bff, errorText } from '../../../lib/client/api';
import { dt } from '../../../lib/client/format';

interface Log {
  id: string;
  at: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  actor_id: string | null;
  actor_type: string | null;
  reason: string | null;
}

/** A17 — nhật ký thao tác (Master). */
export default function AuditPage() {
  const [items, setItems] = useState<Log[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async (after: string | null, q: string) => {
    setErr('');
    const p = new URLSearchParams({ limit: '50' });
    if (after) p.set('cursor', after);
    if (q) p.set('resource_id', q);
    try {
      const r = await bff<{ items: Log[]; next_cursor: string | null }>(`/api/admin/audit-logs?${p.toString()}`);
      setItems((old) => (after ? [...old, ...r.items] : r.items));
      setCursor(r.next_cursor);
    } catch (x) {
      setErr(errorText(x));
    }
  }, []);
  useEffect(() => {
    void load(null, '');
  }, [load]);

  return (
    <div className="card">
      <h1>Nhật ký</h1>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void load(null, filter.trim());
        }}
      >
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Lọc theo mã đối tượng (uuid)" />
        <button type="submit">Lọc</button>
      </form>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Lúc</th>
            <th>Hành động</th>
            <th>Đối tượng</th>
            <th>Người làm</th>
            <th>Lý do</th>
          </tr>
        </thead>
        <tbody>
          {items.map((l) => (
            <tr key={l.id}>
              <td>{dt(l.at)}</td>
              <td className="mono">{l.action}</td>
              <td>
                {l.resource_type} <span className="muted mono">{l.resource_id ?? ''}</span>
              </td>
              <td className="muted mono">
                {l.actor_type ?? ''} {l.actor_id ?? ''}
              </td>
              <td>{l.reason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cursor && (
        <p>
          <button type="button" className="secondary" onClick={() => void load(cursor, filter.trim())}>
            Xem thêm
          </button>
        </p>
      )}
    </div>
  );
}
