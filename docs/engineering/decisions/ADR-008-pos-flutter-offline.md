# ADR-008: POS Flutter Windows + SQLite (drift) offline, `client_txn_id` UUID v7

- Trạng thái: accepted (Tiến duyệt 2026-11-17)
- Ngày: 2026-11-17 · Người đề xuất: phiên điều phối · Căn cứ SPEC: D3, §6.1, §6.12, §6.13, §19.2

## Bối cảnh
Quầy phải bán tiền mặt khi mất mạng (§6.1, §15), đọc cân qua COM, in ESC/POS, mở két. D3 đã chốt Flutter Windows;
tablet/shipper là Android trong cùng `apps/staff_app`.

## Quyết định
- `apps/staff_app` một codebase Flutter, chế độ `counter` (Windows), `tablet`, `shipper` (Android) chọn theo thiết
  bị đã kích hoạt + vai trò.
- Kho offline: **drift** (SQLite) trên counter; lưu danh mục/giá/barcode_rules đã tải, hàng đợi giao dịch chưa đồng
  bộ, số hóa đơn offline `CH01-Q1-OFF-000123`. Tablet/shipper không bán offline (chỉ cache đọc).
- Mỗi giao dịch có `client_txn_id` UUID v7 sinh ở máy; đồng bộ qua `POST /v1/pos/sync/upload` theo thứ tự mở ca →
  hóa đơn → thu chi → đóng ca; server idempotent (ADR-007), giá đã bán giữ nguyên.
- Offline tối đa 24 giờ; quá → khóa bán đến khi đồng bộ. Giờ máy lệch server > 10 phút → cảnh báo (§21.3.13).
- Offline chỉ nhận tiền mặt (VietQR không xác minh được, §6.6).
- Thiết bị: cân qua `flutter_libserialport` (COM/USB-serial), in ESC/POS qua thư viện ESC/POS, két qua lệnh in;
  mỗi loại có interface `ScaleDriver`, `ReceiptPrinter`, `CashDrawer` + bản `TEST_DOUBLE` chỉ cho dev/test. Lỗi thiết
  bị luôn hiện cho người dùng, không nuốt.
- Secret/token lưu Windows Credential Manager / Android Keystore (`flutter_secure_storage`).

## Phương án đã cân nhắc
| Phương án | Ưu | Nhược | Lý do loại |
|---|---|---|---|
| POS web (PWA) | Một app web | Khó truy cập COM/ESC/POS, offline yếu | Trái D3 |
| Isar/Hive | Nhanh | Không SQL, migration yếu, Isar ngừng phát triển | drift có SQL + migration |
| App Windows native (WPF) | Truy cập thiết bị tốt | Hai codebase | Trái D3 |

## Hệ quả
- Test offline POS bắt buộc (TEST-POS-004) và test thiết bị thật từng model cân/máy in (§15) — cần thiết bị mẫu
  trước CP07.
- Rủi ro: plugin serial trên Windows; kiểm sớm ở CP02 bằng spike đọc cân giả lập.
