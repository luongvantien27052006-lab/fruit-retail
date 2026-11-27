# REGRESSION.md — Sổ hồi quy theo module

> Skill `module-regression`. Sau mỗi thay đổi: chạy lệnh nghiệm thu của module đổi + mọi module hạ nguồn; chỉ giao
> khi tất cả exit code = 0. Module chưa có lệnh → `MISSING`; không bao giờ tạo kết quả xanh giả.
> Quan hệ hạ nguồn dưới đây là DỰ KIẾN theo SPEC §3.1/§19.1; xác minh bằng quét mã thật từ CP02.
>
> Làm mới quan hệ hạ nguồn lần cuối: 2026-11-27 (cổng CP03: quét mã thật — module nền tảng đã có lệnh; module nghiệp vụ còn MISSING).

| Module | Hạ nguồn dự kiến | Lệnh nghiệm thu | TEST-ID liên quan | Commit xanh gần nhất |
|---|---|---|---|---|
| `packages/contracts` | api_client_ts, shared_models, apps/api, admin-web, staff_app, customer_app | `pnpm --dir packages/contracts run check` (Git Bash, cwd gốc repo) | — | (CP01, xem checkpoints/CP01.md) |
| `packages/money_weight` | apps/api (pos, app-orders, wholesale, reporting), staff_app, customer_app, admin-web, api_client_ts, shared_models | `pnpm --filter @fruit/money_weight run test` + cwd `packages/money_weight/dart`: `dart test` | TEST-POS-001, TEST-APPORD-001, TEST-WS-001 | — |
| `apps/api` (khung, health) | mọi module API | `pnpm --filter @fruit/api run test` | TEST-INFRA-001/002 | (CP02) |
| `packages/api_client_ts` | admin-web | `pnpm --filter @fruit/api_client_ts run test` | TEST-CODEGEN-001 | (CP02) |
| `packages/shared_models` | staff_app, customer_app | cwd `packages/shared_models`: sinh rồi `dart test` | TEST-CODEGEN-002 | (CP02) |
| `api: auth, rbac` (auth/, common/access*, scope, approval-limits, rate-limit) | mọi module API, viewer, admin-web, staff_app | `pnpm --filter @fruit/api run test` (auth, pos-auth, customer-auth, rbac, admin-accounts, contract-access, route-access) | TEST-AUTH-001…003, TEST-RBAC-001, TEST-ADMIN-001, TEST-VIEWER-001, TEST-VIEWER-002 | `bfaa2cd` (cổng CP03 SẠCH, 2026-11-27) |
| `api: audit, outbox, files` (common/mutation, infra/outbox, files/) | mọi module ghi, worker | `pnpm --filter @fruit/api run test` (request-framework, outbox, files, redis-acl) | TEST-API-001, TEST-OUTBOX-001, TEST-FILE-001, TEST-REDISACL-001 | `bfaa2cd` (cổng CP03 SẠCH, 2026-11-27) |
| `api: catalog, pricing` | inventory, pos, push-deals, wholesale, reporting | MISSING | TEST-CAT-001…003 | — |
| `api: purchasing` | inventory, reporting | MISSING | TEST-PUR-001…003 | — |
| `api: inventory` | pos, app-orders, wholesale, push-deals, reporting | MISSING | TEST-INV-001…006 | — |
| `api: pos` | payments, reporting | MISSING | TEST-POS-001…008, TEST-CORE-001 | — |
| `api: payments (SePay)` | pos, app-orders, wholesale, reporting | MISSING | TEST-PAY-001…003 | — |
| `api: push-deals, notify` | app-orders, customer_app | MISSING | TEST-DEAL-001…002 | — |
| `api: app-orders` | delivery, payments, reporting | MISSING | TEST-APPORD-001…004, TEST-CUST-001 | — |
| `api: delivery` | app-orders, reporting | MISSING | TEST-DLV-001…002 | — |
| `api: wholesale` | delivery, reporting | MISSING | TEST-WS-001…002 | — |
| `api: reporting, publish` | admin-web, viewer | MISSING | TEST-RPT-001…002, TEST-VIEWER-003, TEST-PUB-001 | — |
| `infra/sql` (trigger, RLS, role) | inventory, reporting, viewer, audit | `pnpm --filter @fruit/api run test` (db-bootstrap) | TEST-VIEWER-002 | — |
| `apps/admin-web` | — | `pnpm --filter @fruit/admin-web run typecheck` + `lint` + `build`, rồi `pnpm --filter @fruit/api run test:e2e -- admin-web` | TEST-ADMINWEB-001 | `bfaa2cd` (cổng CP03 SẠCH, 2026-11-27) |
| `apps/staff_app` | — | cwd `apps/staff_app`: `flutter analyze --fatal-infos && flutter test`; Windows (Flutter + VS ATL): `pnpm --filter @fruit/api run test:e2e -- staff-app` | TEST-STAFFAPP-001 | `bfaa2cd` (cổng CP03 SẠCH, 2026-11-27) |
| `infra/redis` (start.sh, ACL) | api (rate limit), worker (outbox) | `pnpm --filter @fruit/api run test` (redis-acl) + smoke compose | TEST-REDISACL-001 | `bfaa2cd` (cổng CP03 SẠCH, 2026-11-27) |
| `apps/customer_app` | — | cwd `apps/customer_app`: `flutter analyze --fatal-infos && flutter test` | — | — |
