# ADR-023: Khách đăng nhập SĐT + OTP và giới hạn tần suất Redis (CP03 lát 5)

- Trạng thái: accepted (kỹ thuật) · Ngày: 2026-11-25 · Người quyết: phiên điều phối (CP03 lát 5) — chờ agent
  security-reviewer kiểm
- Làm rõ: ADR-012 (OTP khách 6 số, hạn 5 phút, tối đa 5 lần thử; giới hạn theo SĐT/thiết bị/IP; phiên khách 60 ngày),
  ADR-015 (SĐT mã hóa + HMAC E.164), ADR-021/022 (khóa theo tài khoản, phần hoãn "giới hạn theo IP — lát 5")

## Quyết định
1. **Nhà cung cấp OTP** (`auth/otp-provider.ts`): interface `OtpProvider.send(phone E.164, code)`. Chọn lúc API khởi
   động từ `OTP_PROVIDER`:
   - production: thiếu hoặc `TEST_DOUBLE` ⇒ **không khởi động**. Nhà cung cấp thật (SMS brandname / Zalo ZNS) làm ở
     CP14; `SMS_BRANDNAME` / `ZALO_ZNS` hiện bị từ chối ở mọi môi trường (không âm thầm rơi về giả). Hệ quả: production
     chưa khởi động được cho tới CP14 (đúng KẾ HOẠCH: "production không có provider thật → không khởi động").
   - development/staging/test: `TEST_DOUBLE` có nhãn — không gửi gì ra ngoài, giữ 200 tin gần nhất trong bộ nhớ (test đọc
     mã); development/staging ghi mã vào log cảnh báo có nhãn `[TEST_DOUBLE — KHÔNG GỬI THẬT]` để người thử đăng nhập
     được (staging chỉ dùng SĐT thử). Không đặt ⇒ route OTP trả 503 `CONFIGURATION_NOT_READY`.
2. **SĐT:** chỉ di động Việt Nam, chuẩn hóa E.164 `+84` + 9 số (đầu 3/5/7/8/9); nhận `0…`, `84…`, `+84…`, khoảng
   trắng/chấm/gạch. `phone_hash = HMAC(pepper, "phone:" + E.164)` — dùng cho `users.phone_hash`,
   `otp_challenges.phone_hash` và định danh `login_logs` (tiền tố tách miền với `email:`, `staff:`, `ip:`).
   `users.phone_enc` AES-GCM AAD `users:phone_enc:<id>`.
3. **`POST /auth/otp/request`** (công khai, bắt buộc `X-Device-Id`): không tra tài khoản — phản hồi giống hệt dù SĐT đã
   là khách hay chưa. Giới hạn kiểm-rồi-cộng nguyên tử (Lua) trên **mọi** khóa, Redis lỗi ⇒ 503 (không gửi SMS khi không
   giới hạn được):
   - SĐT: 1 / 60 giây, 5 / giờ, 10 / ngày · thiết bị: 5 / giờ, 20 / ngày · IP: 20 / giờ, 100 / ngày (+ guard 30 / phút)
     · toàn hệ thống: 2000 / giờ (trần chi phí SMS). Vượt ⇒ 429 `OTP_RATE_LIMITED` + `retry_after_s`.
   - Mã 6 số `randomInt` (CSPRNG). Lưu `code_hash = HMAC(pepper, "otp:<id>:<mã>")` (không dò ngược từ DB nếu không có
     pepper; gắn id ⇒ không chép sang dòng khác). Mã mới **xóa** mã chưa dùng của cùng SĐT (lượt nhập không cộng dồn qua
     nhiều mã) và dọn dòng > 1 ngày của SĐT. Hạn theo đồng hồ DB (`now() + 5 phút`, CHECK `otp_ttl`).
   - Ghi mã (commit) TRƯỚC rồi mới gọi nhà cung cấp (không giữ transaction khi gửi); gửi lỗi ⇒ 503
     `DEPENDENCY_UNAVAILABLE`. `login_logs` `OTP_SENT` (bị chặn bởi giới hạn nên có trần).
