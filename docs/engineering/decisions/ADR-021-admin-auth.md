# ADR-021: Xác thực Master/Viewer — cách hiện thực ADR-012 (CP03 lát 3)

- Trạng thái: accepted (kỹ thuật) · Ngày: 2026-11-25 · Người quyết: phiên điều phối (CP03 lát 3) — chờ agent
  security-reviewer kiểm
- Làm rõ: ADR-012 (token, 2FA, step-up, khóa), ADR-015 (mã hóa secret), ADR-011 (audit_writer), ADR-016 (transaction)

## Bối cảnh
ADR-012 chốt chính sách (JWT EdDSA 15 phút, refresh xoay vòng theo họ, TOTP + 10 mã khôi phục, step-up 5 phút, khóa
sau 5 lần sai). Khi hiện thực cần chốt thêm các điểm ADR-012 để ngỏ hoặc mâu thuẫn với khung lát 2.

## Quyết định
1. **Thư viện:** Argon2id dùng `node:crypto.argon2` có sẵn trong Node 24 (không cần gói native, không lỗi build trên
   Alpine). TOTP: `otplib` 13.6.0 (SPEC §19.2). JWT: `jose` 6.2.16. Tất cả ghim bản chính xác (versions.json).
2. **Tham số Argon2id:** mật khẩu m = 64 MiB, t = 3, p = 1 (≈ 100 ms); mã khôi phục (80 bit ngẫu nhiên) m = 19 MiB,
   t = 2 — kiểm 10 mã ≈ 0,3 s. Lưu chuỗi PHC; tham số trong DB bị sửa vô lý ⇒ coi như sai (không treo CPU).
3. **Khóa (env, thiếu/sai ⇒ API không khởi động):** `JWT_SIGNING_KEYS = kid:base64(PKCS#8 Ed25519),…` — khóa CUỐI ký,
   mọi khóa kiểm; xoay: thêm khóa mới ở cuối, đợi ≥ 15 phút, bỏ khóa cũ. `PII_ENC_KEYS = id:base64(32 byte),…` — ghi bằng
   id lớn nhất. `PII_HASH_PEPPER` base64 ≥ 32 byte. Thay cho `JWT_ACCESS_SECRET/JWT_REFRESH_SECRET` của SPEC §19.4
   (refresh token là chuỗi ngẫu nhiên lưu SHA-256, không cần khóa ký; ADR-012 đã chọn EdDSA).
4. **Access token:** header `alg=EdDSA, typ=at+jwt, kid`; claim `iss=fruit-api, aud=fruit, sub, sid, typ, amr,
   step_up_until?, iat, exp, jti`. Server chỉ tin `sub`/`sid` sau khi kiểm chữ ký; mọi trạng thái (phiên còn hiệu lực,
   người dùng ACTIVE, amr, step-up, quyền) đọc lại từ DB mỗi request ⇒ thu hồi/khóa có hiệu lực ngay.
5. **Đăng ký 2FA lần đầu** (setup/confirm khóa dòng user `FOR UPDATE`, setup ghi secret có điều kiện chưa bật — S2;
   confirm thu hồi các phiên chỉ-mật-khẩu khác của user): tài khoản chưa bật TOTP đăng nhập bằng mật khẩu ⇒ phiên `amr=[pwd]` chỉ gọi được route
   `@AllowWithoutMfa` (setup, confirm, logout); route khác ⇒ 403 `TWO_FACTOR_ENROLLMENT_REQUIRED`. Confirm xong ⇒ phiên
   đó thành `amr=[pwd,otp]`. Đã bật TOTP thì mật khẩu đúng chỉ ra `mfa_challenge` (5 phút, 1 lần, ≤ 5 lần thử).
   Setup lại khi đã bật ⇒ 409 (đăng ký lại qua Master reset — lát 6/8).
6. **Chống dùng lại TOTP:** cột `users.totp_last_step` (migration 0002); mã cùng bước 30 s hoặc cũ hơn bị từ chối, cập
   nhật có điều kiện (`< step`) nên hai request song song cùng mã chỉ một cái qua. Dung sai ±1 bước.
