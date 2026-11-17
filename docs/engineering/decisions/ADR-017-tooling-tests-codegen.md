# ADR-017: Test runner, DB test, sinh client, pub workspace, sửa ADR-010

- Trạng thái: accepted · Ngày: 2026-11-17 · Sửa: ADR-001 (pubspec.lock), ADR-010 (lý do Redis, cấu hình) · Căn cứ: fruit-engineering.md "test runner/generator chốt ở CP01", §15, §19.2

## Quyết định
- **Test TS:** Vitest (unit + integration) cho `apps/api`, `packages/*`; Playwright cho admin-web E2E. DB thật:
  **Testcontainers** (`postgis/postgis:17-3.5`) — mỗi file test một database tạo từ template đã migrate; không
  SQLite/in-memory.
- **Test Dart:** `flutter_test` + `integration_test`; drift test dùng SQLite thật của drift (đúng kho offline POS).
- **Sinh client:** tầng giao tiếp giữ tiền là **chuỗi**; chuyển `bigint`/`int` tường minh qua `money_weight`.
  TS: `openapi-typescript` + `openapi-fetch`. Dart: `swagger_parser` (Dart thuần, sinh `freezed`/`json_serializable`
  như §19.2, không cần Java). **Spike bắt buộc ở CP02** trên 3 route mẫu; spike thất bại ⇒ ADR mới.
- **Pub workspace:** một `pubspec.lock` ở gốc cho cả workspace (sửa ADR-001); xung đột phụ thuộc giữa `staff_app` và
  `customer_app` ⇒ tách khỏi workspace bằng ADR mới.
- **Migration:** SQL tay (trigger/RLS/role) nhúng trong `migration.sql` của Prisma (`prisma migrate dev
  --create-only` rồi thêm SQL) để một lịch sử duy nhất; `infra/sql/` chỉ còn bootstrap trước Prisma
  (`000_bootstrap.sql`: extension, schema, role) và file kiểm tra. Prisma không có down ⇒ chiến lược **forward-only**:
  sửa sai bằng migration mới; migration phá hủy cần Tiến duyệt.
- **Redis (sửa ADR-010):** lý do chọn 7.4 là BullMQ đã kiểm chứng, không phải giấy phép (thay đổi giấy phép bắt đầu
  từ 7.4). Bắt buộc `maxmemory-policy noeviction`, AOF `everysec`.
- **UUID v7:** PostgreSQL 17 không có `uuidv7()` ⇒ id luôn sinh ở ứng dụng; SQL/trigger không tự sinh id.
- **Mở rộng extension:** `postgis`, `pgcrypto`, `pg_trgm`, `unaccent` (tìm kiếm tiếng Việt theo KẾ HOẠCH CP02).

## Hệ quả
- `versions.json` thêm vitest, testcontainers, playwright, swagger_parser. KẾ HOẠCH CP02 cần kế hoạch con gom các hệ
  quả ADR (lint ranh giới module, bộ kiểm quyền DB, CI kiểm versions, spike COM, spike generator, runner Windows
  cho Flutter Windows, pgBackRest).
