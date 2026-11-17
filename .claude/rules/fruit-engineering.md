---
paths:
  - "apps/**"
  - "packages/**"
  - "infra/**"
  - "docs/engineering/**"
---

# Fruit Retail Engineering Rules (ứng dụng)

Áp dụng cho mã và tài liệu kỹ thuật của dự án "Hệ thống chuỗi bán lẻ hoa quả". Bất biến nghiệp vụ nằm ở
`.claude/rules/fruit-retail-invariants.md` (luôn bật). Nguồn sự thật: `docs/specs/DAC_TA_HE_THONG_HOA_QUA_v3.md`
(v3.2, khóa sha256 trong `docs/specs/SPEC-LOCK.md`) và `docs/specs/KE_HOACH_TRIEN_KHAI_CHECKPOINT.md`.
Rule này KHÔNG thay ADR: phiên bản công cụ, ORM, test runner, generator, package manager chốt bằng ADR ở CP01
và `docs/engineering/architecture/versions.json`. Khi ADR đã `accepted` mâu thuẫn với rule này, ADR thắng và rule
phải được sửa theo.

## Thứ tự ưu tiên khi mâu thuẫn

1. Chỉ thị trực tiếp của chủ dự án (Tiến) trong phiên.
2. SPEC §1.4 (D1–D20) và §21 "v3.2 bổ sung" (§21 thắng thân bài chưa cập nhật).
3. Thân bài SPEC §1–§20.
4. ADR `accepted`.
5. Rule `.claude/rules/fruit-*.md`.
6. Rule/skill gốc ECC còn lại.

Nguồn im lặng hoặc mâu thuẫn về tiền, tồn, quyền, dữ liệu khách → ghi `needs confirmation` vào `CONTEXT.md`, hỏi
Tiến, không tự suy diễn. `DAC_TA_HE_THONG_HOA_QUA_v2.md` chỉ là lịch sử, không hiện thực thứ chỉ có trong v2.

## Stack & cấu trúc (SPEC §19.1, §19.2)

```
apps/api/            NestJS modular monolith — 2 entry: main.ts (API + Socket.IO), worker.ts (BullMQ, outbox, cron)
apps/admin-web/      Next.js App Router — route group (master) và (viewer)
apps/customer_app/   Flutter iOS/Android (A1)
apps/staff_app/      Flutter, 3 chế độ: counter (Windows POS), tablet (Android), shipper (Android)
packages/contracts/  openapi.yaml + events/*.json — NGUỒN HỢP ĐỒNG DUY NHẤT
packages/shared_models/  Dart sinh từ OpenAPI
packages/api_client_ts/  TS sinh từ OpenAPI
packages/money_weight/   helper tiền/cân Dart + TS, chung bộ test vector
infra/               docker-compose, caddy, backup, sql/ (trigger, RLS, role DB, PostGIS — đánh số thứ tự)
docs/                specs, engineering (execution, decisions, architecture, data, ux)
```

- Backend: TypeScript `strict`; PostgreSQL + PostGIS là nguồn sự thật; Redis/BullMQ chỉ queue/cache/pub-sub,
  không bao giờ là nguồn quyết định tồn, hạn mức, tiền.
- Module NestJS khai báo trong `imports` của module cha, không đặt trong `forFeature([])` của ORM (§19.2).
- Không dùng `synchronize: true`; migration có version (Prisma migrate cho bảng + SQL thủ công `infra/sql/`).
- Client TS/Dart SINH từ `packages/contracts`; cấm viết tay DTO song song. Không import TS vào Dart.
- Enum trạng thái định nghĩa một nơi (backend/contracts) → sinh sang Dart/TS. Mỗi loại đơn/chứng từ đổi trạng
  thái qua đúng một state machine service có bảng chuyển hợp lệ dạng dữ liệu + ghi `*_events`.
- Package manager (đề xuất pnpm workspace cho JS/TS; Flutter dùng pub) chốt ở ADR-001.

## Quy ước tên

