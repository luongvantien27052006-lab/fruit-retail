'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert } from '../../../components/Alert';
import { bff, downloadBlob, saveUrl, uploadFile } from '../../../lib/client/api';
import { dt } from '../../../lib/client/format';
import type { ImportJob } from '../../../lib/client/types';
import { useAction } from '../../../lib/client/use-action';

const TYPE_VI = { CATALOG: 'Danh mục (SKU + giá)', SUPPLIER: 'Nhà cung cấp' } as const;
const MODE_VI = {
  SKIP: 'Bỏ qua dòng trùng',
  UPDATE: 'Cập nhật dòng trùng',
  STOP: 'Dừng ở dòng trùng đầu tiên',
} as const;
const STATUS_VI: Record<ImportJob['status'], string> = {
  PENDING: 'Chờ chạy',
  RUNNING: 'Đang chạy',
  COMPLETED: 'Xong',
  FAILED: 'Lỗi',
};
const ROW_VI = { CREATED: 'Tạo mới', UPDATED: 'Cập nhật', SKIPPED: 'Bỏ qua', ERROR: 'Lỗi' } as const;
const LISTS = [
  ['skus', 'SKU + giá'],
  ['categories', 'Danh mục'],
  ['suppliers', 'Nhà cung cấp'],
  ['stores', 'Cửa hàng'],
  ['locations', 'Vị trí kho'],
] as const;

type Mode = keyof typeof MODE_VI;
type Kind = keyof typeof TYPE_VI;

/**
 * A10 — nhập Excel (§21.3.17, ADR-031): tải file mẫu → chọn file → CHẠY THỬ (dry-run, báo lỗi từng dòng, không ghi) →
 * chọn cách xử lý dòng trùng → chạy thật cùng file. Xuất mọi danh sách ra Excel.
 */