7. **Khóa tạm (SEC5):** bộ đếm `failed_login_count` cộng chung cho mật khẩu sai, TOTP sai (verify, step-up) và mã khôi
   phục sai. **Giữ chỗ trước khi kiểm** (kiểm thử agent lần 1, S1): mỗi lần thử trước hết `UPDATE … SET failed_login_count
   + 1 WHERE status=ACTIVE AND không khóa AND failed_login_count < 5` (nguyên tử); 0 dòng ⇒ từ chối, không kiểm thật. Lần
   sai giữ chỗ, đủ 5 ⇒ `locked_until = now + 15 phút × 2^lock_count` (trần 24 giờ), bộ đếm về 0 — một đợt song song chỉ
   thử được ≤ 5 lần và chỉ tăng `lock_count` một lần. Lần đúng chốt trong transaction thành công, chỉ khi tài khoản vẫn
   ACTIVE và không bị khóa trong lúc kiểm: mật khẩu đúng (đã bật 2FA) chỉ trả lại chỗ, KHÔNG xóa các lần sai trước; đăng
   nhập trọn vẹn (qua 2FA) xóa cả bộ đếm và mức khóa. `/auth/login` trả CÙNG lỗi 401 cho sai email / sai mật khẩu / đang
   khóa / bị Master khóa / vô hiệu (S3 — không liệt kê email qua trạng thái khóa; nhánh từ chối vẫn chạy Argon2 giả);
   `2fa/verify`, `2fa/recover`, `step-up` (đã qua mật khẩu/phiên) trả 403 `ACCOUNT_LOCKED` kèm `retry_after_s`. Khóa tạm
   không giết phiên đang có (tránh kẻ xấu khóa Master đang làm việc); Master khóa tài khoản (`status=LOCKED`) thì phiên
   mất hiệu lực ngay. Tối đa 2 Argon2 chạy cùng lúc, hàng đợi 64, đầy ⇒ 429 (S6).
8. **Lần sai phải được lưu dù request trả lỗi:** route `@OwnTransaction(lý do)` (login, 2fa/verify, 2fa/recover,
   refresh, step-up) — MutationInterceptor không bọc; handler ghi lần sai trong transaction riêng đã commit rồi mới ném
   lỗi; phần thành công là một transaction. login_logs của lần sai ghi SAU khi commit bộ đếm (S4). Không lồng transaction (tránh giữ 2 kết nối/request khi bị dò).
9. **Nhật ký đăng nhập:** mọi lần thử ghi `audit.login_logs` bằng pool `audit_writer` riêng (`DATABASE_URL_AUDIT`, bắt
   buộc với API) — còn lại dù nghiệp vụ rollback; lần thành công ghi trước khi commit (ghi lỗi ⇒ không ra phiên). Định
   danh = HMAC(pepper, `email:<chuẩn hóa>`), không lưu email rõ. Thao tác đổi trạng thái (setup/enable 2FA, sinh lại mã,
   step-up, logout, thu hồi phiên, dùng mã khôi phục, phát hiện dùng lại refresh) ghi `audit.logs`.
10. **Refresh:** khóa dòng phiên trước (UPDATE có điều kiện chưa thu hồi/chưa hết hạn), tạo token mới, xoay token cũ
    có điều kiện `used_at IS NULL`. 0 dòng (bị dùng song song) hoặc token đã xoay ⇒ thu hồi cả phiên
    (`REFRESH_REUSE`) + audit — kể cả hai request hợp lệ trùng nhau: BFF phải tuần tự hóa refresh. Hạn admin 12 giờ
    trượt, **trần tuyệt đối 7 ngày** kể từ đăng nhập (ADR-012 không nêu trần).
11. **Thiết bị mới (SEC5):** sự kiện `auth.new_device_login {user_id, session_id, at}` khi X-Device-Id chưa từng có
    phiên đã qua 2FA (hoặc không gửi X-Device-Id); tính cả lần kích hoạt 2FA. Không đưa IP/User-Agent vào sự kiện.
12. **Tài khoản Master đầu tiên:** lệnh `node dist/cli/create-master.js --email …` (role app_rw) tạo user + vai trò
    MASTER_ADMIN + audit, in mật khẩu tạm 120 bit MỘT lần ra terminal; lần đăng nhập đầu bắt buộc đăng ký 2FA.

13. Mọi response API có `Cache-Control: no-store`, `Pragma: no-cache` (S5). `@RequireStepUp`/`@AllowWithoutMfa`/
    `@OwnTransaction` đặt ở class ⇒ không khởi động (S7).

## Để lát sau
- Giới hạn tần suất theo IP cho `/auth/login`, `/auth/2fa/*` (Redis) — lát 5 dựng bộ giới hạn chung, áp luôn cho các
  route này. Hiện chỉ có khóa theo tài khoản.
- Đổi mật khẩu, Master reset 2FA / khóa / mở khóa / thu hồi phiên người khác, viewer chỉ gọi `/auth/*` + `/viewer/*`:
  lát 6 (RBAC) và lát 8 (admin web).
- Refresh của staff (chữ ký thiết bị) và khách: lát 4, lát 5.

## Hệ quả
- Migration `0002_auth_totp_replay`; OpenAPI có schema chi tiết cho mọi route `/auth/*` của Master/Viewer; sự kiện
  `auth.new_device_login` đổi `device_id` → `session_id`.
- `infra/.env` local phải thêm `JWT_SIGNING_KEYS`, `PII_ENC_KEYS`, `PII_HASH_PEPPER` (cách tạo trong `.env.example`),
  nếu thiếu thì compose không khởi động API.
