# ADR-002: NestJS modular monolith, worker là entry thứ hai của `apps/api`

- Trạng thái: accepted
- Ngày: 2026-11-17 · Người quyết: Tiến · Căn cứ SPEC: §3.1, §3.2, §19.1, §19.3

## Bối cảnh
Quy mô 2–5 cửa hàng (§15: 3.000 hóa đơn/ngày, 500 đơn app/ngày). Một DB, một backend để doanh thu POS hiện ngay
trên trang quản lý (D20). Cần process nền cho outbox, projection báo cáo, push FCM, webhook 3PL, cron.

## Quyết định
- `apps/api` là **một ứng dụng NestJS** với 2 entry: `src/main.ts` (HTTP `/v1` + Socket.IO) và `src/worker.ts`
  (BullMQ consumer, outbox relay, projector, cron). Cùng image Docker, khác lệnh (`node dist/main.js` /
  `node dist/worker.js`) như §19.3.
- Module theo §3.1: `auth, rbac, catalog, pricing, inventory, purchasing, pos, app-orders, wholesale, delivery,
  payments, push-deals, notify, reporting, publish, audit, files` + `realtime` gateway. Module khai báo ở `imports`
  của module cha (§19.2).
- Ranh giới: module chỉ gọi nhau qua service public (export) hoặc sự kiện outbox; không đọc/ghi bảng của module
  khác trực tiếp ngoài repository của nó. Worker chỉ gọi service public, không có logic nghiệp vụ riêng.
- Quyết định tiền/tồn/trạng thái nằm trong transaction PostgreSQL ở API hoặc worker; Redis chỉ queue/cache/pub-sub.

## Phương án đã cân nhắc
| Phương án | Ưu | Nhược | Lý do loại |
|---|---|---|---|
| `apps/worker` riêng | Tách rõ deploy | Thêm package domain dùng chung, lệch §19.1 | Không cần ở quy mô này |
| Microservices | Mở rộng độc lập | Giao dịch phân tán, vận hành nặng | Trái §3.2 |

## Hệ quả
- Một `nest-cli` project, 2 entry build; test e2e khởi động riêng từng entry.
- Cần lint rule cấm import chéo nội bộ module (CP02: `eslint-plugin-boundaries` hoặc `dependency-cruiser`).
- Đảo ngược: tách worker thành app riêng chỉ là di chuyển entry, không đổi domain.
