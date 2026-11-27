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
3. **Đăng ký** `POST /auth/devices/register` (công khai; từ sửa M1 bắt buộc mã ghi danh thay mã cửa hàng — xem mục
   "Sửa theo kiểm thử agent lần 1"): X-Device-Id = UUID thiết bị tự sinh một lần ⇒ `pos_devices.id`;
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

## Sửa theo kiểm thử agent lần 1 (0fa1428)
- **M1 (Trung bình) — Tiến chọn "Thêm mã ghi danh" (2026-11-25, NC-20):** route đăng ký công khai + trần 20
  PENDING/cửa hàng ⇒ ai biết mã cửa hàng cũng lấp đầy hàng chờ; cửa hàng không có trả 400 ⇒ dò được mã cửa hàng. Sửa:
  - `POST /admin/pos-devices/enrollment-codes` (`device:write`, `x-scope: store`, ngoài §13.2 — NC-20): tạo mã cho một
    cửa hàng trong phạm vi (ngoài phạm vi / không có ⇒ 404; cửa hàng ngừng ⇒ 409). Mã 60 bit ngẫu nhiên (12 ký tự
    base32 `XXXX-XXXX-XXXX`), **dùng một lần, hạn 30 phút**, trả rõ đúng một lần; DB lưu SHA-256 (`pos-enroll:` + dạng
    chuẩn), audit chỉ có id + hạn. Tối đa 10 mã còn dùng được mỗi cửa hàng (khóa advisory theo cửa hàng ⇒ 429). Không
    nhận Idempotency-Key (response chứa bí mật — khi làm bộ idempotency phải loại route này khỏi lưu response).
  - `/auth/devices/register` nhận `enrollment_code` thay `store_code` (cửa hàng lấy từ mã). Ràng buộc chữ ký `register`
    = mã dạng chuẩn + `\n` + public_key. Thứ tự: kiểm chữ ký (không đụng DB) → `SELECT … FOR UPDATE` dòng mã (song song
    cùng mã ⇒ máy sau thấy đã dùng) → trần PENDING → tạo thiết bị → đánh dấu mã đã dùng, cùng transaction (lỗi 409 ⇒
    rollback, mã không bị tiêu). Mã sai / đã dùng / hết hạn / cửa hàng ngừng ⇒ **cùng một 401** — không còn dò được
    mã cửa hàng. Phát lại nguyên request sau khi thành công ⇒ 401 (mã đã dùng).
  - Migration `0003_pos_enrollment_codes`: bảng `core.pos_enrollment_codes`; CHECK hash 32 byte, hạn ≤ 1 giờ, cặp
    `used_at`/`used_by_device_id`; trigger đặt `created_at`/`used_at` bằng `now()`, cấm sửa mã đã dùng, cấm dùng mã hết
    hạn, thiết bị dùng mã phải PENDING cùng cửa hàng. `app_rw`: SELECT/INSERT + UPDATE (`used_at`, `used_by_device_id`),
    không DELETE.
  - Vẫn giữ trần 20 PENDING/cửa hàng và bước kích hoạt bằng mã ghép đôi (ADR-012: kích hoạt là thao tác riêng của người
    quản trị — mã ghi danh lộ trong 30 phút chỉ cho máy lạ vào hàng chờ, không cho đăng nhập).
- L1: tạo phiên thua cuộc đua với thu hồi ⇒ 403 `DEVICE_REVOKED` + login_logs (trước: 400 không log); 23514 ở bước
  nonce chỉ báo `DEVICE_REVOKED` khi thiết bị thật sự không còn ACTIVE.
- L2: nhân viên nghỉ việc (`left_at` tới) ⇒ phiên hết hiệu lực ngay (PrincipalResolver); refresh staff kiểm lại nghỉ
  việc + vai trò ở cửa hàng của thiết bị.
