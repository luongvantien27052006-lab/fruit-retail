'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { bff, errorText } from '../../lib/client/api';

interface LoginOut {
  status: 'MFA_REQUIRED' | 'ENROLLMENT_REQUIRED';
  password_change_required?: boolean;
}

/** A01 — bước 1: email + mật khẩu. */
export default function LoginPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setErr('');
    try {
      const r = await bff<LoginOut>('/auth/login', 'POST', {
        email: String(f.get('email') ?? ''),
        password: String(f.get('password') ?? ''),
      });
      router.replace(r.status === 'MFA_REQUIRED' ? '/login/2fa' : '/enroll');
    } catch (x) {
      setErr(errorText(x));
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="card narrow" onSubmit={submit}>
        <h1>Đăng nhập quản lý</h1>
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required maxLength={254} autoFocus />
        </label>
        <label>
          Mật khẩu
          <input name="password" type="password" autoComplete="current-password" required maxLength={256} />
        </label>
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? 'Đang kiểm tra…' : 'Tiếp tục'}
        </button>
      </form>
    </main>
  );
}
