'use client';
import { useCallback, useRef, useState } from 'react';
import { errorText } from './api';

/**
 * Chạy một thao tác gọi API: chặn bấm đúp (ref đồng bộ, không chờ re-render), gom lỗi / thông báo cho <Alert>.
 * Trả true nếu xong không lỗi.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const ref = useRef(false);
  const run = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    if (ref.current) return false;
    ref.current = true;
    setBusy(true);
    setErr('');
    setNotice('');
    try {
      const msg = await fn();
      if (typeof msg === 'string') setNotice(msg);
      return true;
    } catch (x) {
      setErr(errorText(x));
      return false;
    } finally {
      ref.current = false;
      setBusy(false);
    }
  }, []);
  /** tải dữ liệu (KHÔNG khóa bấm đúp — nhiều lượt tải song song được); lỗi ⇒ hiện ở Alert */
  const load = useCallback(async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (x) {
      setErr(errorText(x));
    }
  }, []);
  return { busy, err, notice, run, load, setErr, setNotice };
}
