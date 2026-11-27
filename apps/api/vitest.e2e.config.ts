import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// E2E trang quản lý (CP03 lát 8b): API thật + Next (admin-web, bản build production) + Chromium (Playwright).
// Chạy: pnpm --filter @fruit/admin-web build && pnpm --filter @fruit/api test:e2e
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: { include: ['test-e2e/**/*.e2e.ts'], testTimeout: 180_000, hookTimeout: 240_000, fileParallelism: false },
});