export default function ImportsPage() {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [type, setType] = useState<Kind>('CATALOG');
  const [mode, setMode] = useState<Mode>('SKIP');
  const [fileId, setFileId] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const a = useAction();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** lượt đang theo dõi; phản hồi của lượt khác / sau khi rời trang bị bỏ (review react lát 7 TB4) */
  const active = useRef<string | null>(null);

  const loadJobs = useCallback(async () => {
    setJobs((await bff<{ items: ImportJob[] }>('/api/admin/imports?limit=20')).items);
  }, []);
  useEffect(() => {
    void a.load(loadJobs);
    return () => {
      active.current = null;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [loadJobs, a.load]);

  /** hỏi lại trạng thái tới khi xong (lượt nhập chạy nền ở worker) */
  const poll = useCallback(
    (id: string, n = 0) => {
      if (timer.current) clearTimeout(timer.current);
      active.current = id;
      timer.current = setTimeout(
        () => {
          void a.load(async () => {
            const j = await bff<ImportJob>(`/api/admin/imports/${id}`);
            if (active.current !== id) return;
            setJob(j);
            if (j.status === 'PENDING' || j.status === 'RUNNING') {
              if (n < 300) poll(id, n + 1);
              else {
                active.current = null;
                a.setErr('Lượt nhập chạy lâu bất thường — xem lại ở "Lượt nhập gần đây" sau ít phút');
              }
            } else {
              active.current = null;
              await loadJobs();
            }
          });
        },
        n < 10 ? 1000 : 3000,
      );
    },
    [a.load, loadJobs],
  );

  function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem('file') as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) return a.setErr('Chọn file .xlsx');
    if (file.size > 5 * 1024 * 1024) return a.setErr('File tối đa 5 MB');
    void a.run(async () => {
      const f = await uploadFile(
        'IMPORT_XLSX',
        file.type
          ? file
          : new File([file], file.name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      );
      // ngừng theo dõi lượt của file cũ (kết quả cũ không hiện dưới file mới)
      active.current = null;
      if (timer.current) clearTimeout(timer.current);
      setFileId(f.id);
      setFileName(file.name);
      setJob(null);
      return `Đã tải lên "${file.name}" — bấm Chạy thử để kiểm từng dòng`;
    });
  }

  function start(dry: boolean) {
    if (!fileId) return;
    if (!dry && !window.confirm(`Nhập THẬT "${fileName}" (${TYPE_VI[type]}, ${MODE_VI[mode].toLowerCase()})?`)) return;
    void a.run(async () => {
      const j = await bff<ImportJob>('/api/admin/imports', 'POST', {
        type,
        file_id: fileId,
        mode_on_duplicate: mode,
        dry_run: dry,
      });
      setJob(j);
      poll(j.id);
      await loadJobs();
      return dry ? 'Đang chạy thử…' : 'Đang nhập…';
    });
  }

  function exportList(list: string) {
    void a.run(async () => {
      const r = await bff<{ url: string; rows: number }>('/api/admin/catalog-exports', 'POST', { list });
      saveUrl(r.url);
      return `Đã xuất ${r.rows} dòng (link tải hiệu lực 60 giây)`;
    });
  }

  const rep = job?.report;
  const done = job && (job.status === 'COMPLETED' || job.status === 'FAILED');
  const problemRows = rep?.rows?.filter((r) => r.status === 'ERROR' || r.status === 'SKIPPED') ?? [];

  return (
    <>
      <div className="card">
        <h1>Nhập từ Excel</h1>
        <Alert text={a.err} />
        <Alert text={a.notice} kind="notice" />
        <div className="row mb12">
          {(Object.keys(TYPE_VI) as Kind[]).map((k) => (
            <button
              key={k}
              type="button"
              className="secondary"
              disabled={a.busy}
              onClick={() =>
                void a.run(async () => {
                  await downloadBlob(`/template/${k}`, `mau-nhap-${k.toLowerCase()}.xlsx`);
                })
              }
            >
              Tải file mẫu: {TYPE_VI[k]}
            </button>
          ))}
        </div>
        <form onSubmit={upload} className="grid">
          <label>
            Loại dữ liệu
            <select value={type} onChange={(e) => setType(e.target.value as Kind)}>
              {(Object.keys(TYPE_VI) as Kind[]).map((k) => (
                <option key={k} value={k}>
                  {TYPE_VI[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            File .xlsx (≤ 5 MB)
            <input
              name="file"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              required
              onChange={() => setFileId(null)}
            />
          </label>
          <div>
            <button type="submit" disabled={a.busy}>
              Tải file lên
            </button>
          </div>
        </form>
        {fileId && (
          <>
            <fieldset className="plain-fieldset">
              <legend className="muted">Dòng trùng (mã / mã vạch đã có)</legend>
              {(Object.keys(MODE_VI) as Mode[]).map((m) => (
                <label key={m} className="check">
                  <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} /> {MODE_VI[m]}
                </label>
              ))}
            </fieldset>
            <div className="row">
              <button type="button" disabled={a.busy} onClick={() => start(true)}>
                Chạy thử (không ghi)
              </button>
              <button
                type="button"
                className="secondary"
                disabled={
                  a.busy ||
                  // chỉ khi ĐÚNG file + loại + cách xử lý trùng vừa chạy thử xong (review react TB3)
                  !(
                    job?.dry_run &&
                    job.status === 'COMPLETED' &&
                    job.file_id === fileId &&
                    job.type === type &&
                    job.mode_on_duplicate === mode
                  )
                }
                onClick={() => start(false)}
              >
                Nhập thật
              </button>
            </div>
            <p className="muted">Chạy thử trước để thấy lỗi từng dòng; nút Nhập thật mở sau khi chạy thử xong.</p>
          </>
        )}
      </div>

      {job && (
        <div className="card" aria-live="polite">
          <h2>
            {job.dry_run ? 'Kết quả chạy thử' : 'Kết quả nhập'} — {STATUS_VI[job.status]}
          </h2>
          {!done && <p className="muted">Đang xử lý ở máy chủ…</p>}
          {job.error && <p className="error">{job.error}</p>}
          {rep && (
            <p>
              Tạo mới <strong>{rep.created ?? 0}</strong> · Cập nhật <strong>{rep.updated ?? 0}</strong> · Bỏ qua{' '}
              <strong>{rep.skipped ?? 0}</strong> · Lỗi <strong>{rep.errors ?? 0}</strong>
              {rep.stopped_at_row ? ` · Dừng ở dòng ${rep.stopped_at_row}` : ''}
              {job.dry_run ? ' (chưa ghi gì)' : ''}
            </p>
          )}
          {problemRows.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Dòng</th>
                    <th>Kết quả</th>
                    <th>Mã</th>
                    <th>Cột</th>
                    <th>Chi tiết</th>
                  </tr>
                </thead>
                <tbody>
                  {problemRows.slice(0, 500).map((r) => (
                    <tr key={`${r.row}-${r.status}-${r.field ?? ''}`}>
                      <td>{r.row}</td>
                      <td>{ROW_VI[r.status]}</td>
                      <td className="mono">{r.key ?? '—'}</td>
                      <td>{r.field ?? '—'}</td>
                      <td className="wrap">
                        {r.message ?? ''}
                        {r.duplicate_of ? ` (trùng ${r.duplicate_of})` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>Lượt nhập gần đây</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Lúc</th>
                <th>Loại</th>
                <th>Kiểu</th>
                <th>Trạng thái</th>
                <th>Đúng / bỏ qua / lỗi</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>{dt(j.created_at)}</td>
                  <td>{TYPE_VI[j.type]}</td>
                  <td>
                    {j.dry_run ? 'Chạy thử' : 'Nhập thật'} · {MODE_VI[j.mode_on_duplicate]}
                  </td>
                  <td>{STATUS_VI[j.status]}</td>
                  <td>
                    {j.ok_rows ?? '—'} / {j.skipped_rows ?? '—'} / {j.error_rows ?? '—'}
                  </td>
                </tr>
              ))}
              {!jobs.length && (
                <tr>
                  <td colSpan={5} className="muted">
                    Chưa có lượt nhập
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Xuất ra Excel</h2>
        <div className="row">
          {LISTS.map(([k, vi]) => (
            <button key={k} type="button" className="secondary" disabled={a.busy} onClick={() => exportList(k)}>
              {vi}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
