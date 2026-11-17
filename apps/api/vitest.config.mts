import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC để giữ decorator metadata cho DI của NestJS.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: { include: ['test/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 180_000 },
});
