# ADR-001: Monorepo, package manager và thư mục ADR

- Trạng thái: accepted
- Ngày: 2026-11-17 · Người quyết: Tiến · Căn cứ SPEC: §19.1, §19.5

## Bối cảnh
Hệ thống có 4 app (NestJS, Next.js, 2 Flutter) và 3 package dùng chung (contracts, money_weight, client sinh từ
OpenAPI). Một người phát triển, cần một repo, một lần checkout, CI một nơi. SPEC §19.5 ghi ADR ở `docs/adr/`,
KẾ HOẠCH ghi `docs/engineering/decisions/` (CONTEXT NC-01).

## Quyết định
- Một monorepo `fruit-retail` theo cây §19.1 (`apps/`, `packages/`, `infra/`, `docs/`).
- JS/TS dùng **pnpm workspace** (`pnpm-workspace.yaml`, một `pnpm-lock.yaml` ở gốc); bật `packageManager` trong
  `package.json` gốc và Corepack. Dart/Flutter dùng **pub workspace** (Dart ≥ 3.6) cho `apps/customer_app`,
  `apps/staff_app`, `packages/shared_models`, `packages/money_weight/dart`; mỗi app giữ `pubspec.lock`.
- Không dùng Nx/Turborepo ở giai đoạn đầu; script gốc gọi `pnpm -r` và `flutter`/`dart` trực tiếp. Xem lại khi CI
  > 10 phút.
- ADR nằm ở **`docs/engineering/decisions/`** (Tiến chốt 2026-11-17), lệch §19.5 có chủ đích; SPEC không sửa vì đã
  khóa, chênh lệch ghi tại đây và CONTEXT NC-01.

## Phương án đã cân nhắc
| Phương án | Ưu | Nhược | Lý do loại |
|---|---|---|---|
| npm workspaces | Có sẵn | Chậm, hoisting lỏng, dễ dùng gói không khai báo | pnpm chặt hơn |
| Bun | Nhanh | Hệ NestJS/Prisma trên Bun chưa đủ ổn định cho production | Rủi ro |
| Nx/Turborepo | Cache, graph | Thêm tầng cấu hình cho 1 người | Chưa cần |

## Hệ quả
- CP02 tạo `pnpm-workspace.yaml`, `package.json` gốc, `pubspec.yaml` workspace gốc, `command-catalog.md`.
- Mọi lệnh JS chạy qua `pnpm`; cấm `npm install` trong repo. Đảo ngược: đổi package manager chỉ cần lockfile mới.
