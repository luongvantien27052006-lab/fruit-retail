# ADR-014: Lưu file qua presigned URL, kiểm sha256 phía server

- Trạng thái: accepted · Ngày: 2026-11-17 · Căn cứ: §3.5, FR-INV-16, §2.5

## Quyết định
- Object storage tương thích S3 (Cloudflare R2 hoặc tương đương — Tiến chọn nhà cung cấp, **khác** bucket backup);
  bucket riêng tư, không public URL.
- Upload 2 bước: `POST /v1/files/presign` (khai `kind`, `mime`, `bytes`, `sha256`, `captured_at`, `device_id`) →
  server tạo bản ghi `files(status=PENDING)` + presigned PUT 5 phút, giới hạn `Content-Length` và `Content-Type`
  theo `kind` (ảnh ≤ 5 MB `image/jpeg|webp`; file báo cáo do server tạo) → client PUT → `POST /v1/files/{id}/complete`
  → server tải lại object, **tự tính sha256**, so khai báo; lệch ⇒ `REJECTED`. Trùng sha256 với file khác ⇒ cảnh
  báo (không chặn, FR-INV-16).
- Ảnh hủy hàng/ảnh cân: app chỉ cho chụp trực tiếp + watermark; server ghi `capture_source`.
- Tải về: presigned GET 60 giây sau khi kiểm quyền; viewer tải qua `/viewer/files/{id}/download` — route dùng
  `viewer_act` ghi yêu cầu, file báo cáo đã phát hành được sao metadata sang `reporting.snapshot_files` (viewer đọc
  được), không chạm `core.files`.

## Hệ quả
- OpenAPI thêm `/files/presign`, `/files/{id}/complete`, `/files/{id}/download-url`. Việc của Tiến trước CP03:
  tài khoản object storage cho file ứng dụng.
