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

- **Bộ chạy — một thứ tự duy nhất (sửa theo kiểm thử agent):** migration chưa áp đứng TRƯỚC migration đã áp ⇒ dừng
  (thêm file `infra/sql` sau khi đã có migration Prisma cũng bị chặn — dùng migration Prisma mới); mục lạ (`.SQL`,
  `.bak`, thư mục) ⇒ dừng; trùng số ⇒ dừng; lệnh điều khiển transaction (`COMMIT`, `BEGIN;`, `SAVEPOINT`…) trong file ⇒
  dừng (bộ chạy tự bọc transaction). Lọc tĩnh xét từ đầu của từng câu lệnh cấp ngoài sau khi bỏ comment, chuỗi
  (`` chỉ thoát trong `E'…'`), thân `$tag$`; thêm **chốt lúc chạy**: cờ LOCAL `fruit.migration_tx` mất sau khi chạy file
  ⇒ file đã tự kết thúc transaction ⇒ dừng, không ghi sổ.
  Thân hàm SQL kiểu `BEGIN ATOMIC … END` bị lọc tĩnh coi là `END` ⇒ migration viết thân hàm bằng `$$`. Sau mỗi file
  bộ chạy `RESET ALL; RESET ROLE; RESET SESSION AUTHORIZATION` để `SET` cấp phiên không rò sang file sau. DDL Prisma sinh từ rỗng **bỏ** bảng `integration.sql_migrations` (đã có từ 000).
- **Quyền UPDATE theo cột ở `core`:** default privileges của 000 cấp UPDATE cả bảng cho app_rw; mỗi migration tạo bảng
  `core` phải `REVOKE UPDATE` rồi `GRANT UPDATE (cột…)` đúng cột nghiệp vụ. Không ai UPDATE được khóa chính, `users.type`,
  khóa thiết bị, mốc tạo — bộ kiểm `checkNoKeyUpdate` chặn ở CI.
- **Bất biến bằng trigger:** `users.type`/`id` bất biến; gán vai trò/quyền riêng chỉ được thu hồi một lần; phiên thu hồi
  không sửa được, `user_type` = loại người dùng, phiên nhân viên chỉ trên thiết bị `ACTIVE`; refresh token đã xoay không
  sửa được, token mới chỉ cho phiên chưa thu hồi, token thay thế phải cùng phiên; thiết bị POS `REVOKED` đóng băng và
  **thu hồi mọi phiên đang mở trên nó** (trigger AFTER), phiên trên thiết bị không còn ACTIVE chỉ được thu hồi, nonce
  thiết bị chỉ phát cho thiết bị ACTIVE; các kiểm "thiết bị ACTIVE"/"phiên chưa thu hồi" trong trigger dùng `FOR SHARE`
  (khóa dòng tới hết transaction) để thu hồi chạy đồng thời phải chờ rồi mới đóng phiên — test tranh chấp hai kết nối; mốc kích hoạt bất biến, quầy phải cùng cửa hàng (FK kép); thời điểm
  `created_at`/`granted_at`/`issued_at`/`audit.*.at`, mốc kích hoạt/thu hồi (`activated_at`, `revoked_at`, `used_at`) do
  server đặt (`now()`).
- **Viewer:** `reporting.allowed_stores()` **không tham số** (đọc hồ sơ từ `app.viewer_profile_id` trong transaction) —
  viewer không liệt kê được cửa hàng của hồ sơ khác qua lời gọi trực tiếp. Viewer tự `SET app.viewer_profile_id` được
  (giới hạn của thiết kế ADR-011): rủi ro chỉ khi API có SQL injection; API đặt hồ sơ bằng `set_config(…, true)` từ phiên
  đã xác thực, không nhận từ client.
- **audit_writer / viewer_act** chỉ có INSERT (không SELECT) ⇒ không dùng `INSERT … RETURNING` (Prisma `create`); dùng
  `createMany` hoặc `$executeRaw`.
- **Cluster:** 001 thu CONNECT/TEMP của PUBLIC trên mọi database khác (`postgres`, `template_postgis`, `template1`) và
  EXECUTE các hàm large object (`lo_*`, `loread`, `lowrite`). Database tạo SAU khi chạy 001 lại có CONNECT/TEMP mặc định
  cho PUBLIC — dự án chỉ dùng một database; tạo database mới phải chạy lại thu hồi (pg_hba ở VPS giới hạn `host fruit`). `NOTIFY` không thu hồi được — chấp nhận (không lộ dữ liệu).
- **Giới hạn đã biết:** superuser vượt được trigger chỉ-thêm (`session_replication_role`) — app không chạy bằng superuser;
  bản sao nhật ký ra ngoài (§14 F14) làm ở CP19. Cột `*_by` (người thao tác) không có FK để nhật ký không phụ thuộc vòng
  đời bảng người dùng (người dùng không bị xóa). Hàm SECURITY DEFINER thuộc owner (superuser), `search_path = pg_catalog,
  pg_temp`, mọi tên ghi đủ schema — tách role chủ hàm NOLOGIN để CP19.

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