- TypeScript: file `kebab-case` (`stock-movement.service.ts`); class PascalCase; hằng SCREAMING_SNAKE_CASE.
- Dart: file `snake_case.dart` theo Effective Dart.
- SQL (§12.1): khóa chính UUID v7; tiền `BIGINT` hậu tố `_amount`/`_price`, đơn giá/kg `_per_kg`; khối lượng
  `INTEGER` gram hậu tố `_g`; số lượng `INTEGER` hậu tố `_units`; thời gian `TIMESTAMPTZ`; ngày kinh doanh
  `business_date`; danh mục ẩn bằng `archived_at`; khóa lạc quan cột `version`.
- Mã hiển thị theo §21.3.14 (thắng §12.1): hóa đơn POS `CH01-251117-0042`; đơn app ngẫu nhiên `APP-7KQ2XH9M`;
  đơn sỉ/phiếu/PO tăng dần `WS-000123`, `PN-000456`; lô `B{yyMMdd}-{số}`.
- Tên file migration/SQL: ASCII snake_case, không dấu tiếng Việt. Không đổi tên đại trà file đã có.

## API (SPEC §13.1)

- REST JSON tiền tố `/v1`; nhóm `/app/*`, `/pos/*`, `/shipper/*`, `/admin/*`, `/viewer/*`, `/webhooks/*`, `/auth/*`.
- Header `X-Request-Id`, `X-Device-Id`; mọi thao tác ghi từ POS/app gửi `Idempotency-Key`.
- Lỗi `{ code, message, details, request_id }`; mã nghiệp vụ chuẩn (`STOCK_INSUFFICIENT`, `DEAL_SOLD_OUT`,
  `OUT_OF_ZONE`, `SHIFT_NOT_OPEN`, `APPROVAL_REQUIRED`, `PERIOD_LOCKED`, `STEP_UP_REQUIRED`,
  `CONFIGURATION_NOT_READY`…) là enum trong contracts. Danh sách đầy đủ chốt ở CP01.
- Mọi route có `@RequirePermission(...)` với mã quyền §19.6 + §21.8; mặc định từ chối; DTO có validate.

## Bắt buộc khi viết mã

- Mỗi use case = 1 transaction PostgreSQL; trong đó ghi nghiệp vụ + `integration.outbox` + `audit.logs`.
  Gọi SePay/Ahamove/FCM/OTP SAU commit; không giữ transaction khi gọi dịch vụ ngoài.
- Tiền/cân chỉ qua `packages/money_weight` (`lineAmount`, `formatVnd`, `formatKg`). Xem FR-INV-01…03.
- Test trước (TDD) cho logic tiền, cân, tồn, FEFO, giá vốn, hạn mức, vùng giao, trạng thái, quyền. Test DB và
  đồng thời chạy PostgreSQL thật trong Docker; cấm SQLite/in-memory thay PostgreSQL (SQLite chỉ là kho offline
  của POS, test riêng phần đó). Adapter ngoài giả chỉ ở dev/test/staging, gắn nhãn `TEST_DOUBLE`.
- Thiếu cấu hình bắt buộc → 503 `CONFIGURATION_NOT_READY` cho tác vụ mới, không fallback 0/true/vô hạn; tác vụ
  đang dở (webhook, đối soát, hoàn tiền) vẫn được xử lý.
- Không ghi secret/token/OTP/PIN/số tài khoản vào mã, log, fixture commit, báo cáo; log JSON có `request_id`.

## Lệnh kiểm thử

Lệnh thật nằm ở `docs/engineering/execution/command-catalog.md` (tạo ở CP02: cwd, shell, lệnh). Không dùng
`node tests/run-all.js` hay ngưỡng "80% coverage" của ECC làm cổng. Ghi lệnh, cwd, exit code thật; không cắt log
làm mất exit code; lệnh không chạy được → `NOT RUN` + lý do, không đánh dấu ĐẠT.

## Điều phối & tài liệu

- Tracker duy nhất `docs/engineering/execution/STATUS.md` (CHƯA MỞ / ĐANG LÀM / CHỜ REVIEW / ĐẠT / CHẶN), chỉ
  phiên điều phối ghi. `LOG.md` chỉ thêm. Bằng chứng mỗi CP: `docs/engineering/execution/checkpoints/CPxx.md`
  theo mẫu KẾ HOẠCH §4.
- Tài liệu sống: `CONTEXT.md` (thuật ngữ §1.5 + `needs confirmation`), `TESTS.md` (TEST-ID), `REGRESSION.md`
  (module → hạ nguồn → lệnh nghiệm thu), `CLAUDE.md` (bản đồ).
