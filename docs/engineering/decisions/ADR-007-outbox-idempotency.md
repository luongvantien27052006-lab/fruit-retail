# ADR-007: Transactional outbox, consumer idempotent, idempotency HTTP

- Trạng thái: accepted
- Ngày: 2026-11-17 · Người quyết: phiên điều phối (theo SPEC) · Căn cứ SPEC: §3.2, §6.12, §12.3, §13.1, §13.4

## Bối cảnh
Không được mất sự kiện báo cáo/thông báo khi Redis/worker khởi động lại, và không được ghi/trừ/thu tiền hai lần khi
client hoặc đối tác gửi lại (FR-INV-09, FR-INV-10).

## Quyết định
- **Outbox:** mỗi use case ghi `integration.outbox(id UUIDv7, event_type, aggregate_id, payload, occurred_at)` trong
  cùng transaction nghiệp vụ. Worker relay đọc `published_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT n`,
  đẩy vào BullMQ, đánh dấu `published_at`. Giao tối thiểu một lần.
- **Consumer:** mỗi consumer ghi `integration.processed_events(consumer, event_id)` PRIMARY KEY trong cùng
  transaction với tác dụng của nó; trùng → bỏ qua. Payload sự kiện theo schema `packages/contracts/events/*.json`
  có `event_id`, `event_type`, `schema_version`, `occurred_at`.
- **HTTP:** mọi POST/PATCH từ POS/app/admin có tiền/tồn bắt buộc `Idempotency-Key` (UUID). Bảng
  `integration.idempotency_keys(scope, key, request_hash, response, status, created_at, expires_at)`, scope =
  `(principal_id, method, route)`; cùng key + khác body → 409 `IDEMPOTENCY_CONFLICT`; đang xử lý → 409
  `IDEMPOTENCY_IN_PROGRESS`. Giữ 48 giờ (POS offline tối đa 24 giờ).
- **POS offline:** `client_txn_id` UUID v7 UNIQUE trên `pos_sales` (và cash movement, shift); đồng bộ theo thứ tự
  §6.12.
- **Webhook:** `integration.webhook_inbox UNIQUE(provider, external_id)`; xác thực trước khi xử lý, trả 200 nhanh,
  xử lý qua queue.
- **Dịch vụ ngoài:** gọi sau commit, ghi `integration.external_calls`; timeout → trạng thái `UNKNOWN`, tra cứu lại
  đối tác trước khi làm lại hành động có tiền.

## Phương án đã cân nhắc
| Phương án | Ưu | Nhược | Lý do loại |
|---|---|---|---|
| Publish thẳng Redis sau commit | Đơn giản | Mất sự kiện khi crash giữa commit và publish | Trái §3.2 |
| CDC (Debezium) | Không cần bảng outbox | Hạ tầng nặng | Quá mức |

## Hệ quả
- Test: gửi lại request/webhook/sự kiện 3 lần → một tác dụng (TEST-PAY-002, TEST-POS-004).
- Giám sát độ trễ outbox (cảnh báo khi `occurred_at` chưa publish > 1 phút).
