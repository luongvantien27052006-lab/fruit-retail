import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Môi trường demo để bấm thử bằng tay (không phải test): `pnpm --filter @fruit/api run demo` — xem test-e2e/demo.run.ts.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: { include: ['test-e2e/demo.run.ts'], testTimeout: 24 * 3600_000, hookTimeout: 240_000 },
});
