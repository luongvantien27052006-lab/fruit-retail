import type { Provider } from '@nestjs/common';
import { DEFAULT_RATE_POLICIES, RATE_POLICIES, type RatePolicies } from '../../src/common/rate-limit';

/**
 * Chỉ cho test của lát 3/4 (đăng nhập dồn dập từ 127.0.0.1): cùng danh sách chính sách, ngưỡng nới thật rộng. Chèn qua
 * provider của test — không có biến môi trường nào tắt được giới hạn ở môi trường thật. Test lát 5 dùng ngưỡng thật.
 */
export const relaxedRatePolicies: Provider = {
  provide: RATE_POLICIES,
  useValue: Object.fromEntries(
    Object.entries(DEFAULT_RATE_POLICIES).map(([k, rules]) => [k, rules.map((r) => ({ ...r, max: 1_000_000 }))]),
  ) satisfies RatePolicies,
};
