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

## Sửa theo kiểm thử security lần 1 (296e496)
- TB: cookie CSRF không được gia hạn khi refresh ⇒ sau 12 giờ mọi thao tác ghi 403 và **đăng xuất im lặng thất bại** (phiên
  Master còn sống trên máy dùng chung). Sửa: `extendCsrf` gia hạn (giữ nguyên giá trị, thiếu thì cấp mới) mỗi khi ghi refresh
  mới (route handler + proxy); `/bff/auth/logout` chỉ kiểm Origin (không đòi double-submit) và luôn xóa cookie; nút đăng xuất
  báo lỗi thay vì im lặng.
- Thấp: `csrfOk` so độ dài theo byte (header nhiều byte làm `timingSafeEqual` ném ⇒ 500).
- Thấp: proxy làm mới token rồi điều hướng (303) ⇒ phản hồi điều hướng cũng mang Set-Cookie (trước đây mất token mới).
- Thấp: bộ gộp refresh dùng SHA-256 của token làm khóa, cửa sổ 15 s (thay 60 s), tự xóa bằng timer `unref`, trần 2000 mục.
- Thấp: chỉ `/auth/refresh`, `/auth/step-up`, `/auth/2fa/confirm` (và login/mfa) được đặt token phiên; mọi khóa
  `access_token`/`refresh_token`/`mfa_challenge` ở MỌI cấp bị bỏ khỏi body trả trình duyệt.
- Ràng buộc ghi nhận: admin-web chuyển tiếp X-Forwarded-For nguyên văn — chỉ an toàn vì cổng admin-web KHÔNG mở ra ngoài
  (chỉ Caddy tới được, Caddy ghi đè XFF). Mở cổng admin-web ⇒ phải bỏ XFF hoặc chỉ nhận từ Caddy.
- E2E thêm 2 bài (10/10): header CSRF nhiều byte ⇒ 403; điều hướng sau refresh mang Set-Cookie + CSRF mới; mất cookie CSRF vẫn
  đăng xuất được và phiên API bị thu hồi.

## Sửa theo kiểm thử react lần 1 (296e496) + security lần 2 (d560fee)
- Cao ×2: 401 `OTP_INVALID` (sai mã step-up / sai mã ở /enroll) bị client coi là hết phiên ⇒ đá về /login, mất thao tác, secret
  TOTP bị thay. Sửa: BFF gắn `x-session-ended: 1` CHỈ khi phiên chết thật (`loggedOut`); client chỉ chuyển trang khi thấy
  header đó; lỗi khác hiện tại chỗ.
- TB: hai thao tác cùng chờ step-up ⇒ promise đầu treo. Sửa: một promise dùng chung; `onClose` cũng kết thúc lời hỏi.
- TB: bấm đúp tạo trùng (mỗi lần một Idempotency-Key) ⇒ khóa `busy` (ref + state) ở mọi nút thao tác.
- TB: tràn ngang ở 375 px ⇒ `.main{min-width:0}`, bảng trong `.table-wrap` cuộn ngang, cột user-agent xuống dòng.
- Thấp: `not-found.tsx` + `global-error.tsx` riêng (trang mặc định dùng style inline ⇒ vi phạm CSP); 2FA hết challenge/khóa ⇒
  báo lý do rồi mới về đăng nhập; /enroll có nút "Thử lại" khi lỗi và ghi chú QR đổi mỗi lần mở; hồ sơ xem bắt buộc khi chọn
  Viewer (không gửi chuỗi rỗng); "Xem thêm" nhật ký dùng bộ lọc đã áp dụng; trạng thái hiện tiếng Việt.
- `server-only` KHÔNG thêm vào `lib/server/session.ts`/`upstream.ts`/`config.ts`: proxy.ts (không thuộc lớp react-server)
  import chúng, gói `server-only` sẽ ném. Đã kiểm bundle `.next/static` không chứa mã server.
- Security lần 2 — TB mới: bộ gộp refresh đầy (token rác giữ 15 s) ⇒ bỏ gộp ⇒ refresh thật bị gọi trùng ⇒ API thu hồi phiên.
  Sửa: chỉ giữ mục đang chạy và mục THÀNH CÔNG (lỗi xóa ngay khi xong); đầy ⇒ đẩy mục cũ nhất, không bao giờ bỏ gộp.
  `scrub` dùng object không prototype, nhánh lồng quá 32 cấp bị bỏ hẳn.
- E2E 11/11: thêm sai mã ở /enroll (ở lại, secret giữ nguyên), sai mã step-up + Esc hủy + bấm đúp (một tài khoản, không lỗi),
  trang 404 không vi phạm CSP, 375 px không tràn trên 5 trang; e2e từ chối chạy nếu bản build cũ hơn mã nguồn.

## Kiểm thử security lần 3 (9b86a1c): SẠCH
- Rủi ro chấp nhận (Thấp): đẩy mục cũ nhất có thể đẩy cả mục refresh THÀNH CÔNG của người dùng thật nếu kẻ tấn công chèn
  ~2000 request trong đúng khe vài ms–1 s giữa lần refresh đầu và request tới muộn (cần >2000 req/s vào admin-web). Siết sau
  (khi cần): tách bản đồ mục thành công (bị chặn bởi số người dùng thật) hoặc đầy ⇒ 503 cho mục mới thay vì đẩy.

## Hệ quả
- Compose: admin-web có `API_INTERNAL_URL=http://api:3000` và `ADMIN_ORIGIN`. Local mặc định là `http://localhost:8080`.
  Staging là `https://${APP_DOMAIN}`.
- Caddy `handle` của trang quản lý đặt `header_up X-Request-Id`. Hai Caddyfile đều đã qua `caddy validate`.
- Thư viện mới: `server-only` 0.0.1, `qrcode` 1.5.4 (admin-web); `playwright` 1.65.0 (devDependency của api, dùng cho e2e).
- E2E `apps/api/test-e2e/admin-web.e2e.ts` chạy bằng `pnpm --filter @fruit/api test:e2e`, sau khi đã
  `pnpm --filter @fruit/admin-web build`. Bài test dựng API thật trên PostgreSQL và Redis (Testcontainers), chạy
  `next start` bản production và Chromium.
- Hoãn: route cấp lại mật khẩu tạm cho tài khoản quá 72 giờ (NC-22, ghi nhận của kiểm thử). Màn hình Viewer thuộc CP12.
