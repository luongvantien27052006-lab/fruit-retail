import type { ReactNode } from 'react';
import { connection } from 'next/server';
import './globals.css';

export const metadata = { title: 'Trang quản lý', robots: { index: false, follow: false } };

/** Mọi trang render động: CSP nonce mới mỗi request (proxy.ts) — trang tĩnh không mang được nonce. */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