4. **`POST /auth/otp/verify`**: trước transaction kiểm "nhập sai theo SĐT" (10 / giờ, cộng dồn qua mọi mã; chỉ kiểm)
   và cộng "xác minh theo thiết bị" (30 / 10 phút). Một lần thử = một transaction (`@OwnTransaction`):
   `pg_advisory_xact_lock` theo SĐT (nhập song song tuần tự; tạo tài khoản không đua) → mã mới nhất còn hạn, chưa dùng,
   `attempts < 5` (`FOR UPDATE`) → `attempts + 1` (commit dù sai) → so sánh hằng thời gian → đúng thì `consumed_at`.
   Sai / không có mã / hết hạn / đã dùng / hết lượt ⇒ **cùng 401 `OTP_INVALID`**, cộng bộ đếm sai theo SĐT,
   `login_logs` `BAD_OTP`. Đúng lần đầu ⇒ tạo `users` (CUSTOMER, phone_enc/hash) + vai trò `CUSTOMER` phạm vi ALL +
   audit `customer.register`. SĐT thuộc tài khoản không phải khách, hoặc khách không ACTIVE ⇒ 403 `ACTION_FORBIDDEN`
   (chỉ lộ cho người đã chứng minh giữ SĐT). Request bị 429 **không** ghi `login_logs` (không tạo log vô hạn).
5. **Phiên khách:** `user_type=CUSTOMER`, `amr=[otp]`, hạn **60 ngày tuyệt đối** tính bằng đồng hồ DB; refresh xoay vòng
   + phát hiện dùng lại như admin nhưng **không gia hạn** — CHECK `sessions_times` (lát 1) chặn phiên quá 60 ngày kể từ
   `created_at`, khớp ADR-012 "khách 60 ngày". Hết hạn ⇒ khách xin OTP mới. Token khách không gắn thiết bị (bảng phiên
   không có cột thiết bị cho khách — ghi nhận, CP14 xem lại nếu cần).
6. **Giới hạn theo nguồn cho route xác thực** (`common/rate-limit.ts`, guard toàn cục `@RateLimit(tên)`, chạy TRƯỚC
   xác thực/transaction ⇒ request vượt ngưỡng không chạm DB, không ghi `login_logs` — đóng L6 lát 4):
   login 30 / phút + 300 / giờ / IP; 2fa verify/recover, step-up 30 / phút / IP; PIN 120 / phút / IP (cả cửa hàng chung
   NAT) + 30 / phút / thiết bị; đăng ký thiết bị 10 / giờ / IP + 5 / giờ / thiết bị; refresh 300 / phút / IP; OTP
   request 30 / phút, verify 60 / phút / IP. IPv6 gộp theo **/64** (đóng T5 lát 3: xoay địa chỉ trong mạng con không né
   được). Redis lỗi ⇒ các route này **cho qua** (khóa theo tài khoản trong DB vẫn chặn — SEC5) + cảnh báo có giới hạn.
   Ngưỡng theo IP để rộng (CGNAT di động, NAT cửa hàng); lớp chặn chính vẫn là khóa tài khoản và giới hạn theo SĐT.
7. **Khóa Redis:** `rl:<tên>:<cửa sổ>:<SHA-256(định danh) 32 ký tự>` — không lưu SĐT/IP rõ; cửa sổ cố định (INCR +
   EXPIRE ở lần đầu). Chính sách nằm ở provider `RATE_POLICIES` — chỉ test lát 3/4 thay bằng ngưỡng nới (không có biến môi
   trường nào tắt giới hạn).

## Để lát sau
- Nhà cung cấp OTP thật, mẫu tin, đồng ý điều khoản (U02), hồ sơ `customers`: CP14.
- Job dọn `otp_challenges` hết hạn toàn bảng: lát 7 (worker) — hiện mỗi SĐT tự dọn dòng cũ khi xin mã mới.
- Đếm/biểu đồ số request bị 429 (thay cho log từng dòng): giám sát CP02/CP19.
- Redis ACL theo user: lát 10 (ADR-019).

## Hệ quả
- Không migration. Env mới: `OTP_PROVIDER` (`TEST_DOUBLE|SMS_BRANDNAME|ZALO_ZNS`), `OTP_API_KEY`, `OTP_SENDER`
  (§19.4). OpenAPI: `AuthOtpRequest/Response`, `AuthOtpVerifyRequest/Response` thay `PendingBody`.
- `login_logs` thêm kết quả `OTP_SENT`, `BAD_OTP`.
