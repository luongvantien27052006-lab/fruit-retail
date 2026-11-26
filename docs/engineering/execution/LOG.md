# LOG — Nhật ký sự kiện (chỉ thêm)

| Thời điểm (giờ VN) | CP | Sự kiện |
|---|---|---|
| 2026-11-17 | CP00 | Mở CP00. Kiểm kê `.claude/` mang từ dự án F2C: 3 rule F2C, 5 `f2c-integration.md`, khối adapter F2C ở 14 agent, mô tả F2C ở 5 SKILL.md UI. |
| 2026-11-17 | CP00 | Tiến quyết: repo code ở `D:\fruit-retail` (ASCII); `D:\app hoa quả` chỉ đọc; §7.6 HOÃN; thư mục ADR để CP01; mẫu ADR đặt trong `fruit-engineering.md`. |
| 2026-11-17 | CP00 | Sao chép SPEC v3.2, KẾ HOẠCH, PROMPT vào `docs/specs/`, v2 vào `docs/specs/history/`; SPEC sha256 khớp bản gốc. |
| 2026-11-17 | CP00 | `.claude` gốc tại `D:\app hoa quả` đã bị chuyển vào Thùng rác (21:02, không do phiên này); theo chỉ thị của Tiến, sao chép từ Thùng rác sang `D:\fruit-retail\.claude`. |
| 2026-11-17 | CP00 | Tiến duyệt nháp. Ghi 3 rule `fruit-*.md`, `fruit-integration.md` cho 5 skill UI, thay khối ngữ cảnh 14 agent, sửa `e2e-runner`, 5 SKILL.md, `ecc-guardrails.md`, 2 command. |
| 2026-11-17 | CP00 | Theo chỉ thị của Tiến, XÓA HẲN phần F2C (không lưu trữ): 3 rule `f2c-*.md`, 5 `f2c-integration.md`; xóa metadata ECC không dùng (`enterprise/`, `research/`, `team/`, `homunculus/`, `workflows/`, `ecc-tools.json`, `identity.json`, `package-manager.json`, `settings.local.json`, `commands/add-language-rules.md`, `rules/node.md`). |
| 2026-11-17 | CP00 | Tiến thêm `CLAUDE.md` (nguyên tắc hành vi) và `.claude-plugin/`; gộp nguyên tắc vào `CLAUDE.md` cùng bản đồ dự án. |
| 2026-11-17 | CP00 | Tạo SPEC-LOCK, CONTEXT, TESTS (41 TEST-ID), REGRESSION (khung), STATUS, `checkpoints/CP00.md`; `git init`, commit đầu. CP00 → CHỜ REVIEW. |
| 2026-11-17 | CP00 | Tiến xác nhận CP00 ĐẠT (yêu cầu "bắt đầu làm CP01"). Commit f9ea35f, aa318ab. |
| 2026-11-17 | — | Tiến cấp remote `origin` = github.com/luongvantien27052006-lab/fruit-retail (repo trống); từ nay code đẩy lên đây. |
| 2026-11-17 | CP01 | Mở CP01. |
| 2026-11-17 | CP01 | Tiến chốt: ADR ở `docs/engineering/decisions/`, Prisma theo SPEC, worker là entry 2 của `apps/api`, Node 24 LTS. Tiến cho phép tự cài thư viện chính chủ khi cần. |
| 2026-11-17 | CP01 | Ghi ADR-001…010, versions.json, openapi.yaml (189 thao tác), 24 schema sự kiện, 7 máy trạng thái + 50 vector, ERD, screens.md. Kiểm `pnpm --dir packages/contracts run check` exit 0. CP01 → CHỜ REVIEW. |
| 2026-11-17 | CP01 | Tiến "Duyệt tất cả": ADR-008 accepted; NC-08 (5 mã quyền), NC-09 (route ngoài §13.2), NC-10 (tách giá vốn khỏi `live_sales_hourly`) đã quyết. Kiểm hợp đồng exit 0. Theo yêu cầu của Tiến: chạy review bằng agent trước khi ĐẠT. |
| 2026-11-17 | CP01 | Review agent (4 reviewer chỉ đọc: kiến trúc, CSDL, bảo mật, tài liệu) → C8/H35. Đã sửa: ADR-011…017; ERD §6; openapi 213 thao tác (tài khoản admin + step-up, 2FA/phiên/thiết bị, quyền theo mã báo cáo, quyền con POS/duyệt, webhook scheme, file); 26 sự kiện chặt; 9 máy trạng thái + effects (76 vector); script đối chiếu SPEC; sửa FR-INV-13/14, CLAUDE.md, skill, agent, screens; NC-11…17. `pnpm --dir packages/contracts run check` exit 0. |
| 2026-11-17 | CP01 | Tiến quyết: NC-11 mở rộng người tạo ≠ người duyệt; NC-13 COD vượt ≤10% cho qua; NC-12 trả lời "số tồn do người đăng (master) nhập khi đăng sản phẩm" (diễn giải chờ xác nhận). Tiến xác nhận CP01 ĐẠT → merge `feat/cp01-architecture` vào `develop`. |
| 2026-11-17 | CP01 | Tiến xác nhận diễn giải NC-12 (hệ số giữ tồn là cấu hình, mặc định 1,1 cho đơn app; đơn PHONE giữ đúng số nhập). |
| 2026-11-18 | — | Cài Node v24.22.3 (MSI chính thức nodejs.org, SHA256 khớp SHASUMS256.txt, chữ ký Authenticode OpenJS hợp lệ) thay Node 22.22.3. Ghi chú: Node 26 là Active LTS, Node 24 là Maintenance — Tiến giữ 24 (sửa thông tin sai trong ADR-010). Kiểm hợp đồng trên Node 24 exit 0. |
| 2026-11-18 | CP02 | Mở CP02 (Tiến duyệt kế hoạch con 8 lát; CI = GitHub Actions). Lát 1 khung monorepo pnpm + pub workspace; lát 2 `money_weight` TS (38 test) + Dart (37 test) chung vector Phụ lục A — TDD: đỏ trước, xanh sau. ADR-018 chốt TS 6.0.3, NestJS 12, Prisma 7.10.1. |
| 2026-11-18 | CP02 | Lát 3–8: apps/api NestJS 12 + health thật; bootstrap DB ADR-011 (9 test PostGIS thật); compose local health 200 qua Caddy; admin-web + 2 app Flutter; spike codegen TS/Dart (swagger_parser cần bước export:dart) + spike COM Windows; CI GitHub Actions; command-catalog. CI run 44160318493: job không khởi chạy do thanh toán tài khoản GitHub → CHẶN, người gỡ Tiến. |
| 2026-11-18 | CP02 | Tiến chuyển repo public → CI chạy: gitleaks, Dart xanh; TS đỏ (format next-env.d.ts). Review agent CP02 (bảo mật: M5/L12; mã+DB: H4/M7/L10) → sửa: build:libs trước lint/typecheck/test, USAGE public cho app_rw/projector_rw, bỏ default privilege projector, CONNECT/TEMP, SCRAM verifier, chặn mật khẩu mẫu, advisory lock, log lỗi Redis/health, timeout pool, Redis connect chung, X-Request-Id, compose cứng hóa, header Caddy, pnpm hash/minimumReleaseAge/strictDepBuilds, gitleaks digest. ADR-019. Checkout sạch: mọi bước exit 0. |
| 2026-11-18 | CP02 | Merge feat/cp02-scaffold → develop (d3b5141). CI develop run 44167559207: 4/4 job success (gồm build Windows + spike COM). Còn CHẶN: diễn tập khôi phục backup, staging, giám sát — chờ VPS/storage/Sentry/Telegram. |
| 2026-11-18 | CP02 | Lát 9 (backup WAL-G + PITR local) qua 3 vòng kiểm thử agent → sạch lỗi chặn (e7264b6). Tiến đặt quy tắc: mỗi phần phải được agent chuyên biệt kiểm thử, xác nhận hết lỗi mới làm tiếp. |
| 2026-11-18 | CP02 | Lát 10 (override staging, Caddyfile HTTPS, `infra/stg.sh` preflight, cron-run/alert, drill S3, runbook-deploy) qua 3 vòng kiểm thử agent → SẠCH (05d277b + sửa tài liệu). |
| 2026-11-18 | CP02 | Merge feat/cp02-backup → develop (9cbb196); CI develop 4/4 job success. |
| 2026-11-24 | CP02 | Tiến quyết tạm bỏ qua phần hạ tầng thật (VPS/domain/S3/Sentry/Telegram); CP02 giữ CHẶN ở các cổng đó. |
| 2026-11-24 | CP03 | Mở CP03 (ngoại lệ tiên quyết CP02 theo quyết định trên); soạn kế hoạch con 10 lát, chờ Tiến duyệt. |
| 2026-11-24 | CP03 | Lát 1 (schema nền: 28 bảng, quyền theo cột, RLS khung, seed quyền, bộ chạy migration Prisma — ADR-020) qua 4 vòng kiểm thử agent → SẠCH (4144712). NC-19 (seed vai trò → quyền) chờ Tiến. |
| 2026-11-25 | CP03 | Lát 2 (khung request: transaction + audit + outbox, deny-by-default, envelope lỗi, chặn ghi ngoài transaction, DB sập → 503) qua 4 vòng kiểm thử agent → SẠCH (7c32799). Thêm mã lỗi `INTERNAL_ERROR` vào hợp đồng. |
| 2026-11-25 | CP03 | Lát 3 (auth Master/Viewer: Argon2id, TOTP + mã khôi phục, khóa tăng dần, JWT EdDSA xoay khóa, refresh xoay vòng + phát hiện dùng lại, step-up, CLI tạo Master — ADR-021) xong code, 98/98 test; chờ kiểm thử agent. |
| 2026-11-25 | CP03 | Lát 3 qua 4 vòng kiểm thử agent bảo mật → SẠCH (c82f322 + sửa T6). Sửa chính: một lần thử xác thực = một transaction khóa theo tài khoản (đợt song song ≤ 5 lần, không rò, không khóa vĩnh viễn), login 401 chung, chống đua đăng ký 2FA, no-store, giới hạn suất Argon2 theo IP. Test 105/105. |
| 2026-11-25 | CP03 | Lát 4: Tiến chọn "Thêm mã ghi danh" cho M1 ⇒ NC-20 (route `POST /admin/pos-devices/enrollment-codes` ngoài §13.2). Đã làm: migration 0003, `/auth/devices/register` nhận `enrollment_code`. Test 122/122. Chờ kiểm thử agent lần 2. |
| 2026-11-25 | CP03 | Lát 4 qua 2 vòng kiểm thử agent bảo mật → SẠCH (46b4507). 122/122 test. Ghi nhận không bắt buộc chuyển lát 5/6 (ADR-022). Lát 4 đóng. |
| 2026-11-25 | CP03 | Lát 5 (OTP khách + TEST_DOUBLE có nhãn, giới hạn tần suất Redis cho route xác thực — ADR-023) xong code, 132/132 test; chờ kiểm thử agent. |
| 2026-11-25 | CP03 | Lát 5 qua 2 vòng kiểm thử agent bảo mật → SẠCH (769cb49). 133/133 test. Rủi ro cạn trần gửi OTP toàn hệ thống ghi chặn CP14 ở STATUS. Lát 5 đóng. |
| 2026-11-26 | CP03 | Tiến quyết NC-19 (đọc chặt quyền SM; hạn mức "hoặc" = một ngưỡng; thêm `zone:read`, `pos_log:read`; giữ phần còn lại) và NC-21 (bỏ giảm giá tay ở POS; giảm giá cận hạn chỉ Master duyệt; voucher vẫn để sau). Migration `0004_nc19_permissions`, hợp đồng bỏ `pos:discount`. Test 133/133. Chờ kiểm thử agent. |
| 2026-11-26 | CP03 | NC-19/NC-21 kiểm thử agent database-reviewer lần 1 (4f735ee): CÒN LỖI — cấp riêng lại được markdown:approve, hợp đồng chưa theo (route /pos/markdowns approve, zones dùng report:read), test thiếu. Sửa: migration 0005, hợp đồng, test. 133/133. |
| 2026-11-26 | CP03 | NC-19/NC-21 kiểm lần 2 (17f4484): còn 4 Thấp — sửa screens.md (T09/P18/A09), script kiểm §13.2 cắt sai `|` trong backtick (61 → 80 route, missing=0), thêm `GET /admin/approvals`, `x-scope: store` cho zones; ERD bỏ discount_approved_by. |
| 2026-11-26 | CP03 | NC-19/NC-21 kiểm lần 3 (21553a4): còn 2 Thấp — script §13.2 bỏ qua hàng Admin (nay kiểm 90 route, missing=0; route đã miễn mà xuất hiện lại ⇒ FAIL), `/admin/approvals*` gắn `x-master-only`. |
| 2026-11-26 | CP03 | NC-19/NC-21 qua 4 vòng kiểm thử agent database-reviewer → SẠCH (925b027). 133/133 test, kiểm hợp đồng 90 route §13.2 missing=0. Lát 6 hết chặn. |
| 2026-11-26 | CP03 | Lát 6 (RBAC theo phạm vi, hạn mức từ dữ liệu, quản lý nhân viên/vai trò, cô lập Viewer — ADR-024) xong code, 142/142 test, T16/T17 covered; chờ kiểm thử agent. |
| 2026-11-26 | CP03 | Lát 6 kiểm thử lần 1 (98cda64): security CÒN LỖI (2 TB, 3 Thấp), database CÒN LỖI (1 TB, 2 Thấp). Đã sửa hết (ADR-024 mục "Sửa theo kiểm thử agent lần 1"). 144/144. |
| 2026-11-26 | CP03 | Lát 6 kiểm thử lần 2 (7b73605): security SẠCH; database còn L1' (TB: đăng nhập dùng mã băm PIN cũ đọc trước) + 2 Thấp — đã sửa. 145/145. |
| 2026-11-26 | CP03 | Lát 6 SẠCH (security 2 vòng, database 3 vòng — a3df1ca). 145/145 test. T16/T17 covered. Ghi nhận G1–G4 sang lát 8. Lát 6 đóng. |
| 2026-11-26 | CP03 | Lát 7 (outbox relay + consumer idempotent + bộ quét; file presign/complete/download trên S3 — ADR-025) xong code, 159/159 test; chờ kiểm thử agent. |
| 2026-11-27 | CP03 | Lát 7 kiểm thử lần 1 (4af7852): silent-failure CÒN LỖI (Cao: Redis sập làm sự kiện dead_at; TB: PUT ghi đè sau READY, job lỗi hẳn không log, bộ quét kẹt), code-reviewer CÒN LỖI (Cao: ghi đè sau READY; TB: khách tải mọi loại ảnh / trần chỉ đếm PENDING, bộ quét). Đã sửa hết (ADR-025). 162/162. |
| 2026-11-27 | CP03 | Lát 7 kiểm thử lần 2 (cd76b58): cả hai agent CÒN LỖI — Redis PING được nhưng từ chối ghi vẫn giết sự kiện; hai complete song song chép đè khóa cuối; ảnh khiếu nại phải chụp trực tiếp (§8.8). Sửa: phân loại lỗi Redis theo nội dung, khóa cuối riêng + cột final_key (migration 0006). 163/163. |
| 2026-11-27 | CP03 | Lát 7 SẠCH sau 3 vòng kiểm thử agent (silent-failure-hunter + code-reviewer — 20322d8). 163/163 test. Ghi nhận Thấp sang CP19 (giám sát outbox, job dọn object). Lát 7 đóng. |
| 2026-11-27 | CP03 | Lát 8 chia 8a (API quản trị) + 8b (admin web). 8a xong code (ADR-026), 168/168 test; chờ kiểm thử agent. |
| 2026-11-27 | CP03 | Lát 8a kiểm thử security lần 1 (f8163ef): CÒN LỖI (TB: khóa tài khoản DISABLED rồi mở khóa ⇒ hồi sinh; Thấp ×2). Đã sửa + G-a/G-c/G-d. 168/168. |
| 2026-11-27 | CP03 | Lát 8a kiểm thử security lần 2 (486f31f): còn L2' (Thấp: PATCH /admin/staff lấy khóa đăng nhập trước khi kiểm phạm vi) — đã sửa. 168/168. |
| 2026-11-27 | CP03 | Lát 8a SẠCH sau 3 vòng security-reviewer (1aedfb4). 168/168. Tiếp 8b (admin web Next.js). |
| 2026-11-27 | CP03 | Tiến duyệt NC-22 (POST /auth/password, mật khẩu tạm phải đổi, tài khoản chưa kích hoạt hết hạn 72 giờ). Đã làm: migration 0007, route, test. 169/169. Chờ kiểm thử agent. |
| 2026-11-27 | CP03 | NC-22 kiểm thử lần 1 CÒN LỖI (Thấp ×3) → sửa (7170240) → lần 2 SẠCH. |
| 2026-11-27 | CP03 | Lát 8b xong code: admin web BFF + CSP nonce + màn A01/A11/A15/A15+/A17 (ADR-027). E2E Playwright 8/8, API 169/169. Chờ kiểm thử agent. |
| 2026-11-27 | CP03 | Lát 8b: security 3 vòng (CÒN LỖI → CÒN LỖI → SẠCH), react 2 vòng (CÒN LỖI → SẠCH). E2E 11/11. Lát 8 đóng. |
