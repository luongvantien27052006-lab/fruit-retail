import { createApp } from './bootstrap';
import { loadEnv } from './config/env';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await createApp(env);
  await app.listen(env.PORT, '0.0.0.0');
}

main().catch((err: unknown) => {
  // Lỗi khởi động phải hiện ra và dừng process — không chạy tiếp ở trạng thái nửa vời.
  console.error('[api] khởi động thất bại:', err instanceof Error ? err.message : err);
  process.exit(1);
});
