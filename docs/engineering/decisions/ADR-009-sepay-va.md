# ADR-009: Thanh toán chuyển khoản bằng SePay VA theo đơn (BIDV doanh nghiệp)

- Trạng thái: accepted
- Ngày: 2026-11-17 · Người quyết: phiên điều phối (theo D5) · Căn cứ SPEC: D5, D10, §6.6, §13.4, §18.3, §21.3.10

## Bối cảnh
Cần xác nhận chuyển khoản tự động, đúng số tiền, cho hóa đơn POS, đơn app "trả sau khi cân" và đơn sỉ.

## Quyết định
- Mỗi lần thu tạo `core.payments(PENDING)` rồi (sau commit) gọi SePay tạo **VA riêng với đúng số tiền**; lưu
  `sepay_va`, `qr_payload`, `expires_at`. Ngân hàng của khách từ chối chuyển sai số (T05).
- Webhook `POST /v1/webhooks/sepay`: xác thực API key theo tài liệu SePay + kiểm thời gian chống replay → ghi
  `webhook_inbox` (unique mã giao dịch) → 200 → xử lý qua queue: khớp VA → `SUCCEEDED` (không bao giờ lùi về
  FAILED) → sự kiện `payment.succeeded`.
- Không khớp → `unmatched_bank_txns`, Master khớp tay. Đối soát mỗi giờ + cuối ngày bằng API lịch sử giao dịch;
  cảnh báo khi 30 phút giờ bán không có webhook.
- Thiếu `SEPAY_*` → 503 `CONFIGURATION_NOT_READY` cho thanh toán mới; adapter `TEST_DOUBLE` chỉ ở dev/staging.
- Trạng thái `payments`: `PENDING → SUCCEEDED | EXPIRED | CANCELLED`; timeout gọi SePay = `UNKNOWN` → tra cứu lại.

## Phương án đã cân nhắc
| Phương án | Ưu | Nhược | Lý do loại |
|---|---|---|---|
| QR tĩnh + nội dung CK | Không cần VA | Khách sửa số tiền/nội dung, khớp sai | D5 |
| Cổng thanh toán thẻ/ví | Đa phương thức | Phí cao, ngoài phạm vi | Không cần |

## Hệ quả
- Phụ thuộc bên ngoài: tài khoản BIDV DN + SePay (Việc của Tiến trước CP08).
- Endpoint và trường webhook chính xác lấy từ tài liệu SePay khi tích hợp (CP08); hợp đồng nội bộ ở OpenAPI.
