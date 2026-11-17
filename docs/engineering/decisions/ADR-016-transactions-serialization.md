# ADR-016: Truyền transaction giữa module và tuần tự hóa BigInt

- Trạng thái: accepted · Ngày: 2026-11-17 · Căn cứ: FR-INV-01/10, ADR-002, ADR-003, ADR-004

## Quyết định
- **Transaction:** `@nestjs-cls/transactional` + adapter Prisma. Use case đánh dấu `@Transactional()`; service của
  module khác lấy client qua `TransactionHost` nên chạy chung transaction (không truyền `tx` tay). Cấm gọi dịch vụ
  ngoài bên trong transaction (lint rule + review). Mức cô lập mặc định READ COMMITTED; chỗ cần khóa dùng
  `SELECT … FOR UPDATE` theo thứ tự khóa (ERD §6).
- **Ghi audit + outbox:** helper `recordAudit()` và `emitEvent()` chỉ dùng được trong transaction đang mở (ném lỗi
  nếu không có) — bảo đảm FR-INV-10.
- **BigInt:** một codec duy nhất `@fruit/money_weight` (`toWire(bigint) → string`, `fromWire(string) → bigint`)
  dùng cho: response HTTP, payload outbox (cột `jsonb`), job BullMQ, tin Socket.IO, log Pino, file Excel. Cấm
  `JSON.stringify` trực tiếp đối tượng có tiền — lint rule cấm `BigInt.prototype.toJSON` monkey-patch. `$queryRaw`
  trả `bigint` cho `SUM/COUNT` ⇒ ép tường minh.
- **Tiền trong jsonb:** chuỗi số nguyên, kiểm bằng JSON Schema trong `packages/contracts/jsonb/` + CHECK
  `jsonb_path` khi khả thi; ưu tiên tách bảng quan hệ cho dữ liệu có tiền (ERD §2.5).
- **Tỷ lệ/phần trăm:** `INTEGER` basis points (`*_bps`), cấm `real/double`.

## Hệ quả
- Test CP03: rollback toàn phần khi bước cuối lỗi (nghiệp vụ + audit + outbox cùng mất).
