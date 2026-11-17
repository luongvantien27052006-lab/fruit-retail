# REGRESSION.md — Sổ hồi quy theo module

> Skill `module-regression`. Sau mỗi thay đổi: chạy lệnh nghiệm thu của module đổi + mọi module hạ nguồn; chỉ giao
> khi tất cả exit code = 0. Module chưa có lệnh → `MISSING`; không bao giờ tạo kết quả xanh giả.
> Quan hệ hạ nguồn dưới đây là DỰ KIẾN theo SPEC §3.1/§19.1; xác minh bằng quét mã thật từ CP02.
>
> Làm mới quan hệ hạ nguồn lần cuối: `2026-11-17` (theo SPEC, chưa có mã nguồn).

| Module | Hạ nguồn dự kiến | Lệnh nghiệm thu | TEST-ID liên quan | Commit xanh gần nhất |
|---|---|---|---|---|
| `packages/contracts` | api_client_ts, shared_models, apps/api, admin-web, staff_app, customer_app | `pnpm --dir packages/contracts run check` (Git Bash, cwd gốc repo) | — | (CP01, xem checkpoints/CP01.md) |
| `packages/money_weight` | apps/api (pos, app-orders, wholesale, reporting), staff_app, customer_app, admin-web | MISSING | TEST-POS-001, TEST-APPORD-001, TEST-WS-001 | — |
| `api: auth, rbac` | mọi module API, viewer | MISSING | TEST-VIEWER-001, TEST-VIEWER-002 | — |
| `api: audit, outbox, files` | mọi module ghi, worker | MISSING | — | — |
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
| `infra/sql` (trigger, RLS, role) | inventory, reporting, viewer, audit | MISSING | TEST-VIEWER-002 | — |
| `apps/admin-web` | — | MISSING | — | — |
| `apps/staff_app` | — | MISSING | — | — |
| `apps/customer_app` | — | MISSING | — | — |
