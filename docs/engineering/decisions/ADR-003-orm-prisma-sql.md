# ADR-003: Prisma cho bảng/truy vấn thường + SQL thủ công cho PostGIS, trigger, RLS, role

- Trạng thái: accepted
- Ngày: 2026-11-17 · Người quyết: Tiến · Căn cứ SPEC: §3.3, §12, §19.2, §19.5

## Bối cảnh
SPEC chọn Prisma. Prisma không mô hình hóa PostGIS `geography`, trigger, RLS policy, role DB; nhiều thao tác nhạy
cảm cần SQL chính xác (UPDATE có điều kiện cho hạn mức, `SELECT … FOR UPDATE`, khóa theo thứ tự).

## Quyết định
- **Prisma** (schema + `prisma migrate`) sở hữu DDL bảng/cột/index/khóa ngoại của các schema `core`, `reporting`,
  `audit`, `integration` (`multiSchema`). Cột PostGIS khai báo `Unsupported("geography(MultiPolygon,4326)")`.
- **`infra/sql/NNN_<ascii_snake>.sql`** sở hữu: extension (`postgis`, `pgcrypto`), role DB 4 loại + GRANT/REVOKE,
  trigger chỉ-thêm, RLS policy, index GIST/partial mà Prisma không biểu diễn, function SQL. Chạy sau Prisma migrate,
  theo số thứ tự, idempotent (`CREATE … IF NOT EXISTS`, `CREATE OR REPLACE`), ghi vào bảng
  `integration.sql_migrations(file, sha256, applied_at)`.
- Truy vấn: Prisma Client cho CRUD thường; `$queryRaw`/`$executeRaw` dạng **tagged template có tham số** (cấm
  `$queryRawUnsafe` với dữ liệu người dùng) cho: cập nhật hạn mức nguyên tử (§12.4), giữ tồn, FEFO, PostGIS
  `ST_Covers`, báo cáo.
- 4 Prisma Client theo 4 URL (§19.4): `app_rw`, `viewer_ro`, `projector_rw`, `audit_writer`; route `/viewer/*` chỉ
  được inject client `viewer_ro`. RLS viewer dùng `SET LOCAL app.viewer_profile_id` trong transaction.
- Tiền `BigInt` (Prisma ↔ `bigint` TS), gram `Int`; serializer API chuyển `bigint` → chuỗi (FR-INV-01).
- Không dùng `prisma db push` ngoài DB test dùng một lần; không `synchronize`.

## Phương án đã cân nhắc
| Phương án | Ưu | Nhược | Lý do loại |
|---|---|---|---|
| Kysely + SQL migration | Kiểm soát SQL tốt | Lệch §19.2, tự viết migration cho mọi bảng | Tiến chọn theo SPEC |
| TypeORM | Quen NestJS | `synchronize` dễ lạm dụng, kiểu BigInt yếu | Rủi ro |
| Drizzle | Gần SQL | Lệch SPEC | Không có lý do đủ mạnh |

## Hệ quả
- CP02 chốt phiên bản Prisma chính xác trong lockfile (`versions.json`) và cách chạy `infra/sql` trong CI.
- `database-reviewer` rà cả `schema.prisma` lẫn `infra/sql`. Drift giữa 2 nguồn được kiểm bằng test DB thật
  (truy vấn `pg_catalog` cho trigger/policy bắt buộc).
- Đảo ngược: tốn kém (đổi toàn bộ tầng truy cập); chấp nhận.
