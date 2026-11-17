# ADR-011: Ma trận quyền DB, audit cùng transaction, RLS theo hồ sơ (thay một phần ADR-006)

- Trạng thái: accepted · Thay thế: ADR-006 phần "Role đăng nhập", "RLS", "trigger snapshots"
- Ngày: 2026-11-17 · Người quyết: phiên điều phối (sửa theo review CP01) · Căn cứ: FR-INV-05/10/11/12, SPEC §2.5, §3.3, §10.3–10.5, §12.4

## Bối cảnh
Review CP01 phát hiện ADR-006 không chạy được: (1) audit ghi bằng kết nối `audit_writer` riêng nên không cùng
transaction với nghiệp vụ (trái FR-INV-10); (2) `ALTER DEFAULT PRIVILEGES` tự mở mọi bảng `reporting` mới cho viewer,
kể cả bảng giá vốn; (3) RLS chỉ có policy cho `viewer_ro` nên projector/Master bị chặn; (4) function mặc định
`EXECUTE` cho PUBLIC; (5) RLS chỉ lọc theo cửa hàng, không theo hồ sơ/`cost_basis`; (6) trigger chỉ-thêm trên
`snapshots` chặn thu hồi.

## Quyết định

### Role
| Role | Dùng bởi | Quyền |
|---|---|---|
| `owner` | migration (`DATABASE_URL_MIGRATE`, chỉ CI/deploy) | sở hữu schema; không dùng lúc chạy app |
| `app_rw` | API `main.ts` + consumer nghiệp vụ của worker | SELECT/INSERT/UPDATE `core` (DELETE chỉ bảng nháp được liệt kê); **chỉ INSERT** `audit.logs`, `audit.export_logs`; INSERT/SELECT + UPDATE theo cột ở `integration` (xem dưới); SELECT `reporting` (Master đọc báo cáo) |
| `projector_rw` | projector của worker | SELECT `core` theo danh sách bảng nguồn; INSERT/UPDATE/DELETE `reporting.live_*`, `reporting.daily_revenue`, `reporting.live_sales_hourly_cost`; INSERT `integration.processed_events` |
| `viewer_ro` | route `/v1/viewer/*` (đọc) | USAGE `reporting`; SELECT **theo allowlist từng bảng**; EXECUTE `reporting.allowed_stores`, `reporting.current_profile`; không gì trên `core`, `audit`, `integration`, `reporting_private` |
| `viewer_act` | 2 route ghi của viewer (`/viewer/files/{id}/download`, `/viewer/notifications/{id}/read`) | chỉ INSERT `reporting_private.viewer_file_requests`, `reporting_private.viewer_notification_reads`, `audit.viewer_access`; không SELECT bảng dữ liệu |
| `audit_writer` | log ngoài transaction nghiệp vụ (`audit.login_logs`) | chỉ INSERT |

- **Audit cùng transaction:** `app_rw` INSERT `audit.logs` trong chính transaction nghiệp vụ; không có UPDATE/DELETE;
  trigger chỉ-thêm vẫn bật. Bỏ client Prisma `audit_writer` khỏi đường nghiệp vụ.
- **Không default privilege nào cho `viewer_ro`/`viewer_act`.** `REVOKE ALL ON SCHEMA public FROM PUBLIC`;
  `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA core, reporting, audit, integration FROM PUBLIC`;
  `ALTER DEFAULT PRIVILEGES FOR ROLE owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`.
- **Bảng chỉ-thêm** (`core.stock_movements`, `core.app_order_events`, `core.wholesale_receivables`,
  `core.shipper_cod_ledger`, `core.cash_entries`, `audit.*`, `reporting.snap_*`): REVOKE UPDATE, DELETE từ mọi role;
  trigger `raise_immutable()`.
- **`integration` UPDATE theo cột:** `outbox(published_at, attempts, last_error, next_attempt_at)`,
  `webhook_inbox(processed_at, result)`, `idempotency_keys(status, response, completed_at)`,
  `external_calls(status, response, ms)`. Không role nào sửa `payload`/`body`.
