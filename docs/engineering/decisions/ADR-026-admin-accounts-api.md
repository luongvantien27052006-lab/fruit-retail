# ADR-026: API quản trị tài khoản — admin, khóa/mở khóa, reset 2FA, phiên, nhật ký (CP03 lát 8a)

- Trạng thái: accepted (kỹ thuật) · Ngày: 2026-11-27 · Người quyết: phiên điều phối (CP03 lát 8a) — chờ agent
  security-reviewer kiểm
- Làm rõ: ADR-012, ADR-021 (đăng nhập Master), ADR-024 (phạm vi, step-up, quy tắc cửa hàng trưởng), SEC2, SEC4, §2.1, §14

## Quyết định
1. **Lát 8 chia hai phần**, mỗi phần kiểm thử riêng: 8a = API quản trị còn lại (ADR này); 8b = admin web Next.js (BFF
   cookie HttpOnly, CSRF, CSP nonce, màn hình). `/admin/settings` (GET/PATCH) **để lại**: chưa có bảng cấu hình, các mục cấu
   hình (SePay, OTP, push, COD, bớt lẻ) thuộc CP tương ứng — làm cùng nghiệp vụ đó.
2. **`POST /admin/admin-accounts`** (chỉ Master, step-up): tạo MASTER_ADMIN hoặc VIEW_ONLY_ADMIN (+ đúng một hồ sơ xem).
   Mật khẩu tạm 120 bit băm Argon2 TRƯỚC transaction, trả **một lần** trong response (no-store toàn cục), không vào DB rõ /
   audit / log; lần đăng nhập đầu bắt buộc đăng ký 2FA (luồng ADR-021). Email trùng ⇒ 409.
3. **Khóa** `POST /admin/users/{id}/lock` (`x-scope: store`, step-up cho tài khoản 2FA; nhân viên miễn tường minh):
   Master khóa mọi tài khoản trừ mình; cửa hàng trưởng chỉ nhân viên mà mọi vai trò là CASHIER/PICKER ở cửa hàng của máy,
   không có quyền cấp riêng (cùng quy tắc `/admin/staff`); ngoài phạm vi ⇒ 404. Khóa ⇒ `status = LOCKED` + thu hồi mọi phiên
   (`USER_LOCKED`). **Không khóa Master ACTIVE cuối cùng** (`LAST_MASTER_REQUIRED`, khóa advisory `last-master` ⇒ hai Master
   khóa nhau song song chỉ một thành công).
4. **Mở khóa** (chỉ Master, step-up — thêm `x-master-only` vào hợp đồng): không đảo được quyết định khóa bởi người không có
   phạm vi ALL (ADR-024 L1). Xóa bộ đếm sai + khóa tạm.
5. **Reset 2FA** (chỉ Master, step-up; tài khoản Master/Viewer khác, không tự reset): xóa secret + bước TOTP + mã khôi phục
   + thử thách MFA đang mở, thu hồi mọi phiên ⇒ đăng nhập sau phải đăng ký lại.
6. **Phiên người khác** (chỉ Master): xem 100 phiên gần nhất; thu hồi một phiên (`ADMIN_REVOKED`), không thu hồi phiên
   hiện tại của chính mình (dùng đăng xuất).
7. **Nhật ký** `GET /admin/audit-logs` (`audit:read`): lọc hành động / loại + id đối tượng / người làm / khoảng thời gian,
   phân trang con trỏ id (UUIDv7 giảm dần), ≤ 100 dòng.
8. **Đồng bộ với lần thử đăng nhập** (lát 6 L1/G4): mọi thao tác đổi trạng thái xác thực lấy
   `pg_advisory_xact_lock('auth:'||id::uuid::text)` rồi khóa dòng users, khóa phiên `ORDER BY id`; đăng nhập Master đọc LẠI
   mã băm mật khẩu và secret 2FA trong transaction đang giữ khóa (khác bản đọc trước ⇒ sai, cùng thời gian nhờ Argon giả).
9. Cùng lát làm ghi nhận lát 6: G1 (Argon giả ở nhánh PIN trống/nghỉ việc trong khe đua), G2 (ngày 1900–2100), G3 (so tự
   gán chữ thường), G4 (mục 8).

## Sửa theo kiểm thử agent lần 1 (f8163ef)
- **L1 (TB):** chỉ khóa tài khoản ĐANG ACTIVE (DISABLED/LOCKED ⇒ 409) — trước: khóa người Master đã cho nghỉ (DISABLED) rồi Master
  bấm mở khóa sẽ hồi sinh tài khoản.
- **L2 (Thấp):** người không phải Master kiểm phạm vi TRƯỚC khi lấy khóa đăng nhập của tài khoản đích (không cản đăng nhập Master
  bằng cách gửi khóa liên tục), kiểm lại sau khi khóa.
- **L3 (Thấp):** so phiên hiện tại không phân biệt hoa/thường.
- Ghi nhận đã làm: G-a (nhánh thành công của đăng nhập dùng trạng thái 2FA đọc dưới khóa); G-c (che `*.temporary_password` trong
  log; khi làm bộ idempotency không được lưu response của route này); G-d (`GET /admin/audit-logs` chỉ Master).
- Ghi nhận để 8b: G-b — chưa có đổi mật khẩu: lần đăng ký 2FA đầu tiên (admin web) bắt buộc đổi mật khẩu tạm; tài khoản chưa
  kích hoạt hết hạn (đề xuất 72 giờ); reset 2FA tùy chọn cấp kèm mật khẩu tạm mới. G-e — "Master ACTIVE cuối" đếm cả Master chưa
  kích hoạt 2FA: bất biến ≥ 1 Master ACTIVE vẫn giữ (người gọi không tự khóa mình); chấp nhận.

## Hệ quả
- Không migration. OpenAPI: schema `AdminAccountCreate*`, `ReasonRequest`, `UserLock/UnlockResponse`,
  `TwoFactorResetResponse`, `AdminSessionList`, `SessionRevokeResponse`, `AuditLogList`; `x-scope` cho lock, `x-master-only`
  cho unlock. Danh sách trắng `staffExempt` thêm `POST /admin/users/{id}/lock`.
