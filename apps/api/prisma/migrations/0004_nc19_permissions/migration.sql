-- 0004_nc19_permissions — Tiến quyết NC-19 và NC-21 (2026-11-26). Chỉ dữ liệu seed + CHECK, không đổi bảng/cột
-- (Prisma không có phần DDL sinh tự động).
--
-- NC-19 chốt: (a) cửa hàng trưởng KHÔNG có pos:sell / pos:void_line / app_order:manage (đọc chặt §2.2 — đã seed ở 0001);
-- (b)(d)(e)(g) giữ nguyên như 0001; (c) hạn mức "A hoặc B" = đạt MỘT ngưỡng (limit_mode ANY — đã seed); (f) thêm 2 mã.
-- NC-21: bỏ hẳn giảm giá tay trên dòng ở POS (giá bán chỉ theo bảng giá admin đặt); giảm giá cận hạn theo lô (§5.8)
-- chỉ Master duyệt — cửa hàng trưởng chỉ xem/đề xuất.

-- (f) mã mới: xem vùng giao hàng, xem log thao tác thu ngân (§2.2 ô "R" của cửa hàng trưởng)
INSERT INTO core.permissions (code, description, added_outside_spec) VALUES
  ('zone:read', 'Xem vùng giao hàng (NC-19)', true),
  ('pos_log:read', 'Xem log thao tác thu ngân: xóa dòng, cân tay, hủy hóa đơn, mở két (NC-19)', true);
INSERT INTO core.role_permissions (role, permission_code) VALUES
  ('MASTER_ADMIN', 'zone:read'),
  ('MASTER_ADMIN', 'pos_log:read'),
  ('STORE_MANAGER', 'zone:read'),
  ('STORE_MANAGER', 'pos_log:read');

-- NC-21: bỏ giảm giá tay. Còn dòng cấp riêng (user_permission_grants) nào trỏ tới mã này ⇒ FK RESTRICT làm migration
-- dừng (không âm thầm xóa vết cấp quyền).
DELETE FROM core.role_permissions WHERE permission_code = 'pos:discount';
DELETE FROM core.permissions WHERE code = 'pos:discount';
DELETE FROM core.approval_limits WHERE action = 'LINE_DISCOUNT';

-- NC-21: giảm giá cận hạn chỉ Master duyệt
DELETE FROM core.role_permissions WHERE role = 'STORE_MANAGER' AND permission_code = 'markdown:approve';
DELETE FROM core.approval_limits WHERE role = 'STORE_MANAGER' AND action = 'MARKDOWN';

-- Không cho cấu hình quay lại qua màn hạn mức (app_rw có INSERT/UPDATE trên approval_limits). Giá trị enum LINE_DISCOUNT
-- vẫn còn trong kiểu (PostgreSQL không bỏ được giá trị enum an toàn) nhưng không dòng nào dùng được.
ALTER TABLE core.approval_limits
  ADD CONSTRAINT approval_limits_no_line_discount CHECK (action <> 'LINE_DISCOUNT'),
  ADD CONSTRAINT approval_limits_markdown_master_only CHECK (action <> 'MARKDOWN' OR role = 'MASTER_ADMIN');
