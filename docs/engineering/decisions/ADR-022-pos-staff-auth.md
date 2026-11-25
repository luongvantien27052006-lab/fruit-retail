# ADR-022: Xác thực nhân viên POS và vòng đời thiết bị — cách hiện thực SEC3/ADR-012 (CP03 lát 4)

- Trạng thái: accepted (kỹ thuật) · Ngày: 2026-11-25 · Người quyết: phiên điều phối (CP03 lát 4) — chờ agent
  security-reviewer kiểm
- Làm rõ: ADR-012 (thiết bị POS, PIN, hạn phiên staff 24 giờ), ADR-021 (một lần thử = một transaction), lát 1
  (trigger `pos_device_transition`, `pos_device_revoke_sessions`, `sessions_guard`, `auth_challenges_guard`)

## Bối cảnh
ADR-012 chốt: thiết bị tự sinh khóa Ed25519, đăng ký PENDING → Master/cửa hàng trưởng kích hoạt; `/auth/pin` và
`/auth/refresh` của staff bắt buộc `X-Device-Id` + chữ ký thiết bị trên nonce; thu hồi thiết bị ⇒ thu hồi mọi phiên.
Chưa chốt: nonce lấy từ đâu (hợp đồng không có route phát nonce), thông điệp ký, cách người kích hoạt nhận đúng máy,
chống spam route đăng ký công khai, phạm vi cửa hàng của nhân viên khi đăng nhập.

## Quyết định
1. **Nonce do thiết bị sinh + thời điểm** (không thêm route phát nonce — tránh thêm route ngoài §13.2 cần NC mới):
   `device_proof = {ts (epoch giây), nonce (16–32 byte base64url), signature (Ed25519)}`. Server chấp nhận khi
   |now − ts| ≤ 120 s, chữ ký đúng với `pos_devices.public_key`, và nonce chưa dùng — nonce ghi vào
   `auth_challenges` (kind `DEVICE_NONCE`, `secret_hash = SHA-256(device_id:nonce)` duy nhất, hạn 5 phút > cửa sổ
   thời điểm lớn nhất 240 s nên dòng không bị dọn khi còn dùng được). Nonce ghi trong **transaction riêng đã commit
   trước** khi kiểm PIN/refresh: request sau đó lỗi (PIN sai) vẫn không phát lại được cùng chữ ký. Dòng hết hạn của
   chính thiết bị được dọn trong cùng transaction. Đồng hồ thiết bị lệch > 2 phút ⇒ 401 (app đồng bộ giờ theo header
   `Date` của server).
2. **Thông điệp ký** (UTF-8, nối `\n`): `fruit-device-proof/v1`, mục đích (`register|pin|refresh`), X-Device-Id chữ
   thường, `ts`, `nonce`, ràng buộc. Ràng buộc: register = `store_code\npublic_key`; pin = mã NV đã chuẩn hóa (trim,
   chữ HOA) — chữ ký không dùng lại được cho nhân viên khác; refresh = base64url(SHA-256(refresh_token)). PIN không
   nằm trong thông điệp ký (không cần, và không đưa bí mật vào dữ liệu ký).
3. **Đăng ký** `POST /auth/devices/register` (công khai): X-Device-Id = UUID thiết bị tự sinh một lần ⇒ `pos_devices.id`;
   chữ ký `register` chứng minh giữ khóa riêng (không cần nonce một lần: phát lại chỉ đụng ràng buộc duy nhất id/
   fingerprint ⇒ 409). Trả `pairing_code` = 40 bit đầu SHA-256(khóa công khai), base32 `XXXX-XXXX`, hiển thị trên máy.
   **Chống spam:** tối đa 20 thiết bị PENDING còn hạn mỗi cửa hàng (khóa advisory theo cửa hàng ⇒ gửi song song không
   vượt trần), PENDING quá 7 ngày hết hạn (không kích hoạt được, không hiện, không tính trần). Giới hạn theo IP: lát 5.
4. **Kích hoạt / thu hồi** (`device:write`, `x-scope: store`): người kích hoạt phải nhập đúng `pairing_code` đang hiện
   trên máy ⇒ không kích hoạt nhầm máy lạ chen vào hàng chờ. Có thể gán quầy (`register_id` cùng cửa hàng). Thu hồi
   (PENDING hoặc ACTIVE) kèm lý do: khóa các dòng phiên của thiết bị (`FOR UPDATE`, theo id) TRƯỚC rồi mới cập nhật
   thiết bị — trigger thu hồi mọi phiên cùng transaction; vẫn gặp 40P01/40001 ⇒ thử lại cả transaction tối đa 3 lần
   (`@OwnTransaction`, audit cùng transaction). Thiết bị ngoài phạm vi cửa hàng của người gọi ⇒ 404.
   `last_seen_at` cập nhật trong transaction ngắn của bước ghi nonce (không trong transaction tạo phiên: hai đăng nhập
   song song cùng máy đều giữ `FOR SHARE` thiết bị rồi cùng UPDATE sẽ deadlock).
