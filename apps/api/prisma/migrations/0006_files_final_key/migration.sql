-- 0006_files_final_key — CP03 lát 7, sửa theo kiểm thử silent-failure lần 2 (ADR-025).
-- Phần 1: DDL theo schema.prisma.
-- AlterTable
ALTER TABLE "core"."files" ADD COLUMN     "final_key" TEXT;

-- ─────────── Phần 2: SQL tay ───────────
-- Khóa object CUỐI của file READY: mỗi lần complete chép sang khóa riêng (hậu tố ngẫu nhiên) rồi mới kiểm sha256 trên
-- bản chép; chỉ lần thắng (giữ khóa dòng, còn PENDING) ghi final_key — hai complete song song không ghi đè lên nhau.
ALTER TABLE core.files
  ADD CONSTRAINT files_final_key CHECK ((status = 'READY') = (final_key IS NOT NULL));
CREATE UNIQUE INDEX files_final_key_key ON core.files (final_key) WHERE final_key IS NOT NULL;
GRANT UPDATE (final_key) ON core.files TO app_rw;