- **Function SECURITY DEFINER:** luôn `SET search_path = pg_catalog, <schema>`; GRANT EXECUTE tường minh từng role.

### RLS
- Mọi bảng `reporting.*` viewer được SELECT đều `ENABLE` + `FORCE ROW LEVEL SECURITY`.
- Policy: `FOR ALL TO projector_rw USING (true) WITH CHECK (true)`; `FOR SELECT TO app_rw USING (true)`;
  viewer theo dưới. `reporting.current_profile()` = `NULLIF(current_setting('app.viewer_profile_id', true), '')::uuid`
  → thiếu setting trả NULL → 0 dòng (không lỗi).
- Đặt hồ sơ bằng `SELECT set_config('app.viewer_profile_id', $1, true)` trong interactive transaction (không dùng
  `SET LOCAL` với tham số).
- **`live_*`, `daily_revenue`:** `store_id = ANY(reporting.allowed_stores(reporting.current_profile()))`. Mọi bảng
  `live_*` bắt buộc có `store_id` (kể cả `live_stock`; tồn kho tổng không hiện cho viewer).
- **`snapshots`:** `reporting.current_profile() = ANY(viewer_profile_ids) AND status IN ('PUBLISHED','SUPERSEDED')`
  (SPEC T19: viewer thấy lịch sử phiên bản); `REVOKED` chỉ hiện dòng tóm tắt qua view `snapshots_public`
  (id, version, status, revoked_at) không có `summary`/`file_ids`.
- **`snap_*`:** `EXISTS (SELECT 1 FROM reporting.snapshots s WHERE s.id = snapshot_id AND <điều kiện trên>)` +
  lọc `store_id` khi bảng có cột này.
- Trigger: snapshot có hồ sơ `SHAREHOLDER` trong `viewer_profile_ids` thì `cost_basis <> 'STANDARD'` (FR-INV-12).
- `reporting.allowed_stores()` đọc `reporting_private.viewer_profile_scopes` (schema viewer không có USAGE).
- `reporting.snapshots`: trigger cho phép UPDATE **chỉ** `status` theo `PUBLISHED → REVOKED | SUPERSEDED` (kèm
  `revoked_by`, `revoked_at`, `revoke_reason`); mọi cột khác bất biến; `UNIQUE(supersedes_id)`, `checksum NOT NULL`.
- Bảng cấm viewer: `reporting.standard_cost_matrix`, `reporting.live_sales_hourly_cost` — không GRANT.

### Kiểm tra bắt buộc (CI, PostgreSQL thật)
- Mọi bảng `viewer_ro` có SELECT ⇒ `relrowsecurity = true` và có policy cho `viewer_ro`.
- `has_table_privilege('viewer_ro', t, 'SELECT') = false` cho bảng giá vốn và mọi bảng ngoài allowlist.
- `has_function_privilege('viewer_ro', f, 'EXECUTE') = false` cho mọi function ngoài 2 function được phép.
- `has_table_privilege(r, 'core.stock_movements', 'UPDATE'|'DELETE') = false` với mọi role.

## Phương án đã cân nhắc
| Phương án | Lý do loại |
|---|---|
| `GRANT audit_writer TO app_rw` + `SET LOCAL ROLE` | Thêm bước dễ quên, lỗi khó thấy; INSERT trực tiếp đủ khi có trigger + REVOKE |
| Default privileges + REVOKE thủ công | "Mặc định cho phép" — một lần quên là lộ giá vốn |

## Hệ quả
- §19.4 thêm `DATABASE_URL_MIGRATE`, `DATABASE_URL_VIEWER_ACT`; bỏ `DATABASE_URL_AUDIT` khỏi đường nghiệp vụ (giữ cho
  login log).
- ERD cập nhật (mục 2.3, 2.4, 6). Migration `003_roles.sql`, `040_reporting_grants.sql`, `042_viewer_rls.sql` theo ADR
  này. Test TEST-VIEWER-002 mở rộng thành bộ kiểm `pg_catalog` trên.
