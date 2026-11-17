# ADR-015: Mã hóa PII và secret trong DB

- Trạng thái: accepted · Ngày: 2026-11-17 · Căn cứ: FR-INV-18/19, §7.7, §15

## Quyết định
- Thuật toán: **AES-256-GCM**, nonce 96-bit ngẫu nhiên; định dạng `BYTEA` = `version(1) | key_id(2) | nonce(12) |
  ciphertext | tag(16)`. Khóa từ `PII_ENC_KEY` (nhiều khóa, `PII_ENC_KEYS` dạng `id:base64`, khóa ghi = khóa mới nhất).
  Xoay khóa: job đọc–giải mã–mã hóa lại theo lô, ghi audit, không dừng hệ thống.
- AAD = `table:column:row_id` để không bê ciphertext sang dòng khác.
- Tra cứu: `*_hash = HMAC-SHA256(PII_HASH_PEPPER, normalized)`; SĐT chuẩn hóa **E.164** (`+84…`), địa chỉ không
  băm tra cứu.
- Áp cho: `users.phone_enc`, `customers.phone_enc`, `customer_addresses.receiver_phone_enc/address_enc`,
  `wholesale_customers.phone_enc/address_enc` (+ thêm `phone_hash`), `users.totp_secret_enc`,
  `suppliers.bank_enc` (thay `bank jsonb`), `app_orders.address_snapshot_enc`.
- Tọa độ `customer_addresses.location`: giữ dạng rõ để tìm vùng giao (PostGIS) nhưng **làm tròn 4 chữ số thập phân
  (~11 m)** khi lưu; ai có SELECT bảng này coi như thấy PII ⇒ chỉ `app_rw`.
- Payload thô của đối tác (`payments.raw`, `webhook_inbox.body`, `unmatched_bank_txns.content`,
  `external_calls.request/response`): lọc trường nhạy cảm (số tài khoản, tên người chuyển) trước khi lưu theo
  danh sách cho từng provider; phần cần giữ để đối soát mã hóa bằng cơ chế trên.
- Log Pino: redact `phone`, `address`, `token`, `otp`, `pin`, `authorization`, `account*`.

## Hệ quả
- ERD đổi cột tương ứng; test: không có SĐT rõ trong DB dump và log.