5. **Phạm vi cửa hàng** (bản tối thiểu `common/store-scope.ts`, lát 6 dựng bộ chung): `ALL` nếu có vai trò/cấp riêng
   phạm vi ALL mang mã quyền, ngược lại tập cửa hàng từ dòng phạm vi STORE.
6. **`/auth/pin`**: thứ tự — bằng chứng thiết bị (thiết bị không có/PENDING ⇒ 403 `DEVICE_NOT_ACTIVATED`; REVOKED ⇒
   403 `DEVICE_REVOKED`; chữ ký/thời điểm/nonce sai ⇒ 401) → tra nhân viên → `AuthAttempts.run` (cơ chế khóa ADR-021
   mục 7, dùng chung: advisory lock theo tài khoản, đếm sai chung, 5 lần ⇒ khóa 15 phút tăng dần). **Cùng một lỗi 401**
   cho sai PIN / mã NV không có / tạm khóa / vô hiệu / đã nghỉ việc / không có vai trò phạm vi ALL hoặc đúng cửa hàng
   của thiết bị (nhánh không có thật chạy Argon2 giả). PIN băm Argon2id hồ sơ PASSWORD (64 MiB). Suất Argon2 theo
   thiết bị (`dev:<id>`, tối đa 3) thay vì theo IP (cả cửa hàng chung một IP NAT). Vai trò được kiểm lại trong
   transaction tạo phiên.
7. **Phiên nhân viên:** `user_type=STAFF`, `pos_device_id`, `amr=[pin]`, hạn **tuyệt đối 24 giờ** (refresh không gia
   hạn). Access token có claim `dev` (chỉ để client). Mọi request bằng token staff phải gửi `X-Device-Id` đúng thiết bị
   của phiên (PrincipalResolver) — chặn token chép sang máy khác dùng ngây thơ; không thay chữ ký thiết bị.
8. **Refresh staff:** bắt buộc `device_proof` (mục đích `refresh`) + X-Device-Id = thiết bị của phiên, kiểm **trước**
   phát hiện dùng lại: refresh token lộ mà không có khóa thiết bị thì vô dụng và không đủ để kẻ gian thu hồi phiên của
   thu ngân. Có chữ ký hợp lệ mà dùng lại token đã xoay ⇒ thu hồi cả phiên như admin (ADR-021 mục 10).
9. **Nhật ký:** `audit.login_logs` thêm kết quả `STORE_NOT_ALLOWED`, `DEVICE_NOT_ACTIVE`, `DEVICE_REVOKED`,
   `DEVICE_PROOF_INVALID`, `DEVICE_NONCE_REUSED`; định danh = HMAC(pepper, `staff:<mã NV>`), không lưu mã NV/PIN rõ.
   `audit.logs`: `pos_device.register|activate|revoke`.
10. **Tách `AuthAttempts`** (`auth/auth-attempts.ts`) khỏi `AuthService` để Master/Viewer và nhân viên dùng đúng một
    cơ chế khóa đã qua 4 vòng kiểm thử lát 3 (không đổi hành vi; `publicLogin` → `publicError`).

## Để lát sau
- Thẻ nhân viên (`staff_badges` chỉ lưu hash — ràng buộc lát 1): route cấp thẻ `/admin/badges` và đổi người bằng thẻ là
  `x-detail-cp: CP09` (định dạng mã thẻ theo `barcode_rules` §21.3.8 chốt ở CP09).
- Đặt/đổi PIN nhân viên, tạo nhân viên: lát 6/8 (`/admin/staff`). Test tạo nhân viên bằng SQL.
- Thiết bị kho (WAREHOUSE): `pos_devices.store_id` bắt buộc ⇒ nhân viên chỉ có phạm vi WAREHOUSE chưa đăng nhập POS
  được; mở khi làm thiết bị kho (CP06/CP07).
- Giới hạn tần suất theo IP cho `/auth/devices/register`, `/auth/pin`: lát 5 (bộ giới hạn Redis chung).
- PIN offline (cache trên máy): CP09 (ADR-012).

## Hệ quả
- Không migration mới. OpenAPI: schema chi tiết cho `/auth/pin`, `/auth/devices/register`, `/admin/pos-devices` (GET có
  `status`), `.../activate`, `.../revoke`; `AuthRefreshRequest.device_proof`; `AuthAmr` thêm `pin`.
- App nhân viên (lát 9) phải: sinh UUID + khóa Ed25519 một lần, lưu Credential Manager/Keystore, hiện `pairing_code`,
  ký mỗi lần `/auth/pin` và `/auth/refresh` với nonce mới, gửi X-Device-Id ở mọi request.
