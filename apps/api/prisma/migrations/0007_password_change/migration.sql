-- 0007_password_change — CP03 lát 8b, NC-22 (Tiến duyệt 2026-11-27): đổi mật khẩu; mật khẩu tạm phải đổi trước khi đăng ký 2FA.
-- Phần 1: DDL theo schema.prisma.
-- AlterTable
ALTER TABLE "core"."users" ADD COLUMN     "must_change_password" BOOLEAN NOT NULL DEFAULT false;

-- ─────────── Phần 2: SQL tay ───────────
-- Chỉ tài khoản đăng nhập bằng mật khẩu (Master/Viewer) mới có cờ này.
ALTER TABLE core.users
  ADD CONSTRAINT users_must_change_password CHECK (NOT must_change_password OR type IN ('MASTER', 'VIEWER'));
GRANT UPDATE (must_change_password) ON core.users TO app_rw;
