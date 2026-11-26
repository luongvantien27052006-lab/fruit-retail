'use client';
import { bff } from '../lib/client/api';

export function LogoutButton() {
  return (
    <button
      type="button"
      className="secondary"
      onClick={async () => {
        await bff('/auth/logout', 'POST', {}).catch(() => undefined);
        window.location.assign('/login');
      }}
    >
      Đăng xuất
    </button>
  );
}
