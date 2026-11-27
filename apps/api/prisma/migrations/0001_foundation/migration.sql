-- 0001_foundation — nhóm M02 + M03 tối thiểu (CP03 lát 1). Phần 1: DDL do Prisma sinh
-- (prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script), BỎ bảng integration.sql_migrations
-- (đã tạo bởi infra/sql/000 — ADR-020). Phần 2: SQL tay ở cuối file.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "audit";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "core";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "integration";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "reporting_private";

-- CreateEnum
CREATE TYPE "core"."UserType" AS ENUM ('MASTER', 'VIEWER', 'STAFF', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "core"."UserStatus" AS ENUM ('ACTIVE', 'LOCKED', 'DISABLED');

-- CreateEnum
CREATE TYPE "core"."Role" AS ENUM ('MASTER_ADMIN', 'VIEW_ONLY_ADMIN', 'STORE_MANAGER', 'CASHIER', 'PICKER', 'WAREHOUSE_STAFF', 'SHIPPER', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "core"."ScopeType" AS ENUM ('ALL', 'STORE', 'WAREHOUSE');

-- CreateEnum
CREATE TYPE "core"."StoreStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "core"."PosDeviceStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "core"."AuthChallengeKind" AS ENUM ('MFA', 'DEVICE_NONCE');

-- CreateEnum
CREATE TYPE "core"."ApprovalAction" AS ENUM ('LINE_DELETE', 'LINE_DISCOUNT', 'SALE_VOID', 'REFUND', 'SPOILAGE_APPROVE', 'STOCKTAKE_ADJUST', 'MANUAL_WEIGHT', 'NO_SALE_OPEN', 'MARKDOWN');

-- CreateEnum
CREATE TYPE "core"."FileStatus" AS ENUM ('PENDING', 'READY', 'REJECTED');

-- CreateTable
CREATE TABLE "core"."stores" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "status" "core"."StoreStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."warehouses" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."registers" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."users" (
    "id" UUID NOT NULL,
    "type" "core"."UserType" NOT NULL,
    "email" TEXT,
    "phone_enc" BYTEA,
    "phone_hash" BYTEA,
    "password_hash" TEXT,
    "pin_hash" TEXT,
    "totp_secret_enc" BYTEA,
    "totp_enabled_at" TIMESTAMPTZ(6),
    "status" "core"."UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "lock_count" INTEGER NOT NULL DEFAULT 0,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."staff" (
    "user_id" UUID NOT NULL,
    "staff_code" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "hired_at" DATE,
    "left_at" DATE,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "core"."staff_badges" (
    "id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "badge_code_hash" BYTEA NOT NULL,
    "issued_by" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "staff_badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."permissions" (
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "added_outside_spec" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "core"."role_permissions" (
    "role" "core"."Role" NOT NULL,
    "permission_code" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role","permission_code")
);

-- CreateTable
CREATE TABLE "core"."user_role_assignments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "core"."Role" NOT NULL,
    "scope_type" "core"."ScopeType" NOT NULL,
    "scope_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_by" UUID,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."user_permission_grants" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "permission_code" TEXT NOT NULL,
    "scope_type" "core"."ScopeType" NOT NULL,
    "scope_id" UUID,
    "granted_by" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_by" UUID,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_permission_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."approval_limits" (
    "role" "core"."Role" NOT NULL,
    "action" "core"."ApprovalAction" NOT NULL,
    "allowed" BOOLEAN NOT NULL DEFAULT true,
    "max_amount" BIGINT,
    "max_pct_bp" INTEGER,
    "limit_mode" TEXT NOT NULL DEFAULT 'ANY',
    "same_day_only" BOOLEAN NOT NULL DEFAULT false,
    "requires_pin" BOOLEAN NOT NULL DEFAULT false,
    "requires_note" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "approval_limits_pkey" PRIMARY KEY ("role","action")
);

-- CreateTable
CREATE TABLE "core"."pos_devices" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "register_id" UUID,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "fingerprint" BYTEA NOT NULL,
    "status" "core"."PosDeviceStatus" NOT NULL DEFAULT 'PENDING',
    "registered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_by" UUID,
    "activated_at" TIMESTAMPTZ(6),
    "revoked_by" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_reason" TEXT,
    "last_seen_at" TIMESTAMPTZ(6),

    CONSTRAINT "pos_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "user_type" "core"."UserType" NOT NULL,
    "pos_device_id" UUID,
    "client_device" TEXT,
    "amr" TEXT[],
    "step_up_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_reason" TEXT,
    "ip_hash" BYTEA,
    "user_agent" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."refresh_tokens" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ(6),
    "replaced_by_id" UUID,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."auth_challenges" (
    "id" UUID NOT NULL,
    "kind" "core"."AuthChallengeKind" NOT NULL,
    "user_id" UUID,
    "pos_device_id" UUID,
    "secret_hash" BYTEA NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "auth_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."otp_challenges" (
    "id" UUID NOT NULL,
    "phone_hash" BYTEA NOT NULL,
    "device_id" TEXT,
    "ip_hash" BYTEA,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."viewer_profiles" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "all_stores" BOOLEAN NOT NULL DEFAULT false,
    "modules" TEXT[],
    "customer_visibility" TEXT NOT NULL,
    "cost_visibility" TEXT NOT NULL,
    "supplier_visibility" TEXT NOT NULL,
    "pos_control_visibility" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "viewer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."viewer_profile_assignments" (
    "user_id" UUID NOT NULL,
    "viewer_profile_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "viewer_profile_assignments_pkey" PRIMARY KEY ("user_id","viewer_profile_id")
);

-- CreateTable
CREATE TABLE "reporting_private"."viewer_profile_scopes" (
    "profile_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,

    CONSTRAINT "viewer_profile_scopes_pkey" PRIMARY KEY ("profile_id","store_id")
);

-- CreateTable
CREATE TABLE "core"."files" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "owner_type" TEXT,
    "owner_id" UUID,
    "storage_key" TEXT NOT NULL,
    "declared_bytes" INTEGER NOT NULL,
    "declared_sha256" BYTEA NOT NULL,
    "bytes" INTEGER,
    "sha256" BYTEA,
    "status" "core"."FileStatus" NOT NULL DEFAULT 'PENDING',
    "reject_reason" TEXT,
    "duplicate_of_id" UUID,
    "capture_source" TEXT,
    "captured_at" TIMESTAMPTZ(6),
    "device_id" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit"."logs" (
    "id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "actor_type" TEXT,
    "role" TEXT,
    "ip" INET,
    "device_id" TEXT,
    "request_id" TEXT,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,

    CONSTRAINT "logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit"."login_logs" (
    "id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID,
    "identifier_hash" BYTEA,
    "result" TEXT NOT NULL,
    "ip" INET,
    "device" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "login_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit"."export_logs" (
    "id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID NOT NULL,
    "export_type" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "rows" INTEGER NOT NULL,
    "file_id" UUID,

    CONSTRAINT "export_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit"."viewer_access" (
    "id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "resource" TEXT NOT NULL,
    "snapshot_id" UUID,

    CONSTRAINT "viewer_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration"."outbox" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "dead_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration"."processed_events" (
    "consumer" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer","event_id")
);

-- CreateTable
-- CreateTable
CREATE TABLE "integration"."idempotency_keys" (
    "scope" TEXT NOT NULL,
    "key" UUID NOT NULL,
    "request_hash" BYTEA NOT NULL,
    "status" TEXT NOT NULL,
    "response_status" INTEGER,
    "response" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("scope","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "stores_code_key" ON "core"."stores"("code");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_code_key" ON "core"."warehouses"("code");

-- CreateIndex
CREATE UNIQUE INDEX "registers_store_id_code_key" ON "core"."registers"("store_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "registers_id_store_id_key" ON "core"."registers"("id", "store_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "core"."users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_hash_key" ON "core"."users"("phone_hash");

-- CreateIndex
CREATE INDEX "recovery_codes_user_id_idx" ON "core"."recovery_codes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_staff_code_key" ON "core"."staff"("staff_code");

-- CreateIndex
CREATE UNIQUE INDEX "staff_badges_badge_code_hash_key" ON "core"."staff_badges"("badge_code_hash");

-- CreateIndex
CREATE INDEX "staff_badges_staff_id_idx" ON "core"."staff_badges"("staff_id");

-- CreateIndex
CREATE INDEX "role_permissions_permission_code_idx" ON "core"."role_permissions"("permission_code");

-- CreateIndex
CREATE INDEX "user_role_assignments_user_id_idx" ON "core"."user_role_assignments"("user_id");

-- CreateIndex
CREATE INDEX "user_role_assignments_scope_type_scope_id_idx" ON "core"."user_role_assignments"("scope_type", "scope_id");

-- CreateIndex
CREATE INDEX "user_permission_grants_user_id_idx" ON "core"."user_permission_grants"("user_id");

-- CreateIndex
CREATE INDEX "user_permission_grants_permission_code_idx" ON "core"."user_permission_grants"("permission_code");

-- CreateIndex
CREATE UNIQUE INDEX "pos_devices_fingerprint_key" ON "core"."pos_devices"("fingerprint");

-- CreateIndex
CREATE INDEX "pos_devices_store_id_idx" ON "core"."pos_devices"("store_id");

-- CreateIndex
CREATE INDEX "pos_devices_register_id_idx" ON "core"."pos_devices"("register_id");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "core"."sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_pos_device_id_idx" ON "core"."sessions"("pos_device_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "core"."sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "core"."refresh_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_replaced_by_id_key" ON "core"."refresh_tokens"("replaced_by_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_session_id_idx" ON "core"."refresh_tokens"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_challenges_secret_hash_key" ON "core"."auth_challenges"("secret_hash");

-- CreateIndex
CREATE INDEX "auth_challenges_expires_at_idx" ON "core"."auth_challenges"("expires_at");

-- CreateIndex
CREATE INDEX "auth_challenges_user_id_idx" ON "core"."auth_challenges"("user_id");

-- CreateIndex
CREATE INDEX "auth_challenges_pos_device_id_idx" ON "core"."auth_challenges"("pos_device_id");

-- CreateIndex
CREATE INDEX "otp_challenges_phone_hash_created_at_idx" ON "core"."otp_challenges"("phone_hash", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "viewer_profiles_code_key" ON "core"."viewer_profiles"("code");

-- CreateIndex
CREATE INDEX "viewer_profile_assignments_viewer_profile_id_idx" ON "core"."viewer_profile_assignments"("viewer_profile_id");

-- CreateIndex
CREATE INDEX "viewer_profile_scopes_store_id_idx" ON "reporting_private"."viewer_profile_scopes"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "files_storage_key_key" ON "core"."files"("storage_key");

-- CreateIndex
CREATE INDEX "files_sha256_idx" ON "core"."files"("sha256");

-- CreateIndex
CREATE INDEX "files_created_by_idx" ON "core"."files"("created_by");

-- CreateIndex
CREATE INDEX "files_duplicate_of_id_idx" ON "core"."files"("duplicate_of_id");

-- CreateIndex
CREATE INDEX "files_owner_type_owner_id_idx" ON "core"."files"("owner_type", "owner_id");

-- CreateIndex
CREATE INDEX "logs_resource_type_resource_id_idx" ON "audit"."logs"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "logs_actor_id_at_idx" ON "audit"."logs"("actor_id", "at");

-- CreateIndex
CREATE INDEX "logs_at_idx" ON "audit"."logs"("at");

-- CreateIndex
CREATE INDEX "login_logs_user_id_at_idx" ON "audit"."login_logs"("user_id", "at");

-- CreateIndex
CREATE INDEX "login_logs_at_idx" ON "audit"."login_logs"("at");

-- CreateIndex
CREATE INDEX "export_logs_user_id_at_idx" ON "audit"."export_logs"("user_id", "at");

-- CreateIndex
CREATE INDEX "viewer_access_user_id_at_idx" ON "audit"."viewer_access"("user_id", "at");

-- CreateIndex
CREATE INDEX "outbox_published_at_dead_at_next_attempt_at_idx" ON "integration"."outbox"("published_at", "dead_at", "next_attempt_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "integration"."idempotency_keys"("expires_at");

-- AddForeignKey
ALTER TABLE "core"."registers" ADD CONSTRAINT "registers_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "core"."stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."staff" ADD CONSTRAINT "staff_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."staff_badges" ADD CONSTRAINT "staff_badges_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "core"."staff"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."role_permissions" ADD CONSTRAINT "role_permissions_permission_code_fkey" FOREIGN KEY ("permission_code") REFERENCES "core"."permissions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."user_role_assignments" ADD CONSTRAINT "user_role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."user_permission_grants" ADD CONSTRAINT "user_permission_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."user_permission_grants" ADD CONSTRAINT "user_permission_grants_permission_code_fkey" FOREIGN KEY ("permission_code") REFERENCES "core"."permissions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."pos_devices" ADD CONSTRAINT "pos_devices_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "core"."stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."pos_devices" ADD CONSTRAINT "pos_devices_register_id_store_id_fkey" FOREIGN KEY ("register_id", "store_id") REFERENCES "core"."registers"("id", "store_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "core"."sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."sessions" ADD CONSTRAINT "sessions_pos_device_id_fkey" FOREIGN KEY ("pos_device_id") REFERENCES "core"."pos_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "core"."sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "core"."refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."auth_challenges" ADD CONSTRAINT "auth_challenges_pos_device_id_fkey" FOREIGN KEY ("pos_device_id") REFERENCES "core"."pos_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."viewer_profile_assignments" ADD CONSTRAINT "viewer_profile_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."viewer_profile_assignments" ADD CONSTRAINT "viewer_profile_assignments_viewer_profile_id_fkey" FOREIGN KEY ("viewer_profile_id") REFERENCES "core"."viewer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reporting_private"."viewer_profile_scopes" ADD CONSTRAINT "viewer_profile_scopes_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "core"."viewer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reporting_private"."viewer_profile_scopes" ADD CONSTRAINT "viewer_profile_scopes_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "core"."stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."files" ADD CONSTRAINT "files_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."files" ADD CONSTRAINT "files_duplicate_of_id_fkey" FOREIGN KEY ("duplicate_of_id") REFERENCES "core"."files"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- PHẦN SQL TAY của 0001_foundation (ADR-003, ADR-011, ADR-017, ADR-020): CHECK, index biểu thức/partial, trigger,
-- GRANT/REVOKE, RLS, seed. Một khi đã áp ở môi trường dùng chung: KHÔNG sửa file này — sửa bằng migration mới.
-- ═════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ─────────── 1. Ràng buộc dữ liệu Prisma không biểu diễn được ───────────

ALTER TABLE core.stores ADD CONSTRAINT stores_code_format CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,15}$');
ALTER TABLE core.warehouses ADD CONSTRAINT warehouses_code_format CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,15}$');

ALTER TABLE core.users
  ADD CONSTRAINT users_email_lower CHECK (email IS NULL OR (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+$')),
  -- Master/Viewer đăng nhập bằng email + mật khẩu (SEC1); khách bằng SĐT (SEC6); nhân viên bằng mã NV + PIN (SEC3)
  ADD CONSTRAINT users_admin_credentials CHECK (type NOT IN ('MASTER', 'VIEWER') OR (email IS NOT NULL AND password_hash IS NOT NULL)),
  ADD CONSTRAINT users_customer_phone CHECK (type <> 'CUSTOMER' OR phone_hash IS NOT NULL),
  ADD CONSTRAINT users_pin_staff_only CHECK (pin_hash IS NULL OR type = 'STAFF'),
  ADD CONSTRAINT users_totp_admin_only CHECK (totp_secret_enc IS NULL OR type IN ('MASTER', 'VIEWER')),
  ADD CONSTRAINT users_phone_pair CHECK ((phone_enc IS NULL) = (phone_hash IS NULL)),
  ADD CONSTRAINT users_phone_hash_len CHECK (phone_hash IS NULL OR octet_length(phone_hash) = 32),
  ADD CONSTRAINT users_totp_enabled_needs_secret CHECK (totp_enabled_at IS NULL OR totp_secret_enc IS NOT NULL),
  ADD CONSTRAINT users_counters CHECK (failed_login_count >= 0 AND lock_count >= 0 AND version >= 0);

ALTER TABLE core.staff
  ADD CONSTRAINT staff_code_format CHECK (staff_code ~ '^[A-Z0-9][A-Z0-9_-]{1,19}$'),
  ADD CONSTRAINT staff_dates CHECK (left_at IS NULL OR hired_at IS NULL OR left_at >= hired_at);
ALTER TABLE core.staff_badges ADD CONSTRAINT staff_badges_hash_len CHECK (octet_length(badge_code_hash) = 32);

ALTER TABLE core.user_role_assignments
  ADD CONSTRAINT ura_scope_shape CHECK ((scope_type = 'ALL') = (scope_id IS NULL)),
  ADD CONSTRAINT ura_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_by IS NULL));
ALTER TABLE core.user_permission_grants
  ADD CONSTRAINT upg_scope_shape CHECK ((scope_type = 'ALL') = (scope_id IS NULL)),
  ADD CONSTRAINT upg_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_by IS NULL));
-- Một vai trò/quyền đang hiệu lực chỉ một dòng cho cùng phạm vi (biểu thức + partial: Prisma không biểu diễn)
CREATE UNIQUE INDEX ura_active_unique ON core.user_role_assignments
  (user_id, role, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX upg_active_unique ON core.user_permission_grants
  (user_id, permission_code, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE revoked_at IS NULL;

ALTER TABLE core.approval_limits
  ADD CONSTRAINT approval_limits_values CHECK ((max_amount IS NULL OR max_amount >= 0) AND (max_pct_bp IS NULL OR max_pct_bp BETWEEN 0 AND 10000)),
  ADD CONSTRAINT approval_limits_mode CHECK (limit_mode IN ('ANY', 'ALL')),
  ADD CONSTRAINT approval_limits_not_allowed_empty CHECK (allowed OR (max_amount IS NULL AND max_pct_bp IS NULL));

ALTER TABLE core.pos_devices
  ADD CONSTRAINT pos_devices_key_len CHECK (octet_length(public_key) = 32 AND octet_length(fingerprint) = 32),
  ADD CONSTRAINT pos_devices_state CHECK (
    (status = 'PENDING' AND activated_at IS NULL AND revoked_at IS NULL)
    OR (status = 'ACTIVE' AND activated_at IS NOT NULL AND activated_by IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'REVOKED' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL));

ALTER TABLE core.sessions
  -- trần 60 ngày = hạn dài nhất (khách, ADR-012); admin 12 giờ / staff 24 giờ do API đặt
  ADD CONSTRAINT sessions_times CHECK (expires_at > created_at AND expires_at <= created_at + interval '60 days'),
  ADD CONSTRAINT sessions_staff_device CHECK (user_type <> 'STAFF' OR pos_device_id IS NOT NULL),
  ADD CONSTRAINT sessions_ip_hash_len CHECK (ip_hash IS NULL OR octet_length(ip_hash) = 32);
ALTER TABLE core.refresh_tokens
  ADD CONSTRAINT refresh_tokens_hash_len CHECK (octet_length(token_hash) = 32),
  ADD CONSTRAINT refresh_tokens_not_self CHECK (replaced_by_id IS NULL OR replaced_by_id <> id),
  ADD CONSTRAINT refresh_tokens_replaced_needs_used CHECK (replaced_by_id IS NULL OR used_at IS NOT NULL);
ALTER TABLE core.auth_challenges
  ADD CONSTRAINT auth_challenges_hash_len CHECK (octet_length(secret_hash) = 32),
  ADD CONSTRAINT auth_challenges_owner CHECK ((kind = 'MFA' AND user_id IS NOT NULL AND pos_device_id IS NULL) OR (kind = 'DEVICE_NONCE' AND pos_device_id IS NOT NULL)),
  ADD CONSTRAINT auth_challenges_attempts CHECK (attempts BETWEEN 0 AND 5),
  ADD CONSTRAINT auth_challenges_ttl CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes');
ALTER TABLE core.otp_challenges
  ADD CONSTRAINT otp_hash_len CHECK (octet_length(phone_hash) = 32 AND (ip_hash IS NULL OR octet_length(ip_hash) = 32)),
  ADD CONSTRAINT otp_attempts CHECK (attempts BETWEEN 0 AND 5),
  ADD CONSTRAINT otp_ttl CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes');

ALTER TABLE core.viewer_profiles
  ADD CONSTRAINT vp_code_format CHECK (code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  ADD CONSTRAINT vp_customer_vis CHECK (customer_visibility IN ('AGGREGATE', 'MASKED')),
  ADD CONSTRAINT vp_cost_vis CHECK (cost_visibility IN ('SNAPSHOT_ACTUAL', 'SNAPSHOT_ACTUAL_OR_STANDARD')),
  ADD CONSTRAINT vp_supplier_vis CHECK (supplier_visibility IN ('HIDDEN', 'SHOWN')),
  ADD CONSTRAINT vp_pos_vis CHECK (pos_control_visibility IN ('HIDDEN', 'AGGREGATE'));

ALTER TABLE core.files
  ADD CONSTRAINT files_sizes CHECK (declared_bytes > 0 AND (bytes IS NULL OR bytes > 0)),
  ADD CONSTRAINT files_sha_len CHECK (octet_length(declared_sha256) = 32 AND (sha256 IS NULL OR octet_length(sha256) = 32)),
  ADD CONSTRAINT files_not_self_dup CHECK (duplicate_of_id IS NULL OR duplicate_of_id <> id),
  ADD CONSTRAINT files_state CHECK (
    (status = 'PENDING' AND completed_at IS NULL)
    OR (status = 'READY' AND completed_at IS NOT NULL AND sha256 IS NOT NULL AND bytes IS NOT NULL)
    OR (status = 'REJECTED' AND reject_reason IS NOT NULL)),
  ADD CONSTRAINT files_owner_pair CHECK ((owner_type IS NULL) = (owner_id IS NULL));

ALTER TABLE integration.outbox
  ADD CONSTRAINT outbox_values CHECK (attempts >= 0 AND schema_version >= 1 AND event_type ~ '^[a-z_]+\.[a-z_]+$');
-- Relay chỉ quét dòng chưa phát (ADR-007, ERD §6.1) — partial index Prisma không biểu diễn
CREATE INDEX outbox_pending ON integration.outbox (next_attempt_at, id) WHERE published_at IS NULL AND dead_at IS NULL;
ALTER TABLE integration.idempotency_keys
  ADD CONSTRAINT idem_status CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  ADD CONSTRAINT idem_completed CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),
  ADD CONSTRAINT idem_hash_len CHECK (octet_length(request_hash) = 32);

-- ─────────── 2. Trigger ───────────

-- Thời điểm do server đặt (không tin giá trị bên chèn): created_at / at / updated_at
CREATE OR REPLACE FUNCTION core.set_created_now() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$ BEGIN NEW.created_at := now(); RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION core.set_at_now() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$ BEGIN NEW.at := now(); RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION core.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['core.sessions', 'core.refresh_tokens', 'core.auth_challenges', 'core.otp_challenges',
                           'core.user_role_assignments', 'core.files', 'core.recovery_codes', 'core.stores',
                           'core.warehouses', 'core.registers', 'core.viewer_profiles', 'core.viewer_profile_assignments'] LOOP
    EXECUTE format('CREATE TRIGGER set_created BEFORE INSERT ON %s FOR EACH ROW EXECUTE FUNCTION core.set_created_now()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['core.users', 'core.stores', 'core.approval_limits'] LOOP
    EXECUTE format('CREATE TRIGGER touch_updated BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['audit.logs', 'audit.login_logs', 'audit.export_logs', 'audit.viewer_access'] LOOP
    EXECUTE format('CREATE TRIGGER set_at BEFORE INSERT ON %s FOR EACH ROW EXECUTE FUNCTION core.set_at_now()', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION core.set_granted_now() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$ BEGIN NEW.granted_at := now(); RETURN NEW; END; $$;
CREATE TRIGGER set_granted BEFORE INSERT ON core.user_permission_grants FOR EACH ROW EXECUTE FUNCTION core.set_granted_now();
CREATE OR REPLACE FUNCTION core.set_issued_now() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$ BEGIN NEW.issued_at := now(); RETURN NEW; END; $$;
CREATE TRIGGER set_issued BEFORE INSERT ON core.staff_badges FOR EACH ROW EXECUTE FUNCTION core.set_issued_now();

-- Loại người dùng bất biến (mọi quyền/vai trò/phiên dựa vào nó)
CREATE OR REPLACE FUNCTION core.users_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.type <> OLD.type THEN
    RAISE EXCEPTION 'users: không đổi được id/type (tạo tài khoản mới thay thế)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_guard BEFORE UPDATE ON core.users FOR EACH ROW EXECUTE FUNCTION core.users_guard();

-- Kiểm loại người dùng cho bảng gắn người dùng (kiểm ngay trong trigger: hàm trigger chạy với quyền người gọi,
-- gọi hàm phụ sẽ cần EXECUTE — default privileges đã thu EXECUTE khỏi PUBLIC)
CREATE OR REPLACE FUNCTION core.user_type_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
  ut text;
  allowed text[];
BEGIN
  SELECT u.type::text INTO ut FROM core.users u WHERE u.id = NEW.user_id;
  allowed := CASE TG_TABLE_NAME
    WHEN 'staff' THEN ARRAY['STAFF']
    WHEN 'recovery_codes' THEN ARRAY['MASTER', 'VIEWER']
    WHEN 'viewer_profile_assignments' THEN ARRAY['VIEWER']
  END;
  IF ut IS NULL OR NOT (ut = ANY (allowed)) THEN
    RAISE EXCEPTION '%: người dùng loại % không hợp lệ (chỉ %)', TG_TABLE_NAME, COALESCE(ut, '?'), array_to_string(allowed, '/')
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'viewer_profile_assignments' THEN
    IF EXISTS (SELECT 1 FROM core.viewer_profiles vp WHERE vp.id = NEW.viewer_profile_id AND vp.archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'viewer_profile_assignments: hồ sơ đã lưu trữ' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER user_type_guard BEFORE INSERT OR UPDATE ON core.staff FOR EACH ROW EXECUTE FUNCTION core.user_type_guard();
CREATE TRIGGER user_type_guard BEFORE INSERT OR UPDATE ON core.recovery_codes FOR EACH ROW EXECUTE FUNCTION core.user_type_guard();
CREATE TRIGGER user_type_guard BEFORE INSERT OR UPDATE ON core.viewer_profile_assignments FOR EACH ROW EXECUTE FUNCTION core.user_type_guard();

-- Gán vai trò / quyền riêng: INSERT kiểm đủ; UPDATE chỉ được thu hồi một lần (thu hồi là kết thúc)
CREATE OR REPLACE FUNCTION core.check_scope_and_role() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
  ut text;
  r text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION '%: dòng đã thu hồi không sửa được', TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
    IF (to_jsonb(NEW) - 'revoked_at' - 'revoked_by') <> (to_jsonb(OLD) - 'revoked_at' - 'revoked_by') THEN
      RAISE EXCEPTION '%: chỉ được thu hồi (revoked_at, revoked_by)', TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.revoked_at IS NOT NULL THEN
      NEW.revoked_at := now();   -- mốc thu hồi do server đặt
    END IF;
    RETURN NEW;
  END IF;
  -- scope_id NULL để CHECK *_scope_shape báo lỗi (CHECK chạy sau trigger BEFORE)
  IF NEW.scope_type = 'STORE' AND NEW.scope_id IS NOT NULL AND NOT EXISTS
       (SELECT 1 FROM core.stores s WHERE s.id = NEW.scope_id AND s.archived_at IS NULL) THEN
    RAISE EXCEPTION 'scope_id % không phải cửa hàng đang hoạt động', NEW.scope_id USING ERRCODE = 'foreign_key_violation';
  ELSIF NEW.scope_type = 'WAREHOUSE' AND NEW.scope_id IS NOT NULL AND NOT EXISTS
       (SELECT 1 FROM core.warehouses w WHERE w.id = NEW.scope_id AND w.archived_at IS NULL) THEN
    RAISE EXCEPTION 'scope_id % không phải kho đang hoạt động', NEW.scope_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION '%: không tạo dòng đã thu hồi', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  SELECT u.type::text INTO ut FROM core.users u WHERE u.id = NEW.user_id;
  IF TG_TABLE_NAME = 'user_permission_grants' THEN
    -- quyền cấp riêng chỉ cho nhân viên (§2.1: WAREHOUSE_STAFF + purchase_price:write); viewer chỉ xem (§2.5)
    IF ut IS DISTINCT FROM 'STAFF' THEN
      RAISE EXCEPTION 'Quyền cấp riêng chỉ cho người dùng STAFF (đang là %)', COALESCE(ut, '?') USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  r := NEW.role::text;
  IF NOT (
    (r = 'MASTER_ADMIN' AND ut = 'MASTER' AND NEW.scope_type = 'ALL')
    OR (r = 'VIEW_ONLY_ADMIN' AND ut = 'VIEWER' AND NEW.scope_type = 'ALL')
    OR (r = 'CUSTOMER' AND ut = 'CUSTOMER' AND NEW.scope_type = 'ALL')
    OR (r IN ('STORE_MANAGER', 'CASHIER', 'PICKER', 'SHIPPER') AND ut = 'STAFF' AND NEW.scope_type = 'STORE')
    OR (r = 'WAREHOUSE_STAFF' AND ut = 'STAFF' AND NEW.scope_type = 'WAREHOUSE')
  ) THEN
    RAISE EXCEPTION 'Vai trò % không hợp với người dùng loại % / phạm vi %', r, COALESCE(ut, '?'), NEW.scope_type
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ura_check BEFORE INSERT OR UPDATE ON core.user_role_assignments
  FOR EACH ROW EXECUTE FUNCTION core.check_scope_and_role();
CREATE TRIGGER upg_check BEFORE INSERT OR UPDATE ON core.user_permission_grants
  FOR EACH ROW EXECUTE FUNCTION core.check_scope_and_role();

-- Phiên: user_type phải đúng loại người dùng; phiên nhân viên chỉ trên thiết bị ACTIVE; thu hồi là kết thúc.
-- Mọi kiểm "thiết bị ACTIVE" / "phiên chưa thu hồi" dùng FOR SHARE: khóa dòng đến hết transaction để thu hồi đồng
-- thời phải chờ (READ COMMITTED — ADR-016), rồi trigger thu hồi phiên thấy được phiên vừa tạo.
CREATE OR REPLACE FUNCTION core.sessions_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE ut text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'sessions: phiên đã thu hồi không sửa được' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.revoked_at IS NOT NULL THEN
      NEW.revoked_at := now();   -- mốc thu hồi do server đặt
    ELSIF NEW.pos_device_id IS NOT NULL AND NOT EXISTS
          (SELECT 1 FROM core.pos_devices d WHERE d.id = NEW.pos_device_id AND d.status = 'ACTIVE' FOR SHARE) THEN
      -- phiên nhân viên trên thiết bị không còn ACTIVE chỉ được thu hồi, không gia hạn/dùng tiếp
      RAISE EXCEPTION 'sessions: thiết bị POS không còn ACTIVE — chỉ được thu hồi phiên' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT u.type::text INTO ut FROM core.users u WHERE u.id = NEW.user_id;
  IF ut IS DISTINCT FROM NEW.user_type::text THEN
    RAISE EXCEPTION 'sessions: user_type % khác loại người dùng %', NEW.user_type, COALESCE(ut, '?') USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.pos_device_id IS NOT NULL AND (NEW.user_type <> 'STAFF' OR NOT EXISTS
       (SELECT 1 FROM core.pos_devices d WHERE d.id = NEW.pos_device_id AND d.status = 'ACTIVE' FOR SHARE)) THEN
    RAISE EXCEPTION 'sessions: thiết bị POS phải ACTIVE và chỉ cho phiên nhân viên' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'sessions: không tạo phiên đã thu hồi' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sessions_guard BEFORE INSERT OR UPDATE ON core.sessions FOR EACH ROW EXECUTE FUNCTION core.sessions_guard();

-- Refresh token: đã dùng/đã thay là bất biến (không "hồi sinh" token đã xoay — ADR-012)
CREATE OR REPLACE FUNCTION core.refresh_tokens_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.used_at IS NOT NULL OR NEW.replaced_by_id IS NOT NULL THEN
      RAISE EXCEPTION 'refresh_tokens: token mới phải chưa dùng' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.sessions s WHERE s.id = NEW.session_id AND s.revoked_at IS NULL FOR SHARE) THEN
      RAISE EXCEPTION 'refresh_tokens: phiên đã thu hồi/không tồn tại' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
     OR (OLD.replaced_by_id IS NOT NULL AND NEW.replaced_by_id IS DISTINCT FROM OLD.replaced_by_id) THEN
    RAISE EXCEPTION 'refresh_tokens: token đã xoay không sửa được' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.used_at IS NOT NULL AND OLD.used_at IS NULL THEN
    NEW.used_at := now();
  END IF;
  IF NEW.replaced_by_id IS NOT NULL AND NOT EXISTS
       (SELECT 1 FROM core.refresh_tokens t WHERE t.id = NEW.replaced_by_id AND t.session_id = NEW.session_id) THEN
    RAISE EXCEPTION 'refresh_tokens: token thay thế phải cùng phiên' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER refresh_tokens_guard BEFORE INSERT OR UPDATE ON core.refresh_tokens FOR EACH ROW EXECUTE FUNCTION core.refresh_tokens_guard();

-- Thiết bị POS: PENDING → ACTIVE → REVOKED, PENDING → REVOKED; khóa/cửa hàng/mốc thời gian bất biến; REVOKED đóng băng
CREATE OR REPLACE FUNCTION core.pos_device_transition() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' THEN
      RAISE EXCEPTION 'pos_devices: thiết bị mới phải PENDING (kích hoạt sau)' USING ERRCODE = 'check_violation';
    END IF;
    NEW.registered_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status = 'REVOKED' THEN
    RAISE EXCEPTION 'pos_devices: thiết bị đã thu hồi không sửa được (đăng ký thiết bị mới)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.public_key <> OLD.public_key OR NEW.fingerprint <> OLD.fingerprint OR NEW.store_id <> OLD.store_id
     OR NEW.registered_at <> OLD.registered_at
     OR (OLD.activated_at IS NOT NULL AND (NEW.activated_at IS DISTINCT FROM OLD.activated_at OR NEW.activated_by IS DISTINCT FROM OLD.activated_by)) THEN
    RAISE EXCEPTION 'pos_devices: không đổi được khóa/cửa hàng/mốc đăng ký/kích hoạt' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('ACTIVE', 'REVOKED'))
    OR (OLD.status = 'ACTIVE' AND NEW.status = 'REVOKED')) THEN
    RAISE EXCEPTION 'pos_devices: chuyển trạng thái % → % không hợp lệ', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  -- mốc kích hoạt/thu hồi do server đặt
  IF NEW.status = 'ACTIVE' AND OLD.status = 'PENDING' THEN NEW.activated_at := now(); END IF;
  IF NEW.status = 'REVOKED' AND OLD.status <> 'REVOKED' THEN NEW.revoked_at := now(); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pos_device_transition BEFORE INSERT OR UPDATE ON core.pos_devices
  FOR EACH ROW EXECUTE FUNCTION core.pos_device_transition();

-- Thu hồi thiết bị ⇒ thu hồi mọi phiên đang mở trên thiết bị trong cùng transaction (SEC3/SEC4, ADR-012)
CREATE OR REPLACE FUNCTION core.pos_device_revoke_sessions() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE core.sessions SET revoked_at = now(), revoke_reason = 'DEVICE_REVOKED'
  WHERE pos_device_id = NEW.id AND revoked_at IS NULL;
  RETURN NULL;
END;
$$;
CREATE TRIGGER pos_device_revoke_sessions AFTER UPDATE OF status ON core.pos_devices
  FOR EACH ROW WHEN (NEW.status = 'REVOKED' AND OLD.status <> 'REVOKED')
  EXECUTE FUNCTION core.pos_device_revoke_sessions();

-- Nonce thiết bị chỉ phát cho thiết bị ACTIVE
CREATE OR REPLACE FUNCTION core.auth_challenges_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.kind = 'DEVICE_NONCE' AND NOT EXISTS
       (SELECT 1 FROM core.pos_devices d WHERE d.id = NEW.pos_device_id AND d.status = 'ACTIVE' FOR SHARE) THEN
    RAISE EXCEPTION 'auth_challenges: thiết bị POS phải ACTIVE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER auth_challenges_guard BEFORE INSERT ON core.auth_challenges
  FOR EACH ROW EXECUTE FUNCTION core.auth_challenges_guard();

-- ─────────── 3. Bảng chỉ-thêm: audit.* (FR-INV-05/10, ADR-011) ───────────
-- Chặn mọi role ứng dụng (REVOKE + trigger). Superuser vẫn vượt được (session_replication_role) — giảm rủi ro bằng
-- bản sao nhật ký ra lưu trữ ngoài (§14 F14), không dùng superuser lúc chạy app.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit.logs', 'audit.login_logs', 'audit.export_logs', 'audit.viewer_access'] LOOP
    EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION core.raise_immutable()', t);
    EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION core.raise_immutable()', t);
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, app_rw, projector_rw, viewer_ro, viewer_act, audit_writer', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON audit.logs, audit.export_logs TO app_rw;     -- ghi cùng transaction nghiệp vụ; Master đọc (audit:read)
GRANT SELECT ON audit.login_logs, audit.viewer_access TO app_rw;     -- Master đọc
-- audit_writer/viewer_act KHÔNG có SELECT ⇒ không dùng INSERT … RETURNING (Prisma `create`); dùng `createMany`/
-- `$executeRaw` (ADR-020)
GRANT INSERT ON audit.login_logs TO audit_writer;
GRANT INSERT ON audit.viewer_access TO viewer_act;

-- ─────────── 4. Quyền theo bảng/cột (ADR-011) ───────────
-- core: default privileges (000) cho app_rw SELECT/INSERT/UPDATE cả bảng. Ở đây thu UPDATE cả bảng về, chỉ mở UPDATE
-- đúng các cột nghiệp vụ được sửa: không role ứng dụng nào sửa được khóa chính, loại người dùng, khóa thiết bị, mốc tạo.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT format('%I.%I', schemaname, tablename) FROM pg_tables WHERE schemaname = 'core' LOOP
    EXECUTE format('REVOKE UPDATE ON %s FROM app_rw', t);
  END LOOP;
END $$;
GRANT UPDATE (email, phone_enc, phone_hash, password_hash, pin_hash, totp_secret_enc, totp_enabled_at, status,
              failed_login_count, locked_until, lock_count, last_login_at, updated_at, version) ON core.users TO app_rw;
GRANT UPDATE (used_at) ON core.recovery_codes TO app_rw;
GRANT UPDATE (full_name, hired_at, left_at) ON core.staff TO app_rw;
GRANT UPDATE (revoked_at) ON core.staff_badges TO app_rw;
GRANT UPDATE (revoked_at, revoked_by) ON core.user_role_assignments, core.user_permission_grants TO app_rw;
GRANT UPDATE (allowed, max_amount, max_pct_bp, limit_mode, same_day_only, requires_pin, requires_note, updated_at, updated_by)
  ON core.approval_limits TO app_rw;
GRANT UPDATE (name, address, status, updated_at, archived_at) ON core.stores TO app_rw;
GRANT UPDATE (name, address, archived_at) ON core.warehouses TO app_rw;
GRANT UPDATE (code) ON core.registers TO app_rw;
GRANT UPDATE (name, register_id, status, activated_by, activated_at, revoked_by, revoked_at, revoke_reason, last_seen_at)
  ON core.pos_devices TO app_rw;
GRANT UPDATE (amr, step_up_until, last_used_at, expires_at, revoked_at, revoke_reason, ip_hash, user_agent) ON core.sessions TO app_rw;
GRANT UPDATE (used_at, replaced_by_id) ON core.refresh_tokens TO app_rw;
GRANT UPDATE (attempts, used_at) ON core.auth_challenges TO app_rw;
GRANT UPDATE (attempts, consumed_at) ON core.otp_challenges TO app_rw;
GRANT UPDATE (name, all_stores, modules, customer_visibility, cost_visibility, supplier_visibility, pos_control_visibility,
              archived_at) ON core.viewer_profiles TO app_rw;
GRANT UPDATE (owner_type, owner_id, bytes, sha256, status, reject_reason, duplicate_of_id, completed_at) ON core.files TO app_rw;
REVOKE INSERT ON core.permissions, core.role_permissions FROM app_rw;   -- chỉ đổi bằng migration
GRANT DELETE ON core.otp_challenges, core.auth_challenges, core.recovery_codes, core.viewer_profile_assignments TO app_rw;
-- reporting_private.viewer_profile_scopes: app_rw quản lý (Master sửa hồ sơ); không role viewer nào chạm
GRANT USAGE ON SCHEMA reporting_private TO app_rw;
GRANT SELECT, INSERT, DELETE ON reporting_private.viewer_profile_scopes TO app_rw;
-- integration: default cho app_rw SELECT/INSERT; UPDATE chỉ theo cột (không ai sửa payload)
GRANT UPDATE (published_at, attempts, next_attempt_at, last_error, dead_at) ON integration.outbox TO app_rw;
GRANT UPDATE (status, response_status, response, completed_at) ON integration.idempotency_keys TO app_rw;
GRANT DELETE ON integration.idempotency_keys TO app_rw;                -- dọn key quá 48 giờ
GRANT SELECT, INSERT ON integration.processed_events TO projector_rw;  -- consumer projection idempotent

-- ─────────── 5. Khung RLS cho viewer (§2.5 lớp 3–4, ADR-011) ───────────
CREATE OR REPLACE FUNCTION reporting.current_profile() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
AS $$ SELECT NULLIF(current_setting('app.viewer_profile_id', true), '')::uuid $$;

-- Cửa hàng của hồ sơ đang đặt trong transaction (API đặt bằng set_config(..., true)). Không nhận tham số ⇒ viewer không
-- liệt kê được cửa hàng của hồ sơ khác qua lời gọi trực tiếp. SECURITY DEFINER: viewer không có USAGE core/
-- reporting_private. Hồ sơ lưu trữ hoặc thiếu ⇒ mảng rỗng (0 dòng, không lỗi).
CREATE OR REPLACE FUNCTION reporting.allowed_stores() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT CASE WHEN vp.all_stores
                 THEN (SELECT array_agg(s.id) FROM core.stores s WHERE s.archived_at IS NULL)
                 ELSE (SELECT array_agg(sc.store_id) FROM reporting_private.viewer_profile_scopes sc WHERE sc.profile_id = vp.id)
            END
     FROM core.viewer_profiles vp
     WHERE vp.id = NULLIF(current_setting('app.viewer_profile_id', true), '')::uuid AND vp.archived_at IS NULL),
    '{}'::uuid[])
$$;
REVOKE EXECUTE ON FUNCTION reporting.current_profile(), reporting.allowed_stores() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.current_profile(), reporting.allowed_stores() TO viewer_ro;

-- ─────────── 6. Dữ liệu tham chiếu (seed — §19.6, §21.8, NC-08, §2.2, §2.3, §10.3, §19.7) ───────────
INSERT INTO core.permissions (code, description, added_outside_spec) VALUES
  ('catalog:read', 'Xem danh mục sản phẩm, SKU', false),
  ('catalog:write', 'Sửa danh mục sản phẩm, SKU', false),
  ('price:read', 'Xem giá bán (giá xuất)', false),
  ('price:write', 'Sửa giá bán lẻ/đẩy/sỉ', false),
  ('purchase_price:read', 'Xem giá nhập', false),
  ('purchase_price:write', 'Nhập/sửa giá nhập', false),
  ('supplier:read', 'Xem nhà cung cấp', false),
  ('supplier:write', 'Sửa nhà cung cấp', false),
  ('receipt:create', 'Tạo phiếu nhập kho', false),
  ('receipt:read', 'Xem phiếu nhập kho', false),
  ('batch:read', 'Xem lô hàng', false),
  ('batch:cost_write', 'Sửa giá vốn lô', false),
  ('stock:read', 'Xem tồn kho', false),
  ('stock:adjust', 'Điều chỉnh tồn kho', false),
  ('transfer:create', 'Tạo/yêu cầu điều chuyển', false),
  ('transfer:ship', 'Xuất điều chuyển', false),
  ('transfer:receive', 'Nhận điều chuyển', false),
  ('stocktake:create', 'Tạo phiếu kiểm kê', false),
  ('stocktake:approve', 'Duyệt kiểm kê', false),
  ('spoilage:create', 'Tạo phiếu hủy hàng', false),
  ('spoilage:approve', 'Duyệt phiếu hủy hàng', false),
  ('ripeness:check', 'Kiểm độ chín', false),
  ('markdown:approve', 'Duyệt giảm giá cận hạn', false),
  ('pos:sell', 'Bán hàng tại quầy', false),
  ('pos:void_line', 'Xóa dòng trước thanh toán', false),
  ('pos:void_sale', 'Hủy hóa đơn đã thanh toán', false),
  ('pos:refund', 'Hoàn tiền', false),
  ('pos:discount', 'Giảm giá tay trên dòng', false),
  ('pos:manual_weight', 'Nhập cân tay khi cân lỗi', false),
  ('pos:no_sale_open', 'Mở két không bán', false),
  ('shift:open', 'Mở ca', false),
  ('shift:close', 'Đóng ca', false),
  ('day:close', 'Đóng ngày', false),
  ('cash:movement', 'Thu/chi tiền mặt tại cửa hàng', false),
  ('cash:approve', 'Duyệt chênh lệch két', false),
  ('app_order:fulfill', 'Soạn đơn app', false),
  ('app_order:manage', 'Quản lý đơn app', false),
  ('wholesale:read', 'Xem đơn sỉ', false),
  ('wholesale:write', 'Tạo/sửa đơn sỉ', false),
  ('wholesale:fulfill', 'Soạn đơn sỉ', false),
  ('receivable:write', 'Ghi công nợ', false),
  ('deal:read', 'Xem mặt hàng đẩy', false),
  ('deal:write', 'Tạo/sửa mặt hàng đẩy', false),
  ('notify:send', 'Gửi thông báo', false),
  ('zone:write', 'Sửa vùng giao, phí ship', false),
  ('store:write', 'Sửa cửa hàng', false),
  ('device:write', 'Quản lý/kích hoạt thiết bị', false),
  ('customer:read_masked', 'Xem khách hàng đã che', false),
  ('customer:read_full', 'Xem khách hàng đầy đủ', false),
  ('customer:export', 'Xuất danh sách khách', false),
  ('staff:write', 'Quản lý nhân viên', false),
  ('role:assign', 'Gán vai trò', false),
  ('report:read', 'Xem báo cáo', false),
  ('report:export', 'Xuất báo cáo', false),
  ('publish:manage', 'Phát hành/thu hồi báo cáo', false),
  ('viewer_profile:write', 'Sửa hồ sơ hiển thị viewer', false),
  ('period:lock', 'Khóa kỳ', false),
  ('audit:read', 'Xem nhật ký hệ thống', false),
  ('shipper:deliver', 'Giao hàng', false),
  ('cod:remit', 'Nộp tiền COD', false),
  ('viewer:read', 'Admin Chỉ Xem: đọc /viewer/*', false),
  ('unit:write', 'Sửa đơn vị tính', false),
  ('po:write', 'Tạo/sửa đặt hàng nhập', false),
  ('po:approve', 'Duyệt đặt hàng nhập', false),
  ('reorder:write', 'Sửa quy tắc bổ sung hàng', false),
  ('internal_use:create', 'Tạo phiếu dùng nội bộ', false),
  ('internal_use:approve', 'Duyệt phiếu dùng nội bộ', false),
  ('barcode_rule:write', 'Sửa quy tắc mã vạch', false),
  ('badge:issue', 'Cấp thẻ nhân viên', false),
  ('return:create', 'Tạo phiếu đổi/trả', false),
  ('phone_order:create', 'Tạo đơn qua điện thoại', false),
  ('lock_date:write', 'Khóa ngày cửa hàng', false),
  ('cash_account:write', 'Sửa tài khoản quỹ', false),
  ('import:run', 'Chạy nhập dữ liệu từ file', false),
  ('plu:export', 'Xuất PLU cho cân', false),
  ('document:cancel', 'Hủy chứng từ', false),
  ('customer:self', 'Khách tự thao tác trên dữ liệu của mình (NC-08)', true),
  ('settings:write', 'Sửa cấu hình hệ thống (NC-08)', true),
  ('payment:reconcile', 'Khớp tay giao dịch ngân hàng (NC-08)', true),
  ('processing:create', 'Tạo phiếu sơ chế (NC-08)', true),
  ('complaint:resolve', 'Xử lý khiếu nại (NC-08)', true);

-- Ánh xạ vai trò → mã quyền từ ma trận §2.2 (đọc CHẶT: ô "R" không cho mã ghi; phạm vi cửa hàng/kho áp ở tầng API).
-- MASTER_ADMIN: mọi mã trừ mã riêng của viewer, khách, shipper. WAREHOUSE_STAFF KHÔNG có purchase_price:write —
-- Master cấp riêng qua user_permission_grants (§2.1). Mã §21.8/NC-08 SPEC chưa ánh xạ: phiên gán tạm, chờ Tiến (NC-19).
INSERT INTO core.role_permissions (role, permission_code)
SELECT 'MASTER_ADMIN', code FROM core.permissions WHERE code NOT IN ('viewer:read', 'customer:self', 'shipper:deliver');
INSERT INTO core.role_permissions (role, permission_code)
SELECT r.role::core."Role", p.code
FROM (VALUES
  ('VIEW_ONLY_ADMIN', ARRAY['viewer:read']),
  ('STORE_MANAGER', ARRAY['catalog:read', 'price:read', 'receipt:read', 'batch:read', 'stock:read',
     'transfer:create', 'transfer:receive', 'stocktake:create', 'stocktake:approve', 'spoilage:create',
     'spoilage:approve', 'ripeness:check', 'markdown:approve', 'pos:void_sale', 'pos:refund', 'pos:discount',
     'pos:manual_weight', 'pos:no_sale_open', 'shift:open', 'shift:close', 'day:close', 'cash:movement',
     'cash:approve', 'wholesale:read', 'deal:read', 'customer:read_masked', 'staff:write', 'role:assign',
     'badge:issue', 'device:write', 'report:read', 'internal_use:create', 'internal_use:approve', 'return:create',
     'phone_order:create', 'complaint:resolve']),
  ('CASHIER', ARRAY['catalog:read', 'price:read', 'batch:read', 'stock:read', 'spoilage:create', 'pos:sell',
     'pos:void_line', 'shift:open', 'shift:close', 'cash:movement', 'customer:read_masked', 'return:create',
     'phone_order:create', 'internal_use:create']),
  ('PICKER', ARRAY['catalog:read', 'price:read', 'batch:read', 'stock:read', 'spoilage:create', 'ripeness:check',
     'app_order:fulfill', 'wholesale:fulfill', 'customer:read_masked']),
  ('WAREHOUSE_STAFF', ARRAY['catalog:read', 'supplier:read', 'receipt:create', 'receipt:read', 'batch:read',
     'stock:read', 'stock:adjust', 'transfer:create', 'transfer:ship', 'stocktake:create', 'spoilage:create',
     'ripeness:check', 'wholesale:fulfill', 'internal_use:create', 'processing:create']),
  ('SHIPPER', ARRAY['shipper:deliver', 'cod:remit']),
  ('CUSTOMER', ARRAY['customer:self'])
) AS r(role, codes)
CROSS JOIN LATERAL unnest(r.codes) AS c(code)
JOIN core.permissions p ON p.code = c.code;   -- mã gõ sai → thiếu dòng → test đếm số dòng bắt

-- Hạn mức duyệt §2.3 + §5.8 (markdown ≤ 20% cho cửa hàng trưởng). Không có dòng = không được làm.
-- limit_mode ANY: "≤ 10% hoặc ≤ 50.000đ" = đạt một trong hai ngưỡng là được (đọc theo chữ "hoặc"; chờ Tiến — NC-19).
INSERT INTO core.approval_limits (role, action, allowed, max_amount, max_pct_bp, limit_mode, same_day_only, requires_pin, requires_note) VALUES
  ('CASHIER', 'LINE_DELETE', true, NULL, NULL, 'ANY', false, false, false),
  ('STORE_MANAGER', 'LINE_DISCOUNT', true, 50000, 1000, 'ANY', false, false, false),
  ('MASTER_ADMIN', 'LINE_DISCOUNT', true, NULL, NULL, 'ANY', false, false, false),
  ('STORE_MANAGER', 'SALE_VOID', true, 500000, NULL, 'ANY', true, false, false),
  ('MASTER_ADMIN', 'SALE_VOID', true, NULL, NULL, 'ANY', false, false, false),
  ('STORE_MANAGER', 'REFUND', true, 200000, NULL, 'ANY', false, false, false),
  ('MASTER_ADMIN', 'REFUND', true, NULL, NULL, 'ANY', false, false, false),
  ('STORE_MANAGER', 'SPOILAGE_APPROVE', true, 1000000, NULL, 'ANY', false, false, false),
  ('MASTER_ADMIN', 'SPOILAGE_APPROVE', true, NULL, NULL, 'ANY', false, false, false),
  ('STORE_MANAGER', 'STOCKTAKE_ADJUST', true, 1000000, 200, 'ANY', false, false, false),
  ('MASTER_ADMIN', 'STOCKTAKE_ADJUST', true, NULL, NULL, 'ANY', false, false, false),
  ('STORE_MANAGER', 'MANUAL_WEIGHT', true, NULL, NULL, 'ANY', false, true, true),
  ('MASTER_ADMIN', 'MANUAL_WEIGHT', true, NULL, NULL, 'ANY', false, false, false),
  ('STORE_MANAGER', 'NO_SALE_OPEN', true, NULL, NULL, 'ANY', false, true, true),
  ('STORE_MANAGER', 'MARKDOWN', true, NULL, 2000, 'ANY', false, false, false),
  ('MASTER_ADMIN', 'MARKDOWN', true, NULL, NULL, 'ANY', false, false, false);

-- 2 hồ sơ viewer mặc định (§10.3, §19.7) — toàn chuỗi
INSERT INTO core.viewer_profiles (id, code, name, all_stores, modules, customer_visibility, cost_visibility, supplier_visibility, pos_control_visibility) VALUES
  ('019a9b00-0000-7000-8000-000000000001', 'SHAREHOLDER', 'Cổ đông / nhà đầu tư', true,
   ARRAY['TODAY_REVENUE', 'TODAY_ORDERS', 'SNAPSHOTS'], 'AGGREGATE', 'SNAPSHOT_ACTUAL', 'HIDDEN', 'HIDDEN'),
  ('019a9b00-0000-7000-8000-000000000002', 'EXECUTIVE', 'Ban giám đốc', true,
   ARRAY['TODAY_REVENUE', 'TODAY_ORDERS', 'STORE_STATUS', 'LIVE_ORDERS', 'STOCK', 'SNAPSHOTS'], 'MASKED',
   'SNAPSHOT_ACTUAL_OR_STANDARD', 'SHOWN', 'AGGREGATE');
