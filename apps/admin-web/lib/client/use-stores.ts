'use client';
import { useEffect, useState } from 'react';
import { bff } from './api';
import type { Store } from './types';

/** Danh sách cửa hàng (đang dùng) cho ô chọn; lỗi ⇒ danh sách rỗng (màn vẫn dùng được với giá chung). */
export function useStores(includeArchived = false): Store[] {
  const [stores, setStores] = useState<Store[]>([]);
  useEffect(() => {
    let live = true;
    bff<{ items: Store[] }>(`/api/admin/stores${includeArchived ? '?include_archived=true' : ''}`)
      .then((r) => live && setStores(r.items))
      .catch(() => live && setStores([]));
    return () => {
      live = false;
    };
  }, [includeArchived]);
  return stores;
}
