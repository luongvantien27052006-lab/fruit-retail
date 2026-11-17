---
name: feature-development
description: Quy trình hiện thực một tính năng trong checkpoint đang mở của dự án chuỗi bán lẻ hoa quả.
allowed-tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /feature-development

Dùng khi hiện thực một phần việc thuộc CP đang mở (xem `docs/engineering/execution/STATUS.md`).

## File thường chạm

- `packages/contracts/openapi.yaml`, `packages/contracts/events/**` (hợp đồng trước)
- `apps/api/**`, `apps/admin-web/**`, `apps/staff_app/**`, `apps/customer_app/**`
- `packages/money_weight/**` (mọi phép tiền/cân)
- `**/*.test.*`, `**/*_test.dart`, `TESTS.md`, `REGRESSION.md`

## Trình tự

1. Đọc mục CP trong KẾ HOẠCH + § SPEC liên quan; nắm hiện trạng trước khi sửa.
2. Tạo/cập nhật TEST-ID trong `TESTS.md`; viết test đỏ cho tiền/cân/tồn/trạng thái/quyền (PostgreSQL thật).
3. Thay đổi nhỏ nhất đủ mục tiêu: contracts → sinh client → server → client.
4. Kiểm chứng: `verification-loop` + `module-regression` (lệnh từ `command-catalog.md`, ghi cwd + exit code).
5. Review theo bảng định tuyến trong `fruit-engineering.md`; tóm tắt đã đổi gì và còn gì chưa kiểm.

## Commit

`feat:` hiện thực · `test:` test · `docs:` tài liệu — trên nhánh `feat/cpxx-*`.
