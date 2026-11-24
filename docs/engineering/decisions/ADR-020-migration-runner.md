# ADR-020: Áp migration Prisma bằng bộ chạy SQL của dự án; phiên = họ refresh token

- Trạng thái: accepted · Ngày: 2026-11-24 · Người quyết: phiên điều phối (CP03 lát 1)
- Làm rõ: ADR-003, ADR-017 (cách áp migration), ADR-012 (bảng phiên), ADR-011 (quyền đọc audit)

## Bối cảnh
ADR-017 chốt "SQL tay nhúng trong `migration.sql` của Prisma, một lịch sử duy nhất, forward-only". Khi làm CP03 lát 1:
1. `prisma migrate deploy` cần CLI Prisma (devDependency) trong image chạy; image runtime chỉ có dependency production.
2. Prisma ghi sổ ở bảng `_prisma_migrations` riêng, không kiểm sha256 file đã áp như bộ chạy `infra/sql` (CP02,
   ADR-019) — có hai sổ, hai cách kiểm.
3. Prisma 7 `migrate diff --from-empty` vẫn đòi datasource (URL giả được, không kết nối).
4. Image `postgis/postgis` tạo sẵn `postgis_topology`, `postgis_tiger_geocoder` và bảng PostGIS ở `public` có
   `GRANT SELECT TO PUBLIC` ⇒ viewer_ro SELECT được (bộ kiểm `checkViewerRls` phát hiện).

## Quyết định
- **Vị trí:** `apps/api/prisma/migrations/NNNN_<ascii_snake>/migration.sql` (bố cục Prisma, để dùng được
  `prisma migrate diff`), mỗi thư mục đúng một file. Nội dung = DDL Prisma sinh + **SQL tay ở cuối file** (CHECK,
  index biểu thức/partial, trigger, GRANT/REVOKE, RLS, function, seed dữ liệu tham chiếu).
- **Áp:** `db-bootstrap` (`applySqlMigrations`) chạy `infra/sql/NNN_*.sql` rồi các thư mục Prisma theo thứ tự tên; ghi
  `integration.sql_migrations` với khóa `prisma/<thư mục>` + sha256; file đã áp bị sửa hoặc mất ⇒ dừng. Mỗi migration
  một transaction. **Không dùng** `prisma migrate deploy`/`_prisma_migrations`.
- **Sinh migration mới:** áp toàn bộ migration vào DB dev → `prisma migrate diff --from-config-datasource
  --to-schema prisma/schema.prisma --script` → tạo thư mục mới, nối SQL tay. Migration đầu dùng `--from-empty`.
- **Chống lệch:** test DB thật chạy `prisma migrate diff --from-config-datasource --to-schema … --exit-code` sau khi áp
  — lệch ⇒ đỏ. Bảng `integration.sql_migrations` (tạo bởi `000`) khai báo model `SqlMigration` để diff không báo xóa;
  không role ứng dụng nào có quyền trên nó. (Không dùng `tables.external` vì còn là tính năng thử nghiệm của Prisma 7.)
- **`infra/sql`** vẫn chỉ cho phần trước Prisma: `000_bootstrap.sql`, `001_extension_privileges.sql` (thu hồi quyền
  PUBLIC trên `topology`/`tiger`/`tiger_data` và bảng PostGIS ở `public`; `spatial_ref_sys` chỉ cấp cho app_rw,
  projector_rw).
- **Phiên (làm rõ ADR-012):** `core.sessions` = một họ (family) — `id` là `family_id`; mỗi lần xoay tạo dòng
  `core.refresh_tokens` (`token_hash` SHA-256, `used_at`, `replaced_by_id`). Dùng lại token đã có `used_at` ⇒ thu hồi
  cả phiên. Thử thách ngắn hạn (`mfa_challenge`, nonce thiết bị) ở `core.auth_challenges` (hạn ≤ 10 phút, ≤ 5 lần thử).
- **Đọc audit (làm rõ ADR-011):** `app_rw` có `SELECT` trên `audit.logs`, `audit.export_logs`, `audit.login_logs`,
  `audit.viewer_access` cho chức năng "Nhật ký hệ thống" của Master (§2.2, `audit:read`); vẫn không UPDATE/DELETE/TRUNCATE,
  trigger chỉ-thêm chặn cả owner.
- **Quyền cấp riêng:** `core.user_permission_grants` cho trường hợp §2.1 (WAREHOUSE_STAFF + `purchase_price:write`),
  không thêm vào vai trò.

## Phương án đã cân nhắc
| Phương án | Lý do loại |
|---|---|
| `prisma migrate deploy` trong image | Cần CLI dev trong runtime; hai sổ migration; không kiểm sha256 |
| Viết toàn bộ DDL tay ở `infra/sql`, Prisma chỉ `db pull` | Trái ADR-003 (Prisma sở hữu DDL bảng); dễ lệch kiểu |
| `DROP EXTENSION postgis_topology, postgis_tiger_geocoder` | Thu hồi quyền đủ an toàn, không phá image; xóa extension để CP19 nếu cần |

## Hệ quả
- `apps/api/Dockerfile` chép `apps/api/prisma/migrations` vào image (`/app/prisma/migrations`); biến
  `PRISMA_MIGRATIONS_DIR` (mặc định `prisma/migrations`).
- `command-catalog.md` thêm lệnh sinh migration và kiểm lệch.
- Test: `apps/api/test/foundation-schema.test.ts` (thứ tự áp, chống lệch, quyền từng role, chỉ-thêm, RLS, seed, ràng buộc).
