---
name: database-migration
description: Quy trình thay đổi schema PostgreSQL (Prisma migrate + SQL thủ công infra/sql) cho dự án chuỗi bán lẻ hoa quả.
allowed-tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /database-migration

Dùng khi đổi bảng, index, trigger, RLS, role DB hoặc PostGIS. Nạp skill `database-migrations` + `postgres-patterns`;
review bằng `database-reviewer`.

## File thường chạm

- Prisma schema + thư mục migration (vị trí theo ADR-003)
- `infra/sql/NNN_*.sql` — trigger chỉ-thêm, RLS, role (`app_rw`, `viewer_ro`, `projector_rw`, `audit_writer`), PostGIS

## Trình tự

1. Đọc SPEC §12 + §21.8 cho bảng liên quan; chạy `change-impact` (dữ liệu, hợp đồng, test, rollback).
2. Viết test DB đỏ trên PostgreSQL thật (Docker).
3. Viết migration: tiền `BIGINT`, gram `INTEGER`, UUID v7, `TIMESTAMPTZ`; có rollback hoặc ghi rõ phần không đảo
   được. Migration phá hủy/xóa dữ liệu → dừng, hỏi Tiến.
4. Chạy migration trên database test dùng một lần, chạy test, ghi lệnh + exit code.
5. Cập nhật ERD (`docs/engineering/data/ERD.md`) và `REGRESSION.md` nếu hạ nguồn đổi.

## Commit

`feat:` migration mới · `fix:` sửa migration chưa phát hành.
