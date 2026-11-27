# ADR-030: Khóa đăng nhập theo (tài khoản, nguồn); xác thực lại đếm theo phiên

- Trạng thái: proposed (chờ kiểm thử agent) · Ngày: 2026-11-27 · Người quyết: **Tiến** (chọn phương án "khóa theo tài
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
     gộp theo /64, giống ADR-023. Bảng không lưu IP thô.
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

## Hệ quả
- Test:
  - `auth.test.ts`: khóa theo nguồn; mạng khác vẫn vào; phiên đang mở vẫn step-up; IPv6 cùng /64 là một nguồn; tăng dần
    rồi tự giảm sau 24 giờ; 10 nguồn thì khóa toàn tài khoản; step-up sai 5 lần thì thu hồi phiên.
  - `pos-auth.test.ts`: máy khác vẫn đăng nhập PIN được.
  - `admin-accounts.test.ts`: Master gỡ được khóa tạm.
- Phụ thuộc IP thật: trên staging, client IPv6 phải đến API với IP thật (review cổng CP03 TB-2). Xem
  `runbook-deploy.md` mục IPv6. Nếu không, mọi client IPv6 chung một nguồn.
- Rủi ro còn lại (chấp nhận): botnet từ 10 mạng trở lên vẫn khóa được toàn tài khoản, mỗi lần 1 giờ. Master khác gỡ được
  ngay, và log `LOCKED_GLOBAL` dùng làm tín hiệu cảnh báo (cảnh báo tự động ở CP10).
