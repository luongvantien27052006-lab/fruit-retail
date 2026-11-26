'use client';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { bff, errorText, registerStepUp } from '../lib/client/api';

/**
 * SEC2: thao tác nhạy cảm trả 403 STEP_UP_REQUIRED ⇒ hộp nhập mã 2FA; đúng ⇒ BFF ghi access token mới (5 phút) vào cookie
 * và lib/client/api gọi lại thao tác. Hủy ⇒ thao tác báo lỗi như cũ.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const dlg = useRef<HTMLDialogElement>(null);
  // MỘT lời hỏi dùng chung: nhiều thao tác cùng cần step-up ⇒ cùng chờ một promise (không ghi đè resolver ⇒ không treo)
  const pending = useRef<{ p: Promise<boolean>; resolve: (ok: boolean) => void } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    registerStepUp(() => {
      if (pending.current) return pending.current.p;
      let resolve!: (ok: boolean) => void;
      const p = new Promise<boolean>((r) => (resolve = r));
      pending.current = { p, resolve };
      setErr('');
      dlg.current?.showModal();
      return p;
    });
    return () => {
      registerStepUp(null);
      finish(false);
    };
  }, []);

  function finish(ok: boolean) {
    const cur = pending.current;
    pending.current = null;
    if (dlg.current?.open) dlg.current.close();
    cur?.resolve(ok);
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const code = String(new FormData(form).get('code') ?? '').replace(/\s/g, '');
    setBusy(true);
    setErr('');
    try {
      await bff('/api/auth/step-up', 'POST', { code });
      form.reset();
      finish(true);
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {children}
      <dialog ref={dlg} onCancel={() => finish(false)} onClose={() => finish(false)}>
        <form onSubmit={submit}>
          <h2>Xác thực lại</h2>
          <p className="muted">Thao tác nhạy cảm — nhập mã 6 số trong Authenticator (hiệu lực 5 phút).</p>
          <label>
            Mã 6 số
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              required
              maxLength={6}
            />
          </label>
          {err && (
            <p className="error" role="alert">
              {err}
            </p>
          )}
          <div className="row">
            <button type="submit" disabled={busy}>
              Xác nhận
            </button>
            <button type="button" className="secondary" onClick={() => finish(false)}>
              Hủy
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
