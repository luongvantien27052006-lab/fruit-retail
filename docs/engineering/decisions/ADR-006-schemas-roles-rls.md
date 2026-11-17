# ADR-006: 4 schema, 4 role DB, RLS cho Admin Chỉ Xem

- Trạng thái: accepted
- Ngày: 2026-11-17 · Người quyết: phiên điều phối (theo SPEC) · Căn cứ SPEC: §2.5, §3.3, §12.3, §12.4, §19.4

## Bối cảnh
Cổ đông/ban giám đốc chỉ được xem số đã lọc/đã phát hành (D13–D15). Lớp UI không phải bảo mật; cần chặn ở API và DB.

## Quyết định
- Schema: `core` (vận hành), `reporting` (projection + snapshot), `audit` (chỉ INSERT), `integration` (outbox,
  inbox, external_calls, processed_events, sql_migrations).
- Role đăng nhập: `app_rw` (CRUD `core`, INSERT/SELECT `integration`), `projector_rw` (SELECT `core` cần cho
  projection, ghi `reporting`), `viewer_ro` (chỉ `USAGE` + `SELECT` trên `reporting`, REVOKE
  `reporting.standard_cost_matrix`, không quyền gì trên `core`/`audit`/`integration`), `audit_writer` (chỉ INSERT
  `audit.*`). Owner schema là role `owner` không dùng cho app. `ALTER DEFAULT PRIVILEGES` để bảng mới tự theo.
- RLS bật trên mọi bảng `reporting.live_*`, `reporting.daily_revenue`, `reporting.snap_*`; policy theo
  `reporting.allowed_stores(current_setting('app.viewer_profile_id')::uuid)`; thiếu setting → không thấy dòng nào.
- `reporting.live_*` không chứa PII đầy đủ, không chứa giá nhập thật; giá vốn chỉ xuất hiện trong `snap_*` đã phát
  hành và theo `cost_visibility` của hồ sơ.
- Trigger chỉ-thêm trên `audit.*`, `reporting.snapshots`, `reporting.snap_*`.

## Phương án đã cân nhắc
| Phương án | Ưu | Nhược | Lý do loại |
|---|---|---|---|
| Một role + lọc trong code | Đơn giản | Một lỗi code lộ dữ liệu | Trái §2.5 lớp 3–4 |
| DB riêng cho reporting | Cô lập mạnh | Đồng bộ phức tạp, lệch D20 | Quá mức |

## Hệ quả
- Test bắt buộc TEST-VIEWER-001/002 (CP03). Migration role/RLS ở `infra/sql/`; rà bằng `database-reviewer` +
  `security-reviewer`.
