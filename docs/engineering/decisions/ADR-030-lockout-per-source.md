# ADR-030: Khóa đăng nhập theo (tài khoản, nguồn); xác thực lại đếm theo phiên

- Trạng thái: accepted (kỹ thuật) — review cổng CP03: security SẠCH lần 5, code SẠCH lần 4 · Ngày: 2026-11-27 · Người quyết: **Tiến** (chọn phương án "khóa theo tài
  khoản + mạng", 2026-11-27) · Sửa theo review an ninh cổng CP03 (TB-1)
- Làm rõ / thay thế một phần: ADR-012, ADR-021 (SEC5: khóa sau 5 lần sai, tăng dần), ADR-022 (PIN)

## Bối cảnh

SEC5 cũ đếm sai trên `core.users`, dùng chung cho mọi luồng. Kẻ ẩn danh biết email Master gửi 5 mật khẩu sai mỗi ngày là
giữ Master bị khóa vô thời hạn, vì mức khóa không bao giờ giảm. Trong lúc khóa, `/auth/step-up` của Master đang đăng nhập
cũng bị chặn, nên mọi thao tác quản trị cần step-up tê liệt. Route `unlock` chỉ gỡ được trạng thái LOCKED, không gỡ được khóa
tạm.

## Quyết định

1. **Khóa theo cặp (tài khoản, nguồn)**, lưu ở bảng `core.auth_lockouts` (migration 0008). Nguồn là:
   - `ip:<sha256(bucket)>` cho `/auth/login`, `/auth/2fa/verify` và `/auth/2fa/recover`. Bucket là IPv4 nguyên địa chỉ, IPv6
     gộp theo /48 (sửa lần 2; ADR-023 dùng /64 cho giới hạn tần suất). Bảng không lưu IP thô.
   - `dev:<uuid>` cho `/auth/pin`: khóa theo (nhân viên, máy POS).

   Luật khóa:
   - 5 lần sai liên tiếp từ một nguồn thì khóa nguồn đó 15 phút. Mỗi lần khóa sau gấp đôi, trần 24 giờ.
   - Nguồn không có lần sai nào trong 24 giờ thì bộ đếm và mức khóa về 0.
   - Đăng nhập trọn vẹn từ một nguồn thì xóa dòng khóa của nguồn đó.

   Kết quả: kẻ ẩn danh chỉ khóa được chính nguồn của mình, người dùng thật ở mạng hoặc máy khác vẫn vào được. Brute-force
   vẫn bị chặn: mỗi nguồn chỉ thử được 5 lần cho mỗi đợt khóa, và mức khóa tăng dần.

2. **Tấn công phân tán:** từ 10 nguồn trở lên cùng đang bị khóa thì khóa toàn tài khoản 1 giờ (`users.locked_until`) và ghi
   log `LOCKED_GLOBAL`.
3. **Xác thực lại trong phiên đã đăng nhập** (step-up, mật khẩu hiện tại khi đổi mật khẩu) đếm theo phiên, ở cột
   `sessions.reauth_failed_count`.
   - Sai 5 lần thì thu hồi phiên đó (`REAUTH_FAILED`, log `REAUTH_REVOKED`).
   - Khóa đăng nhập, cả theo nguồn lẫn toàn tài khoản, **không** chặn luồng này. Trạng thái LOCKED/DISABLED do Master đặt
     vẫn chặn.
4. **Mở khóa:** `POST /admin/users/{id}/unlock` (Master, step-up) giờ mở được cả tài khoản LOCKED lẫn tài khoản ACTIVE đang bị
   khóa tạm; khóa tạm theo nguồn và toàn tài khoản đều bị xóa. Đặt lại PIN cũng xóa khóa tạm. Không có khóa nào thì trả 409.
5. Các cột `users.failed_login_count` và `users.lock_count` không còn dùng để đếm. Hai cột vẫn giữ (mở khóa sẽ đặt về 0) và
   sẽ bỏ ở một migration dọn dẹp sau.

## Sửa theo review cổng lần 2 (NC-25 — Tiến duyệt 2026-11-27)

- **TB-3 (dò mật khẩu/TOTP bằng xoay mạng):** trước đây kẻ tấn công giữ < 10 nguồn bị khóa cùng lúc thì thử được ~4.300 lần
  mỗi ngày. Sửa:
  - Bước 2FA (`/2fa/verify`, `/2fa/recover`) đếm theo **tài khoản** (nguồn `mfa`, khóa tăng dần như trên). Chỉ người biết
    mật khẩu mới tới được bước này, nên không thành bề mặt DoS ẩn danh. Lần đúng mật khẩu sau đó vẫn hoàn tất 2FA được bằng
    challenge đã nhận.
  - Ngân sách theo tài khoản: ≥ 50 lần sai trong 24 giờ (mọi nguồn cộng lại) thì khóa toàn tài khoản tới hết cửa sổ, log
    `LOCKED_GLOBAL` (cột `users.fail_window_count/start`, migration 0008).
  - Nguồn IP gộp IPv6 theo **/48**: một VPS có /48 chỉ tính là một nguồn.
- **TB-B (khóa toàn tài khoản bằng một /48):** trình duyệt/app **quen** dùng nguồn riêng `cli:<sha256>` và **không** bị khóa
  toàn tài khoản. Quen nghĩa là `X-Device-Id` khớp `client_device` của một phiên đã qua 2FA; admin-web dùng cookie HttpOnly
  `__Host-fa_dev`, kẻ tấn công không biết giá trị này. Master quen máy vẫn vào được khi đang bị tấn công. Trình duyệt **mới**
  của Master thì có thể bị chặn tới khi Master khác gỡ (rủi ro chấp nhận).
- **TB-A (tranh khóa `auth:<id>`):** lần thử lấy khóa `auth:<id>` dạng **chia sẻ**, cộng khóa **độc quyền** theo (tài khoản,
  nguồn | phiên). Thao tác quản trị (đổi PIN, khóa, mở khóa, reset 2FA) vẫn lấy khóa độc quyền `auth:<id>`, nên chờ hết các
  lần thử đang chạy. Lần thử của nguồn A đang bận không còn chặn nguồn B hay step-up của phiên đang mở.
- **Thấp:** 24 giờ yên lặng để reset mức khóa giờ tính từ `GREATEST(updated_at, locked_until)`, nên khóa trần 24 giờ không
  tự reset ngay khi hết.

## Sửa theo review cổng lần 3

- TB-1: khóa bước 2FA theo tài khoản (nguồn `mfa`) từng chặn cả trình duyệt quen — kẻ có mật khẩu lộ nhập sai mã 5 lần là
  Master không vào được dù dùng máy quen. Sửa: trình duyệt quen đếm bước 2FA trên nguồn `cli:` của chính nó
  (`mfaScope()`); chỉ trình duyệt lạ đếm chung nguồn `mfa`. Có test.
- Thấp: `verifyMfa` xóa khóa (`auth_lockouts`) TRƯỚC khi cập nhật `users` — cùng thứ tự khóa với nhánh sai, tránh 40P01.
- Security lần 3 TB-4 (ngân sách 50 lần thành bề mặt DoS):
  - Máy POS **quen** (nhân viên đã đăng nhập PIN thành công trên máy đó) không bị khóa toàn tài khoản — thu ngân đứng ở máy
    khác không khóa được cửa hàng trưởng trên máy của chính họ (`pinScope()`).
  - Tài khoản **chưa kích hoạt** (mật khẩu tạm 120 bit, chưa 2FA) không bị khóa toàn tài khoản — kẻ biết email không chặn
    được việc kích hoạt bằng trình duyệt mới; khóa theo nguồn vẫn áp.
  - Master gỡ khóa ⇒ ngân sách đếm lại từ 0 (kẻ tấn công phải làm đầy lại nhiều giờ).
- Security lần 3 T-5: "quen" chỉ tính phiên trong 90 ngày, KHÔNG tính phiên bị thu hồi vì lý do an ninh (ADMIN_REVOKED,
  REFRESH_REUSE, TWO_FACTOR_RESET, PASSWORD_CHANGED, REAUTH_FAILED, PIN_RESET, DEVICE_REVOKED, USER_LOCKED, USER_REVOKED);
  log pino che `X-Device-Id`.
- Ghi nhận (chấp nhận): `sessions.client_device` / `login_logs.device` lưu định danh trình duyệt dạng rõ. Chỉ role DB của ứng
  dụng đọc được; người đọc được DB đã vượt xa rủi ro này. Băm khi làm dọn dẹp (cùng lúc bỏ `users.failed_login_count`).

## Sửa theo review cổng lần 4
- T-7 (cả security lẫn code): sự kiện an ninh không xóa "quen" của phiên cũ đã đăng xuất / hết hạn. Sửa: cột
  `users.trust_epoch` — đặt `now()` khi reset 2FA, đổi mật khẩu, đặt lại PIN, Master khóa / tắt nhân viên, refresh bị dùng
  lại; "quen" chỉ tính phiên tạo sau `max(90 ngày trước, trust_epoch)`. Thêm `USER_DISABLED` vào lý do thu hồi không tin.
- **Rủi ro còn lại (chấp nhận, ghi cho CP10):**
  - Máy POS là nguồn dùng chung: người trong nội bộ đứng đúng các máy cửa hàng trưởng hay dùng vẫn giữ được khóa theo máy
    (mỗi máy 5 lần/đợt, tăng dần tới 24 giờ). `login_logs` ghi máy; Master gỡ được.
  - Dò PIN trên máy quen không chịu ngân sách toàn tài khoản: trần ~35 lần/ngày × số máy (không gian 10⁶ ⇒ ~3–4%/năm với 3
    máy; cao hơn nếu PIN dễ đoán). CP10 thêm cảnh báo BAD_CREDENTIALS dồn dập theo nhân viên và `LOCKED_GLOBAL`.

## Kiểm thử security lần 5 (bfaa2cd): SẠCH
- Ghi nhận (không chặn): thu hồi MỘT phiên (ADMIN_REVOKED, REAUTH_FAILED) không đặt mốc — trình duyệt còn phiên cũ khác vẫn
  "quen" (chỉ miễn khóa toàn tài khoản; khóa theo nguồn vẫn chặn dò). Đổi mật khẩu làm trình duyệt hiện tại hết "quen" tới
  lần đăng nhập trọn vẹn kế tiếp (chỉ trải nghiệm). Làm chặt khi đụng lại.

## Hệ quả

- Test:
  - `auth.test.ts`: khóa theo nguồn; mạng khác vẫn vào; phiên đang mở vẫn step-up; IPv6 cùng /48 là một nguồn; tăng dần
    rồi tự giảm sau 24 giờ; 10 nguồn thì khóa toàn tài khoản; step-up sai 5 lần thì thu hồi phiên.
  - `pos-auth.test.ts`: máy khác vẫn đăng nhập PIN được.
  - `admin-accounts.test.ts`: Master gỡ được khóa tạm.
- Phụ thuộc IP thật: trên staging, client IPv6 phải đến API với IP thật (review cổng CP03 TB-2). Xem
  `runbook-deploy.md` mục IPv6. Nếu không, mọi client IPv6 chung một nguồn.
- Rủi ro còn lại (chấp nhận): botnet từ 10 mạng trở lên vẫn khóa được toàn tài khoản, mỗi lần 1 giờ. Master khác gỡ được
  ngay, và log `LOCKED_GLOBAL` dùng làm tín hiệu cảnh báo (cảnh báo tự động ở CP10).
