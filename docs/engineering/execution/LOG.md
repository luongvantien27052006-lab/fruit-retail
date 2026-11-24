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
