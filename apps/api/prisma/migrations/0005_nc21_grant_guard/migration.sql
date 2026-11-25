-- 0005_nc21_grant_guard — sửa theo kiểm thử agent (database-reviewer) của NC-19/NC-21. Chỉ CHECK, không đổi bảng/cột.
--
-- 1) NC-21(2): duyệt giảm giá cận hạn chỉ Master. 0004 bỏ markdown:approve khỏi vai trò cửa hàng trưởng, nhưng quyền
--    cấp riêng (user_permission_grants, chỉ cho STAFF) vẫn trao lại được ⇒ cấm hẳn mã này trong bảng cấp riêng.
--    Còn quyền cấp riêng markdown:approve ĐANG HIỆU LỰC ⇒ dừng migration (không âm thầm thu hồi — cần người quyết).
--    Dòng đã thu hồi (lịch sử) được giữ: CHECK thêm NOT VALID rồi chỉ chặn dòng mới / dòng bị sửa.
-- 2) NC-19(d): Master không xóa dòng trước thanh toán (LINE_DELETE) và không mở két không bán (NO_SALE_OPEN) — §2.3
--    "—". Trước đây chỉ dựa vào "không có dòng hạn mức"; app_rw có INSERT trên approval_limits ⇒ chặn bằng CHECK.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM core.user_permission_grants WHERE permission_code = 'markdown:approve' AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Còn quyền cấp riêng markdown:approve đang hiệu lực — thu hồi trước khi áp 0005 (NC-21)';
  END IF;
END $$;

ALTER TABLE core.user_permission_grants
  ADD CONSTRAINT upg_no_markdown_approve CHECK (permission_code <> 'markdown:approve') NOT VALID;

ALTER TABLE core.approval_limits
  ADD CONSTRAINT approval_limits_master_forbidden CHECK (NOT (role = 'MASTER_ADMIN' AND action IN ('LINE_DELETE', 'NO_SALE_OPEN')));