- L3: mã ghép đôi 50 bit (`XXXXX-XXXXX`), từ chối đăng ký trùng mã với máy đang chờ cùng cửa hàng; API danh sách không
  trả mã ghép đôi (người kích hoạt phải đọc từ máy).
- L4: danh sách không bao giờ hiện PENDING hết hạn; mặc định ẩn REVOKED.
- L5: `revoked_sessions` đếm sau khi cập nhật thiết bị (gồm phiên vừa tạo song song bị trigger thu hồi).
- Nonce phải ở dạng base64url chuẩn (một giá trị byte chỉ có một cách viết).
- L6 (log không giới hạn từ request chưa xác thực): vào bộ giới hạn tần suất lát 5. Ghi nhận: chưa có bộ đếm sai PIN
  theo thiết bị (dò PIN phổ biến rải nhiều nhân viên) và chưa chặn PIN yếu — lát 5 / lát 6–8 (đặt PIN).

## Kiểm thử agent lần 2 (46b4507): SẠCH
Không lỗi Cao/Trung bình/Thấp bắt buộc. Ghi nhận không bắt buộc, làm ở lát sau:
- Trần mã ghi danh đếm theo đồng hồ app (lệch vài giây, không hệ quả bảo mật) — đổi sang `now()` DB khi tiện.
- Trigger `pos_enrollment_code_guard` chưa cố định `store_id`/`code_hash`/`expires_at`/`created_at` khi UPDATE (hiện chỉ
  quyền cột chặn) — thêm lớp phòng thủ ở migration sau.
- Đăng ký sai mã không để vết — lát 5 (rate limit + log có giới hạn).
- OpenAPI `.../activate`, `.../revoke` thiếu `x-scope: store` (code đã kiểm phạm vi) — sửa tài liệu hợp đồng.
- `activate` và `/auth/pin` chưa kiểm cửa hàng còn hoạt động — lát 6 (vòng đời cửa hàng).
- `Cache-Control: no-store` cho response tạo mã ghi danh — lát 5 cùng chính sách header.
- PrincipalResolver không kiểm lại vai trò mỗi request (tối đa một access token 15 phút sau khi mất vai trò) — lát 6.

## Để lát sau
- Thẻ nhân viên (`staff_badges` chỉ lưu hash — ràng buộc lát 1): route cấp thẻ `/admin/badges` và đổi người bằng thẻ là
  `x-detail-cp: CP09` (định dạng mã thẻ theo `barcode_rules` §21.3.8 chốt ở CP09).
- Đặt/đổi PIN nhân viên, tạo nhân viên: lát 6/8 (`/admin/staff`). Test tạo nhân viên bằng SQL.
- Thiết bị kho (WAREHOUSE): `pos_devices.store_id` bắt buộc ⇒ nhân viên chỉ có phạm vi WAREHOUSE chưa đăng nhập POS
  được; mở khi làm thiết bị kho (CP06/CP07).
- Giới hạn tần suất theo IP cho `/auth/devices/register`, `/auth/pin`: lát 5 (bộ giới hạn Redis chung).
- PIN offline (cache trên máy): CP09 (ADR-012).

## Hệ quả
- Migration `0003_pos_enrollment_codes` (sửa M1). OpenAPI: schema chi tiết cho `/auth/pin`, `/auth/devices/register`
  (`enrollment_code`), `/admin/pos-devices` (GET có `status`), `.../enrollment-codes`, `.../activate`, `.../revoke`;
  `AuthRefreshRequest.device_proof`; `AuthAmr` thêm `pin`.
- App nhân viên (lát 9) phải: sinh UUID + khóa Ed25519 một lần, lưu Credential Manager/Keystore, hỏi mã ghi danh lúc
  đăng ký, hiện `pairing_code`, ký mỗi lần `/auth/pin` và `/auth/refresh` với nonce mới, gửi X-Device-Id ở mọi request.
  Màn quản trị (lát 6–8) có nút "Tạo mã ghi danh" hiển thị mã một lần.
