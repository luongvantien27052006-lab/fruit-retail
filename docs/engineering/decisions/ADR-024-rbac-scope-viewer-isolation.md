# ADR-024: RBAC theo phạm vi cửa hàng, hạn mức duyệt từ dữ liệu, cô lập Viewer (CP03 lát 6)

- Trạng thái: accepted (kỹ thuật) · Ngày: 2026-11-26 · Người quyết: phiên điều phối (CP03 lát 6) — chờ agent
  security-reviewer + database-reviewer kiểm
- Làm rõ: ADR-006/011 (role DB, RLS viewer), ADR-012 (quyền tra mỗi request), ADR-022 (thiết bị POS), NC-19, NC-21

## Quyết định
1. **Khai báo quyền khớp hợp đồng.** `@RequirePermission(code, { scope: 'store' })` = `x-scope: store`; `@MasterOnly()`
   = `x-master-only`; `@RequireStepUp()` = `x-step-up`. Test `contract-access.test.ts` đối chiếu MỌI route đã hiện thực
   với OpenAPI (quyền, phạm vi, chỉ-Master, step-up) — route quên phạm vi / quên chỉ-Master ⇒ CI đỏ. Đã bắt được: PUT
   `/admin/approval-limits` thiếu `x-master-only`; `/admin/pos-devices/{id}/activate|revoke` thiếu `x-scope`.
2. **`ScopeService`** (một nguồn cho mọi route có phạm vi): phạm vi của MỘT mã quyền = ALL nếu có vai trò/cấp riêng
   phạm vi ALL mang mã đó, ngược lại tập cửa hàng của các dòng STORE mang mã đó; nhớ trong request. Nhân viên trên máy
   POS: giao với cửa hàng của thiết bị — cửa hàng trưởng của 2 cửa hàng đứng ở máy cửa hàng A chỉ thao tác cửa hàng A.
   Ngoài phạm vi ⇒ 404 (không lộ tài nguyên cửa hàng khác tồn tại).
3. **Phiên nhân viên gắn cửa hàng của thiết bị** (PrincipalResolver, mỗi request): chỉ vai trò / quyền cấp riêng phạm vi
   ALL hoặc đúng cửa hàng của thiết bị mang quyền vào phiên; không còn vai trò nào ở đó ⇒ `SESSION_REVOKED` ngay (trước:
   chờ refresh — ghi nhận 8 lát 4); cửa hàng ngừng/lưu trữ ⇒ phiên chết, đăng nhập PIN 401 chung, không kích hoạt được
   thiết bị (ghi nhận 5 lát 4).
4. **Hạn mức duyệt đọc từ dữ liệu** (`ApprovalLimitsService`, `decide()`): không có hằng số hạn mức trong code; không có
   dòng = không được làm; 1 ngưỡng ⇒ phải đạt; 2 ngưỡng ⇒ ANY (một) / ALL (cả hai); thiếu dữ liệu để so ⇒ từ chối; số
   nguyên (`amount·10000 ≤ pct·base`). Nhiều vai trò: cho phép nếu một vai trò cho phép, chọn dòng ít yêu cầu nhất
   (PIN/ghi chú). Master sửa qua `PUT /admin/approval-limits` (chỉ Master, step-up, audit trước/sau); CHECK DB chặn cấu
   hình đã bỏ (NC-19(d), NC-21) ⇒ 400. CP07/CP10/CP17 gọi service này.
5. **Quản lý nhân viên** (`/admin/staff`, `/admin/role-assignments`):
   - Master: mọi nhân viên, gán mọi vai trò nhân viên (STORE_MANAGER, CASHIER, PICKER, SHIPPER ở cửa hàng; WAREHOUSE_STAFF
     ở kho). Vai trò admin không gán ở đây (lát 8 `/admin/admin-accounts`).
   - Cửa hàng trưởng (§2.2): chỉ nhân viên mà MỌI vai trò đang hiệu lực là CASHIER/PICKER ở cửa hàng trong phạm vi; chỉ
     gán/gỡ CASHIER, PICKER ở cửa hàng mình.
   - Không ai tự sửa / tự gán / tự gỡ vai trò của chính mình. PIN băm Argon2id TRƯỚC transaction (`@OwnTransaction`); PIN
     dễ đoán (6 số lặp, dãy tăng/giảm vòng, cặp/ba lặp, vài PIN phổ biến) ⇒ 400 (ghi nhận lát 4). Đổi PIN / khóa ⇒ thu
     hồi mọi phiên (`PIN_RESET`, `USER_DISABLED`).
6. **Step-up chỉ cho tài khoản có 2FA** (Master/Viewer — đã đổi, xem "Sửa theo kiểm thử agent lần 1" L4): nhân viên (cửa hàng trưởng đăng nhập PIN trên máy POS đã kích
   hoạt) không có 2FA nên không có step-up; route họ gọi được đều có phạm vi cửa hàng + vai trò hẹp. SEC2 không liệt kê
   gán vai trò nhân viên — chỉ "tài khoản admin".