- Một người ghi mỗi file; contracts, enum, migration, lockfile, cấu hình gốc có một chủ duy nhất.
- Agent reviewer là CHỈ ĐỌC: trả findings (path:line + cách tái hiện), tác giả sửa; CRITICAL/HIGH phải đóng
  trước khi xin ĐẠT.
- Git: `main` (prod), `develop` (staging), `feat/cpxx-*`; Conventional Commits, tiêu đề ~70 ký tự. Không commit
  `.env`, secret, dữ liệu khách thật.

## Vòng làm việc mỗi checkpoint

1 Đọc mục CP + § SPEC + ADR + STATUS/TESTS/REGRESSION → 2 kiểm tiên quyết (thiếu → CHẶN, nêu người gỡ) →
3 kế hoạch con + `change-impact` nếu nhiều module → 4 test trước (TEST-ID) → 5 hiện thực: contracts → sinh
client → server → client; migration theo `database-migrations` (rollback hoặc ghi phần không đảo được) →
6 `verification-loop` + `module-regression` → 7 review theo bảng định tuyến → 8 `change-impact` sau triển khai →
9 ghi CPxx.md, STATUS, LOG → 10 commit → 11 xin Tiến xác nhận với CP có "Việc của chủ dự án", còn lại tự ĐẠT khi
đủ bằng chứng.

| Công việc | Skill | Agent review |
|---|---|---|
| Kế hoạch CP | — | planner |
| Quyết định khó đảo ngược | context-and-decisions (→ ADR mẫu dưới) | architect |
| Schema, migration, RLS, index | database-migrations, postgres-patterns | database-reviewer |
| API NestJS | nestjs-patterns, api-design, backend-patterns | typescript-reviewer, security-reviewer |
| Admin web | frontend-patterns, ui-styling, design-system | react-reviewer, a11y-architect |
| Flutter | ui-styling, ui-ux-pro-max | flutter-reviewer, a11y-architect |
| Tiền, cân, tồn, trạng thái, quyền | tdd-workflow, test-collaboration | tdd-guide, silent-failure-hunter |
| Webhook SePay/Ahamove, auth, viewer | ecc-security-review | security-reviewer |
| Đổi nhiều module | change-impact | architect |
| Sau mỗi thay đổi | module-regression, verification-loop | code-reviewer |
| Hiệu năng realtime/báo cáo | — | performance-optimizer |
| Tài liệu | context-and-decisions | doc-updater |

## Dừng và hỏi Tiến khi

SPEC mâu thuẫn/im lặng về tiền, tồn, quyền, dữ liệu khách · cần phụ thuộc lớn, đổi stack, đổi cấu trúc khác
§19.1/ADR · thao tác không đảo ngược (xóa dữ liệu, migration phá hủy, deploy production, gửi thông báo hàng loạt
thật, giao dịch tiền thật) · thiếu thông tin chỉ Tiến có (tài khoản, model thiết bị, dữ liệu thật, định nghĩa
nghiệp vụ) · test chỉ xanh nếu nới assertion hoặc thay PostgreSQL bằng mock.

## Mẫu ADR (thay skill `architecture-decision-records` chưa có)

Thư mục ADR: `needs confirmation` — chốt ở CP01 (SPEC §19.5 ghi `docs/adr/`, KẾ HOẠCH ghi
`docs/engineering/decisions/`). Tên file `ADR-0xx-<slug-ascii>.md`, đánh số tăng dần, không tái sử dụng số.

```markdown
# ADR-0xx: <tiêu đề>
- Trạng thái: proposed | accepted | superseded by ADR-0yy | rejected
- Ngày: YYYY-MM-DD · Người quyết: <Tiến / phiên điều phối> · Căn cứ SPEC: §x.y
## Bối cảnh
<vấn đề, ràng buộc, vì sao phải quyết bây giờ>
## Quyết định
<một đoạn, khẳng định>
## Phương án đã cân nhắc
| Phương án | Ưu | Nhược | Lý do loại |
## Hệ quả
<được gì, mất gì, việc phải làm, cách đảo ngược nếu có>
```
ADR `accepted` không sửa nội dung; thay đổi = ADR mới ghi `supersedes`.
