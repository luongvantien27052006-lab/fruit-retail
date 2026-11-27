'use client';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiFailure, bff, errorText } from '../../lib/client/api';

type Step = 'loading' | 'password' | 'scan' | 'codes';
interface Setup {
  secret: string;
  otpauth_uri: string;
  issuer: string;
}

/**
 * A01 lần đầu (NC-22): đổi mật khẩu tạm ⇒ quét QR Authenticator ⇒ nhập mã xác nhận ⇒ cất 10 mã khôi phục.
 * Phiên ở bước này chưa có 2FA: API chỉ mở setup/confirm/password/logout.
 */
export default function EnrollPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('loading');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [qr, setQr] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function startSetup() {
    setErr('');
    try {
      const s = await bff<Setup>('/api/auth/2fa/setup', 'POST', {});
      setSetup(s);
      setQr(await QRCode.toDataURL(s.otpauth_uri, { margin: 1, width: 184 }));
      setStep('scan');
    } catch (x) {
      if (x instanceof ApiFailure && x.error.code === 'PASSWORD_CHANGE_REQUIRED') setStep('password');
      else {
        setErr(errorText(x));
        setStep('scan');
      }
    }
  }

  const started = useRef(false);
  useEffect(() => {
    // StrictMode chạy effect hai lần ở dev — mỗi lần setup sinh secret mới, chỉ gọi một lần
    if (started.current) return;
    started.current = true;
    void startSetup();
  }, []);

  async function changePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const next = String(f.get('new_password') ?? '');
    if (next !== String(f.get('confirm') ?? '')) {
      setErr('Hai lần nhập mật khẩu mới không khớp');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await bff('/api/auth/password', 'POST', { current_password: String(f.get('current') ?? ''), new_password: next });
      await startSetup();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '').replace(/\s/g, '');
    setBusy(true);
    setErr('');
    try {
      const r = await bff<{ recovery_codes: string[] }>('/api/auth/2fa/confirm', 'POST', { code });
      setCodes(r.recovery_codes);
      setSetup(null);
      setQr('');
      setStep('codes');
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try {
      await bff('/auth/logout', 'POST', {});
      router.replace('/login');
    } catch {
      setErr('Đăng xuất chưa thành công — kiểm tra kết nối rồi thử lại.');
    }
  }

  return (
    <main className="center">
      <div className="card narrow">
        <h1>Kích hoạt tài khoản</h1>
        {step === 'loading' && <p className="muted">Đang tải…</p>}

        {step === 'password' && (
          <form onSubmit={changePassword}>
            <p className="notice">
              Bạn đang dùng mật khẩu tạm. Hãy đặt mật khẩu mới (12 ký tự trở lên, không chứa tên email).
            </p>
            <label>
              Mật khẩu hiện tại (mật khẩu tạm)
              <input name="current" type="password" autoComplete="current-password" required maxLength={256} />
            </label>
            <label>
              Mật khẩu mới
              <input
                name="new_password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={256}
              />
            </label>
            <label>
              Nhập lại mật khẩu mới
              <input
                name="confirm"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={256}
              />
            </label>
            {err && (
              <p className="error" role="alert">
                {err}
              </p>
            )}
            <button type="submit" disabled={busy}>
              Đổi mật khẩu
            </button>
          </form>
        )}

        {step === 'scan' && (
          <form onSubmit={confirm}>
            <p>Bắt buộc bật xác minh hai bước. Quét mã bằng ứng dụng Authenticator rồi nhập mã 6 số.</p>
            <p className="muted">
              Mỗi lần mở lại trang này sẽ có mã QR MỚI — nếu đã quét mã cũ, xóa mục đó trong Authenticator rồi quét lại.
            </p>
            {qr && <img className="qr" src={qr} alt="Mã QR đăng ký Authenticator" />}
            {setup && (
              <p className="muted">
                Không quét được? Nhập khóa: <span className="mono">{setup.secret}</span>
              </p>
            )}
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
              <button type="submit" disabled={busy || !setup}>
                Xác nhận
              </button>
              {(!setup || err) && (
                <button type="button" className="secondary" onClick={() => void startSetup()}>
                  Thử lại
                </button>
              )}
            </div>
          </form>
        )}

        {step === 'codes' && (
          <div>
            <p className="notice">
              Cất 10 mã khôi phục này ở nơi an toàn (trình quản lý mật khẩu / giấy cất két). Mỗi mã dùng một lần khi mất
              điện thoại. Mã chỉ hiện MỘT lần.
            </p>
            <div className="codes mono">
              {codes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            <p />
            <button type="button" onClick={() => router.replace('/')}>
              Tôi đã cất mã — vào trang quản lý
            </button>
          </div>
        )}

        <p />
        <button type="button" className="secondary" onClick={() => void logout()}>
          Đăng xuất
        </button>
      </div>
    </main>
  );
}
