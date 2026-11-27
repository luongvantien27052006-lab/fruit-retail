import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { LogoutButton } from '../../components/LogoutButton';
import { NavLink } from '../../components/NavLink';
import { StepUpProvider } from '../../components/StepUp';
import { COOKIE, decodeHint } from '../../lib/server/session';

/**
 * Khung trang quản lý. Phiên do proxy.ts bảo đảm; ở đây kiểm lại (prefetch không qua proxy) và chọn menu theo loại tài
 * khoản — CHỈ là giao diện, API vẫn kiểm quyền mỗi lần gọi.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const hint = decodeHint((await cookies()).get(COOKIE.access)?.value);
  if (!hint) redirect('/login');
  if (!hint.amr.includes('otp') && !hint.amr.includes('rcv')) redirect('/enroll');
  const master = hint.typ === 'master';
  return (
    <StepUpProvider>
      <div className="shell">
        <nav className="nav" aria-label="Điều hướng">
          <strong>Quản lý</strong>
          <span className="who">{master ? 'Master Admin' : 'Admin chỉ xem'}</span>
          <NavLink href="/">Tổng quan</NavLink>
          {master && (
            <>
              <NavLink href="/staff">Nhân viên</NavLink>
              <NavLink href="/devices">Thiết bị POS</NavLink>
              <NavLink href="/accounts">Tài khoản admin</NavLink>
              <NavLink href="/audit">Nhật ký</NavLink>
            </>
          )}
          <NavLink href="/sessions">Phiên &amp; bảo mật</NavLink>
          <span className="spacer" />
          <LogoutButton />
        </nav>
        <main className="main">{children}</main>
      </div>
    </StepUpProvider>
  );
}
