'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert } from '../../../components/Alert';
import { bff, uploadFile } from '../../../lib/client/api';
import { dt } from '../../../lib/client/format';
import type { Brand } from '../../../lib/client/types';
import { useAction } from '../../../lib/client/use-action';

const LOGOS = [
  ['logo_mono_file_id', 'Logo đen trắng (in phiếu)'],
  ['logo_color_file_id', 'Logo màu (app, tem)'],
] as const;

/** §18.5 — thương hiệu: tên, hotline, địa chỉ hiển thị, chân phiếu, màu, chính sách riêng tư, logo (PNG / JPEG ≤ 1 MB). */
export default function BrandPage() {
  const [b, setB] = useState<Brand | null>(null);
  const a = useAction();
  const load = useCallback(async () => {
    setB(await bff<Brand>('/api/admin/brand'));
  }, []);
  useEffect(() => {
    void a.load(load);
  }, [load, a.load]);

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? '').trim();
    const color = s('primary_color');
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) return a.setErr('Màu chính dạng #RRGGBB');
    const url = s('privacy_url');
    if (url && !url.startsWith('https://')) return a.setErr('Đường dẫn chính sách phải bắt đầu bằng https://');
    void a.run(async () => {
      setB(
        await bff<Brand>('/api/admin/brand', 'PUT', {
          brand_name: s('brand_name'),
          hotline: s('hotline') || null,
          display_address: s('display_address') || null,
          receipt_footer: s('receipt_footer') || null,
          primary_color: color || null,
          privacy_url: url || null,
        }),
      );
      return 'Đã lưu thương hiệu';
    });
  }

  function setLogo(field: (typeof LOGOS)[number][0], file: File | undefined) {
    if (!file) return;
    if (file.size > 1024 * 1024) return a.setErr('Logo tối đa 1 MB');
    if (!['image/png', 'image/jpeg'].includes(file.type)) return a.setErr('Logo chỉ nhận PNG hoặc JPEG');
    void a.run(async () => {
      const up = await uploadFile('BRAND_LOGO', file);
      setB(await bff<Brand>('/api/admin/brand', 'PUT', { [field]: up.id }));
      return 'Đã cập nhật logo';
    });
  }

  if (!b)
    return (
      <div className="card">
        <Alert text={a.err} />
        <p className="muted">Đang tải…</p>
      </div>
    );

  return (
    <div className="card">
      <h1>Thương hiệu</h1>
      <p className="muted">Cập nhật {dt(b.updated_at)}</p>
      <Alert text={a.err} />
      <Alert text={a.notice} kind="notice" />
      <form onSubmit={save} key={b.updated_at}>
        <div className="grid">
          <label>
            Tên thương hiệu
            <input name="brand_name" defaultValue={b.brand_name} required maxLength={100} />
          </label>
          <label>
            Hotline
            <input name="hotline" defaultValue={b.hotline ?? ''} maxLength={30} />
          </label>
          <label>
            Địa chỉ hiển thị
            <input name="display_address" defaultValue={b.display_address ?? ''} maxLength={300} />
          </label>
          <label>
            Câu chân phiếu
            <input name="receipt_footer" defaultValue={b.receipt_footer ?? ''} maxLength={300} />
          </label>
          <label>
            Màu chính (#RRGGBB)
            <input name="primary_color" defaultValue={b.primary_color ?? ''} maxLength={7} />
          </label>
          <label>
            Chính sách riêng tư (https://…)
            <input name="privacy_url" type="url" defaultValue={b.privacy_url ?? ''} maxLength={500} />
          </label>
        </div>
        <button type="submit" disabled={a.busy}>
          Lưu
        </button>
      </form>
      <h2 className="mt16">Logo</h2>
      <div className="grid">
        {LOGOS.map(([k, vi]) => (
          <label key={k}>
            {vi} — {b[k] ? 'đã có' : 'chưa có'}
            <input
              type="file"
              accept="image/png,image/jpeg"
              disabled={a.busy}
              onChange={(e) => {
                setLogo(k, e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
