# ADR-027: Trang quản lý Next.js qua BFF — cookie HttpOnly, CSRF, CSP nonce (CP03 lát 8b)

- Trạng thái: proposed (chờ kiểm thử agent) · Ngày: 2026-11-27 · Người quyết: phiên điều phối (CP03 lát 8b)
- Làm rõ: ADR-012 (token, BFF), ADR-019 (Caddy), ADR-021/026 (đăng nhập Master, NC-22), SEC1–SEC5

## Quyết định
1. **Token không bao giờ tới JS.** Route handler Next (`/bff/*`) giữ access, refresh và mfa_challenge trong cookie
   `__Host-fa_at`, `__Host-fa_rt` và `__Host-fa_mfa`. Thuộc tính: HttpOnly, Secure, SameSite=Strict, Path=/, không Domain.
   Mọi body trả về trình duyệt đều đã bỏ `access_token`, `refresh_token` và `mfa_challenge` (`stripTokens`).
   Thời hạn cookie:
   - access: 15 phút trừ 30 giây, để BFF làm mới trước khi API trả 401;
   - refresh: 12 giờ (API mới quyết định hạn thật: trượt 12 giờ, trần 7 ngày);
   - mfa: 5 phút.
2. **CSRF.**
   - Mọi request ghi kiểm `Origin` đúng `ADMIN_ORIGIN`. Đây là biến môi trường, không suy ra từ Host hay X-Forwarded-*. Nếu
     trình duyệt không gửi Origin thì `Sec-Fetch-Site` phải là same-origin. Thiếu cả hai thì từ chối.
   - Request ghi cũng phải có header `X-CSRF-Token` trùng cookie `__Host-fa_csrf`. Cookie này đọc được bằng JS, được cấp
     mới mỗi lần có phiên, và được so sánh bằng phép so hằng thời gian.
   - Đăng nhập (bước 1 và 2) chưa có cookie CSRF, nên chỉ kiểm Origin (chống login CSRF), cộng SameSite=Strict.
   - Request GET từ trang khác (`Sec-Fetch-Site` khác same-origin) trả 403.
3. **Cổng API theo danh sách trắng.** `/bff/api/<đường dẫn>` chỉ chuyển các đường sau:
   - `/auth/{2fa/setup, 2fa/confirm, 2fa/recovery-codes, step-up, password}` (POST);
   - `/auth/sessions` (GET) và `/auth/sessions/{uuid}` (DELETE);
   - `/admin/**`;
   - `/viewer/**` (GET) và `/viewer/notifications/{uuid}/read`.

   Quy tắc khác:
   - Từng đoạn đường dẫn sau khi giải mã phải khớp `[A-Za-z0-9_~-][A-Za-z0-9._~-]*`, nên không có `..`, `/` mã hóa, hay
     route POS, khách, webhook.
   - Body là JSON, tối đa 256 KB. Query tối đa 2048 ký tự.
   - Header chuyển tiếp chỉ gồm User-Agent, X-Forwarded-For (do Caddy đặt), X-Request-Id (Caddy đặt, kiểm định dạng) và
     Idempotency-Key. Không chuyển Cookie hay Authorization của trình duyệt.
4. **Làm mới token một lần duy nhất (single-flight).** Refresh token chỉ dùng được một lần; dùng lại thì cả phiên bị thu
   hồi (SEC4). Khi access vừa hết hạn, trình duyệt bắn song song nhiều request mang cùng refresh cookie.
   - BFF gộp các lần refresh theo token trong bộ nhớ tiến trình (`globalThis`, dùng chung cho proxy.ts và route handler). Kết
     quả được dùng lại trong 60 giây.
   - Lỗi tạm (429/5xx) không giữ trong bộ đệm và không đăng xuất. API từ chối hẳn (400/401/403) thì xóa cookie.
   - **Ràng buộc:** admin-web chạy MỘT bản. Nếu nhân bản thì phải chuyển bộ gộp sang Redis.
5. **`proxy.ts` (Next 16).**
   - CSP nonce mới mỗi request: `script-src 'self' 'nonce-…' 'strict-dynamic'`, `style-src 'self' 'nonce-…'`,
     `frame-ancestors 'none'`. Có `upgrade-insecure-requests` khi origin là https.
   - Bỏ `'unsafe-inline'` của Caddy. Caddy không đặt CSP cho trang quản lý nữa nhưng vẫn giữ các header bảo mật chung.
   - Giao diện không dùng thuộc tính `style` inline; CSS nằm trong file.
   - Mọi trang render động (`connection()` ở layout gốc).
   - Proxy điều hướng:
     - chưa có phiên thì về `/login`;
     - access đã hết mà còn refresh thì làm mới ngay trong proxy và đưa token mới vào request đang xử lý (server component
       không ghi được cookie);
     - phiên có amr thiếu otp/rcv thì chỉ vào được `/enroll`.
   - Layout `(admin)` kiểm lại, vì prefetch không đi qua proxy. Payload JWT chỉ được giải mã, không kiểm chữ ký, và chỉ
     dùng để chọn menu. Quyền thật do API kiểm mỗi lần gọi.
6. **Màn hình lát này:**
   - A01: đăng nhập, 2FA hoặc mã khôi phục; lần đầu: đổi mật khẩu tạm (NC-22), QR Authenticator (thư viện `qrcode`, ảnh
     data URL) và 10 mã khôi phục hiện một lần.
   - A15: nhân viên và vai trò.
   - A11: phần thiết bị POS (mã ghi danh, kích hoạt bằng mã ghép, thu hồi).
   - A15+: tài khoản admin (tạo, khóa, mở, reset 2FA, phiên).
   - A17: nhật ký.
   - Phiên của chính mình và sinh lại mã khôi phục.
   - Step-up dùng hộp `<dialog>` chung: API trả 403 STEP_UP_REQUIRED thì hỏi mã, rồi gọi lại một lần với cùng
     Idempotency-Key.
   - Ô cửa hàng và hồ sơ xem tạm nhập uuid, vì danh sách cửa hàng (CP04) và hồ sơ xem (CP12) chưa có API.

## Hệ quả
- Compose: admin-web có `API_INTERNAL_URL=http://api:3000` và `ADMIN_ORIGIN`. Local mặc định là `http://localhost:8080`.
  Staging là `https://${APP_DOMAIN}`.
- Caddy `handle` của trang quản lý đặt `header_up X-Request-Id`. Hai Caddyfile đều đã qua `caddy validate`.
- Thư viện mới: `server-only` 0.0.1, `qrcode` 1.5.4 (admin-web); `playwright` 1.65.0 (devDependency của api, dùng cho e2e).
- E2E `apps/api/test-e2e/admin-web.e2e.ts` chạy bằng `pnpm --filter @fruit/api test:e2e`, sau khi đã
  `pnpm --filter @fruit/admin-web build`. Bài test dựng API thật trên PostgreSQL và Redis (Testcontainers), chạy
  `next start` bản production và Chromium.
- Hoãn: route cấp lại mật khẩu tạm cho tài khoản quá 72 giờ (NC-22, ghi nhận của kiểm thử). Màn hình Viewer thuộc CP12.
