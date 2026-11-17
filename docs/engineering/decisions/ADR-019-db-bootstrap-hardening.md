# ADR-019: Cứng hóa bootstrap DB và môi trường local (sửa theo review CP02)

- Trạng thái: accepted · Ngày: 2026-11-18 · Bổ sung: ADR-011, ADR-017 · Căn cứ: review agent CP02 (bảo mật; mã + DB)

## Quyết định
1. **Extension ở schema `public`**: image `postgis/postgis` cài sẵn PostGIS vào `public` và PostGIS không chuyển schema
   được. `public`: REVOKE ALL FROM PUBLIC; chỉ `app_rw`, `projector_rw` có USAGE (gọi hàm PostGIS/unaccent/pg_trgm);
   không role nào CREATE; viewer không có USAGE. `search_path`: `app_rw` = `core, public`; `projector_rw` =
   `reporting, public`; `viewer_ro` = `reporting`.
2. **Không quyền mặc định cho `projector_rw`** (bỏ default SELECT `core` và SELECT/INSERT/UPDATE/DELETE `reporting`):
   GRANT tường minh từng bảng nguồn/bảng projection trong migration. `app_rw` giữ mặc định SELECT/INSERT/UPDATE ở
   `core`, SELECT/INSERT ở `integration`, SELECT ở `reporting`; **bảng chỉ-thêm phải REVOKE UPDATE/DELETE/TRUNCATE
   trong cùng migration**, và `checkAppendOnlyPrivileges()` (mọi bảng có trigger `core.raise_immutable`) chạy trong
   test DB để chặn trường hợp quên.
3. `REVOKE CONNECT, TEMPORARY ON DATABASE … FROM PUBLIC`; GRANT CONNECT cho 5 role ứng dụng.
4. **Bootstrap chạy bằng superuser của cluster** (cần cho `CREATE EXTENSION postgis` và thuộc tính role). Runtime
   (api/worker) không bao giờ dùng role này. Staging/production: superuser chỉ dùng ở bước bootstrap/migrate.
5. Mật khẩu role đặt bằng **SCRAM-SHA-256 verifier tính phía client** — mật khẩu thô không vào câu lệnh SQL/log.
   Bộ chạy từ chối mật khẩu < 12 ký tự (dev) / < 24 (staging, production), còn `change-me`, hoặc trùng nhau; kiểm cả
   `PG_OWNER_PASSWORD`. Có `pg_advisory_lock`, phát hiện file đã áp bị xóa, không để lỗi ROLLBACK che lỗi gốc.
6. Môi trường local: Redis có `requirepass`; mỗi service chỉ nhận URL DB của role nó dùng (api không có
   `projector_rw`; worker không có viewer); container `no-new-privileges` + `cap_drop: ALL` (chỉ thêm lại capability
   tối thiểu cho postgres/redis/caddy); Caddy ghi đè `X-Request-Id` bằng UUID, thêm CSP/Permissions-Policy/COOP,
   giới hạn body 10 MB, tắt admin API. API chỉ nhận `X-Request-Id` khớp `^[A-Za-z0-9._-]{8,128}$`.
7. Chuỗi cung ứng: `packageManager` có hash sha512; `minimumReleaseAge: 1440`, `strictDepBuilds: true` ghi tường minh;
   image gitleaks pin digest; `actions/checkout` `persist-credentials: false`.

## Hệ quả
- File `000_bootstrap.sql` đã đổi nội dung trước khi có môi trường dùng chung nào (chỉ DB local của phiên CP02, đã
  tạo lại) — từ nay mọi thay đổi SQL bằng file mới.
- Còn mở cho CP02 phần VPS: pin image theo digest, Caddyfile staging có HSTS, Redis ACL, CSP nonce cho Next (CP03).
