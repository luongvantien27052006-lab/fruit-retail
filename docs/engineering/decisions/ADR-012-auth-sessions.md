# ADR-012: Xác thực, phiên, 2FA, thiết bị POS (kể cả offline)

- Trạng thái: accepted (kỹ thuật) — Tiến xem lại mục "PIN offline"
- Ngày: 2026-11-17 · Căn cứ: SEC1–SEC6 §2.4, §6.12, §21.3.9, FR-INV-15/18

## Quyết định
- **Token:** access JWT 15 phút ký **EdDSA (Ed25519)**, header `kid`; khóa ký xoay vòng (2 khóa hoạt động, công
  khai qua cấu hình nội bộ). Claims: `sub`, `typ` (`master|viewer|staff|customer`), `sid` (session), `dev`
  (device, nếu có), `amr`, `step_up_until`. Không đưa quyền chi tiết vào token — server tra quyền mỗi request (thu
  hồi có hiệu lực ngay).
- **Refresh:** chuỗi ngẫu nhiên 256-bit, lưu `refresh_hash` (SHA-256) trong `sessions`, xoay vòng mỗi lần dùng, theo
  **họ** (`family_id`); dùng lại refresh đã xoay ⇒ thu hồi cả họ + audit. Hạn: admin 12 giờ trượt, staff 24 giờ,
  khách 60 ngày.
- **Web admin (Next.js):** BFF — token nằm trong cookie `HttpOnly; Secure; SameSite=Strict` của domain admin,
  trình duyệt không đọc được; mutation kèm header CSRF (double-submit). API chỉ nhận Bearer từ BFF/app.
- **2FA (SEC1):** TOTP (otplib), secret mã hóa (ADR-015); 10 mã khôi phục dùng 1 lần (lưu Argon2id). Master/Viewer
  chưa đăng ký 2FA ⇒ chỉ được gọi route đăng ký (`TWO_FACTOR_ENROLLMENT_REQUIRED`). `/auth/2fa/verify` cần
  **mfa_challenge** token ngắn hạn (5 phút, 1 lần) từ `/auth/login`.
- **Step-up (SEC2):** `/auth/step-up` ghi `step_up_until = now + 5 phút` vào session; route `x-step-up` kiểm cờ
  này. Áp cho: phát hành/thu hồi báo cáo, xuất danh sách khách, sửa giá nhập lô đã bán, tạo/khóa/gán vai trò tài
  khoản admin, reset 2FA người khác, cấu hình tiền.
- **Khóa (SEC5):** 5 lần sai liên tiếp ⇒ khóa 15 phút (tăng dần); đăng nhập admin từ thiết bị mới ⇒ sự kiện
  `auth.new_device_login` gửi Master.
- **Thiết bị POS (SEC3):** thiết bị tự sinh khóa (Ed25519) lưu Credential Manager/Keystore, đăng ký
  `pending` → Master/cửa hàng trưởng kích hoạt → `pos_devices.public_key`. `/auth/pin` và `/auth/refresh` của staff
  bắt buộc `X-Device-Id` + chữ ký thiết bị trên nonce; thiết bị bị thu hồi ⇒ mọi session của nó bị thu hồi.
- **OTP khách (SEC6):** giới hạn theo SĐT (hash), `X-Device-Id`, IP; OTP 6 số, hạn 5 phút, tối đa 5 lần thử.
- **PIN offline (counter, ≤ 24 giờ):** máy giữ bản cache `{staff_id, pin_hash Argon2id (m=64MB,t=3), roles,
  expires_at}` chỉ cho nhân viên đã đăng nhập online trên máy đó trong 24 giờ; cache mã hóa bằng khóa thiết bị;
  5 lần sai ⇒ khóa nhân viên đó trên máy đến khi online. Offline chỉ cho bán tiền mặt và đổi người bán; thao tác
  cần duyệt (hủy hóa đơn, cân tay, mở két) cần PIN quản lý cũng đã có trong cache, và mọi thao tác này được server
  kiểm lại khi đồng bộ (ghi `OFFLINE_APPROVED`, Master xem lại). Rủi ro: PIN 6 số có thể bị dò offline nếu mất máy
  → khóa thiết bị (`/admin/pos-devices/{id}/revoke`) xóa cache khi máy kết nối lại; chấp nhận vì SEC3 + mã hóa
  khóa thiết bị.

## Hệ quả
- OpenAPI thêm: `/auth/2fa/setup`, `/auth/2fa/confirm`, `/auth/2fa/recovery-codes`, `/auth/2fa/recover`,
  `/auth/sessions` (GET, DELETE `{id}`), `/auth/devices/register`, `/admin/users/{id}/2fa/reset`,
  `/admin/users/{id}/sessions`, `/admin/sessions/{id}/revoke`, `/admin/admin-accounts`, `/admin/users/{id}/lock|unlock`.
- `sessions` thêm `family_id`, `step_up_until`, `amr`, `last_used_at`, `ip_hash`; `pos_devices` thêm `public_key`,
  `status (PENDING|ACTIVE|REVOKED)`.
