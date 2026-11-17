// Prisma 7: cấu hình ngoài schema (ADR-003, ADR-017).
// URL migrate dùng role owner, chỉ có ở CI/deploy. `prisma generate` không cần URL; thiếu URL khi migrate
// thì Prisma báo lỗi — không có URL mặc định (FR-INV-17).
import { defineConfig } from 'prisma/config';

const migrateUrl = process.env['DATABASE_URL_MIGRATE'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  ...(migrateUrl ? { datasource: { url: migrateUrl } } : {}),
});
