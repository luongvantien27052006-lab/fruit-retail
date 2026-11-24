-- 0002_auth_totp_replay — CP03 lát 3 (ADR-021). Phần 1: DDL do Prisma sinh (migrate diff từ DB đã áp 0001).
-- AlterTable
ALTER TABLE "core"."users" ADD COLUMN     "totp_last_step" BIGINT;

-- ─────────── Phần 2: SQL tay ───────────
-- Bước TOTP chỉ tăng (mã đã dùng không dùng lại được, kể cả khi hai request song song — điều kiện nằm ở UPDATE của
-- server, CHECK chặn giá trị vô lý). Đăng ký lại 2FA (reset) đặt về NULL.
ALTER TABLE core.users
  ADD CONSTRAINT users_totp_last_step CHECK (totp_last_step IS NULL OR (totp_last_step >= 0 AND totp_enabled_at IS NOT NULL));
GRANT UPDATE (totp_last_step) ON core.users TO app_rw;
