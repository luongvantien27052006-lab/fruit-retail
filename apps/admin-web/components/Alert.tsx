'use client';
import { useEffect, useRef } from 'react';

/**
 * Thông báo lỗi / thành công có cuộn tới (review cổng CP03: ở màn hẹp, thông báo nằm ngoài vùng đang nhìn khi form ở dưới
 * trang). role=alert ⇒ trình đọc màn hình đọc ngay.
 */
export function Alert({ text, kind = 'error' }: { text: string; kind?: 'error' | 'notice' }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (text) ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [text]);
  if (!text) return null;
  return (
    <p ref={ref} className={kind} role={kind === 'error' ? 'alert' : 'status'}>
      {text}
    </p>
  );
}