7. **Cô lập Viewer** (§2.5 lớp 3–4, T16, T17):
   - Guard: tài khoản VIEWER chỉ gọi `/v1/viewer/*` và `/v1/auth/*` (mọi route khác 403 dù có mã quyền); `/v1/viewer/*`
     chỉ cho VIEWER đã gán **đúng một** hồ sơ chưa lưu trữ (0 hoặc nhiều ⇒ 403 — chọn hồ sơ theo request là việc CP12).
   - Trong route viewer, MỌI truy vấn qua pool `app_rw` (TX_PRISMA) bị chặn (cờ CLS `appDbBlocked`) — chỉ đọc qua
     `ViewerDb`: pool riêng `DATABASE_URL_VIEWER`, mỗi lần đọc một transaction READ ONLY với
     `set_config('app.viewer_profile_id', id, true)`; kết nối không phải `viewer_ro` ⇒ từ chối (không âm thầm đọc bằng role
     rộng hơn); thiếu URL ⇒ 503.

## Sửa theo kiểm thử agent lần 1 (98cda64)
**security-reviewer:**
- **L1 (TB):** người không có phạm vi ALL (cửa hàng trưởng) không mở lại tài khoản bị khóa, không xóa/lùi ngày nghỉ đã
  đặt, không đổi PIN của nhân viên đã khóa/đã có ngày nghỉ (403) — chỉ được khóa, ghi ngày nghỉ lần đầu, đổi tên, đổi PIN
  nhân viên đang hoạt động. Không đảo được quyết định của Master.
- **L2 (TB):** nhân viên có quyền cấp riêng đang hiệu lực ⇒ chỉ phạm vi ALL quản lý (list + `managed()`), chặn đặt lại PIN
  để mượn quyền rộng hơn mình.
- **L3 (Thấp):** `POST /admin/staff` (gán vai trò kèm khi tạo) cần thêm `role:assign` và `x-step-up` — cùng rào với
  `/admin/role-assignments`.
- **L4 (Thấp):** step-up giờ **mặc định chặn** tài khoản không có 2FA (403 `STEP_UP_REQUIRED`); chỉ miễn khi route khai
  báo `@RequireStepUp({ staffExempt: lý do })` — hiện có `POST /admin/staff`, `/admin/role-assignments` (POST, DELETE).
  Thay mục 6.
- **L5 (Thấp):** kiểm route viewer/auth gồm cả đường dẫn gốc (`/v1/viewer`, `/v1/auth`).
- Ghi nhận đã làm: gỡ vai trò cũng yêu cầu người bị gỡ thuộc `managed()`; hạn mức từ chối số âm.
- Ghi nhận chấp nhận: tạo nhân viên trùng mã trả 409 ⇒ người có `staff:write` dò được mã NV (SEC5 + PIN yếu giảm nhẹ);
  danh sách `take 500` chưa phân trang (lát 8); route ghi của viewer (CP12) cần thiết kế lại vì app pool bị chặn.

**database-reviewer:**
- **L1 (TB):** đổi PIN / khóa lấy CÙNG advisory lock `auth:<id>` với lần thử đăng nhập (trước khóa dòng users — cùng thứ
  tự) ⇒ đăng nhập PIN cũ đang chạy commit trước rồi bị thu hồi luôn; test đua 3 vòng.
- **L2 (Thấp):** khóa phiên `ORDER BY id FOR UPDATE` trước khi thu hồi (cùng thứ tự với thu hồi thiết bị) ⇒ không 40P01.
- **L3 (Thấp):** `ViewerDb` hủy kết nối khi ROLLBACK lỗi; kiểm `current_user = viewer_ro` ở MỌI transaction.
- Ghi nhận đã làm: PUT hạn mức khóa dòng trước khi đọc "before" cho audit.

## Sửa theo kiểm thử agent lần 2 (7b73605)
security-reviewer: **SẠCH**. database-reviewer: còn L1' (TB) + 2 Thấp — đã sửa:
- **L1' (TB):** đăng nhập PIN đọc LẠI `pin_hash` + `left_at` trong transaction đang giữ khóa `auth:<id>` (mã băm đọc trước khi chờ suất Argon có
  thể đã cũ); PIN đã đổi ⇒ PIN cũ là PIN sai (đếm sai, cùng thời gian nhờ Argon giả).
- Thấp: khóa advisory dựng từ `id::uuid::text` (UUID chữ hoa ở URL không tạo khóa khác); PUT hạn mức khóa theo thứ tự role:action.
- Ghi nhận security làm luôn: người không có phạm vi ALL không đổi `status` khi nhân viên đang khác ACTIVE (giữ dấu LOCKED của
  Master); kiểm ngày lịch thật (2026-13-01, 2026-02-30 ⇒ 400); test hợp đồng có danh sách trắng route `staffExempt`.
- Ghi nhận chấp nhận: cửa hàng trưởng tạo/đổi PIN thu ngân rồi đăng nhập thay được (dùng `pos:sell`… của thu ngân) — đúng §2.2
  (SM tạo CASHIER/PICKER), giới hạn cửa hàng của máy, có nhật ký. Route cấp quyền riêng (lát 8) phải khóa dòng users FOR UPDATE.

## Để lát sau
- Route `/viewer/*` thật (projection, snapshot), 2 route ghi của viewer qua `viewer_act`: CP12.
- `/admin/admin-accounts`, khóa/mở khóa, reset 2FA, phiên của người khác, nhật ký, cấu hình: lát 8.
- Phạm vi kho (`x-scope: warehouse`) và thiết bị kho: CP06/CP07.

## Hệ quả
- Không migration. OpenAPI: schema `Staff*`, `RoleAssignment*`, `ApprovalLimit*`; `x-master-only` cho approval-limits;
  `x-scope: store` cho activate/revoke thiết bị. Env dùng thêm `DATABASE_URL_VIEWER` (đã có trong §19.4).
