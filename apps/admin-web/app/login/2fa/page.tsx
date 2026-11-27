'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ApiFailure, bff, errorText } from '../../../lib/client/api';

/** A01 — bước 2: mã 6 số từ Authenticator, hoặc mã khôi phục. */
export default function MfaPage() {
  const router = useRouter();
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ended, setEnded] = useState(false); // challenge hết / tài khoản khóa: báo lý do rồi mới quay lại đăng nhập

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = String(new FormData(e.currentTarget).get('code') ?? '').trim();
    setBusy(true);
    setErr('');
    try {
      const r = await bff<{ recovery_codes_remaining?: number }>(
        '/auth/mfa',
        'POST',
        recovery ? { recovery_code: v } : { code: v.replace(/\s/g, '') },
      );
      if (typeof r.recovery_codes_remaining === 'number' && r.recovery_codes_remaining <= 3)
        window.alert(`Chỉ còn ${r.recovery_codes_remaining} mã khôi phục — hãy tạo bộ mã mới ở mục Phiên & bảo mật.`);
      router.replace('/');
    } catch (x) {
      if (x instanceof ApiFailure && (x.error.code === 'MFA_CHALLENGE_INVALID' || x.error.code === 'ACCOUNT_LOCKED')) {
        setErr(errorText(x));
        setEnded(true);
        return;
      }
      setErr(errorText(x));
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="card narrow" onSubmit={submit}>
        <h1>Xác minh hai bước</h1>
        {recovery ? (
          <label>
            Mã khôi phục
            <input name="code" autoComplete="off" required minLength={16} maxLength={40} autoFocus />
          </label>
        ) : (
          <label>
            Mã 6 số trong ứng dụng Authenticator
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              required
              maxLength={6}
              autoFocus
            />
          </label>
        )}
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
        <div className="row">
          {ended ? (
            <button type="button" onClick={() => router.replace('/login')}>
              Đăng nhập lại
            </button>
          ) : (
            <button type="submit" disabled={busy}>
              Xác minh
            </button>
          )}
          <button type="button" className="secondary" onClick={() => setRecovery(!recovery)}>
            {recovery ? 'Dùng mã Authenticator' : 'Dùng mã khôi phục'}
          </button>
        </div>
      </form>
    </main>
  );
}
