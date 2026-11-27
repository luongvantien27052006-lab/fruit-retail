-- 0008_auth_lockouts — CP03 lát 10, sửa review an ninh cổng CP03 (Tiến duyệt 2026-11-27): khóa theo (tài khoản, nguồn),
-- xác thực lại trong phiên đếm riêng (ADR-030).
-- Phần 1: DDL theo schema.prisma (định dạng migrate diff).
-- AlterTable
ALTER TABLE "core"."sessions" ADD COLUMN     "reauth_failed_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "core"."users" ADD COLUMN     "fail_window_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fail_window_start" TIMESTAMPTZ(6),
ADD COLUMN     "trust_epoch" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "core"."auth_lockouts" (
    "user_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "lock_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_lockouts_pkey" PRIMARY KEY ("user_id","source")
);

-- CreateIndex
CREATE INDEX "auth_lockouts_user_id_locked_until_idx" ON "core"."auth_lockouts"("user_id", "locked_until");

-- AddForeignKey
ALTER TABLE "core"."auth_lockouts" ADD CONSTRAINT "auth_lockouts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────── Phần 2: SQL tay ───────────
ALTER TABLE core.auth_lockouts
  ADD CONSTRAINT auth_lockouts_source CHECK (source ~ '^(ip:[A-Za-z0-9_-]{22}|cli:[A-Za-z0-9_-]{22}|dev:[0-9a-f-]{36}|mfa)$'),
  ADD CONSTRAINT auth_lockouts_counts CHECK (failed_count BETWEEN 0 AND 4 AND lock_count >= 0);
ALTER TABLE core.sessions
  ADD CONSTRAINT sessions_reauth_failed CHECK (reauth_failed_count BETWEEN 0 AND 5);
-- default privileges của schema core cấp UPDATE cả bảng (kể cả khóa chính) ⇒ thu lại, cấp theo cột
REVOKE UPDATE, TRUNCATE ON core.auth_lockouts FROM app_rw;
GRANT SELECT, INSERT, DELETE ON core.auth_lockouts TO app_rw;
GRANT UPDATE (failed_count, lock_count, locked_until, updated_at) ON core.auth_lockouts TO app_rw;
GRANT UPDATE (reauth_failed_count) ON core.sessions TO app_rw;
ALTER TABLE core.users ADD CONSTRAINT users_fail_window CHECK (fail_window_count >= 0);
GRANT UPDATE (fail_window_count, fail_window_start, trust_epoch) ON core.users TO app_rw;
