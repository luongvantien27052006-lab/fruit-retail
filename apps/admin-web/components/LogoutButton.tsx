'use client';
import { bff } from '../lib/client/api';

export function LogoutButton() {
  return (
    <button
      type="button"
      className="secondary"
      onClick={async () => {
        try {
          await bff('/auth/logout', 'POST', {});
          window.location.assign('/login');
        } catch {
          window.alert('Đăng xuất chưa thành công — kiểm tra kết nối rồi thử lại.');
        }
      }}
    >
      Đăng xuất
    </button>
  );
}
