-- 0001_foundation — nhóm M02 + M03 tối thiểu (CP03 lát 1). Phần 1: DDL do Prisma sinh
-- (prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script). Phần 2: SQL tay ở cuối file.

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
CREATE INDEX "user_role_assignments_user_id_idx" ON "core"."user_role_assignments"("user_id");

-- CreateIndex
CREATE INDEX "user_permission_grants_user_id_idx" ON "core"."user_permission_grants"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_devices_fingerprint_key" ON "core"."pos_devices"("fingerprint");

-- CreateIndex
CREATE INDEX "pos_devices_store_id_idx" ON "core"."pos_devices"("store_id");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "core"."sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_pos_device_id_idx" ON "core"."sessions"("pos_device_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "core"."refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_session_id_idx" ON "core"."refresh_tokens"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_challenges_secret_hash_key" ON "core"."auth_challenges"("secret_hash");

-- CreateIndex
CREATE INDEX "auth_challenges_expires_at_idx" ON "core"."auth_challenges"("expires_at");

-- CreateIndex
CREATE INDEX "otp_challenges_phone_hash_created_at_idx" ON "core"."otp_challenges"("phone_hash", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "viewer_profiles_code_key" ON "core"."viewer_profiles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "files_storage_key_key" ON "core"."files"("storage_key");

-- CreateIndex
CREATE INDEX "files_sha256_idx" ON "core"."files"("sha256");

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
ALTER TABLE "core"."pos_devices" ADD CONSTRAINT "pos_devices_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "core"."registers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."sessions" ADD CONSTRAINT "sessions_pos_device_id_fkey" FOREIGN KEY ("pos_device_id") REFERENCES "core"."pos_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "core"."sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."viewer_profile_assignments" ADD CONSTRAINT "viewer_profile_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."viewer_profile_assignments" ADD CONSTRAINT "viewer_profile_assignments_viewer_profile_id_fkey" FOREIGN KEY ("viewer_profile_id") REFERENCES "core"."viewer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reporting_private"."viewer_profile_scopes" ADD CONSTRAINT "viewer_profile_scopes_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "core"."viewer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reporting_private"."viewer_profile_scopes" ADD CONSTRAINT "viewer_profile_scopes_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "core"."stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- PHẦN SQL TAY của 0001_foundation (ADR-003, ADR-011, ADR-017, ADR-020) — nối sau DDL Prisma sinh trong migration.sql.
-- Nguồn: apps/api/prisma/migrations/0001_foundation/manual.sql. KHÔNG sửa migration.sql đã áp — sửa bằng migration mới.
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
  ADD CONSTRAINT approval_limits_not_allowed_empty CHECK (allowed OR (max_amount IS NULL AND max_pct_bp IS NULL));

ALTER TABLE core.pos_devices
  ADD CONSTRAINT pos_devices_key_len CHECK (octet_length(public_key) = 32 AND octet_length(fingerprint) = 32),
  ADD CONSTRAINT pos_devices_state CHECK (
    (status = 'PENDING' AND activated_at IS NULL AND revoked_at IS NULL)
    OR (status = 'ACTIVE' AND activated_at IS NOT NULL AND activated_by IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'REVOKED' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL));

ALTER TABLE core.sessions
  ADD CONSTRAINT sessions_times CHECK (expires_at > created_at),
  ADD CONSTRAINT sessions_staff_device CHECK (user_type <> 'STAFF' OR pos_device_id IS NOT NULL),
  ADD CONSTRAINT sessions_ip_hash_len CHECK (ip_hash IS NULL OR octet_length(ip_hash) = 32);
ALTER TABLE core.refresh_tokens
  ADD CONSTRAINT refresh_tokens_hash_len CHECK (octet_length(token_hash) = 32),
  ADD CONSTRAINT refresh_tokens_replaced_needs_used CHECK (replaced_by_id IS NULL OR used_at IS NOT NULL);
ALTER TABLE core.auth_challenges
  ADD CONSTRAINT auth_challenges_hash_len CHECK (octet_length(secret_hash) = 32),
  ADD CONSTRAINT auth_challenges_owner CHECK ((kind = 'MFA' AND user_id IS NOT NULL) OR (kind = 'DEVICE_NONCE' AND pos_device_id IS NOT NULL)),
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

-- ─────────── 2. Trigger nghiệp vụ ───────────

-- Vai trò phải hợp với loại người dùng và phạm vi phải tồn tại (scope_id đa hình nên không dùng FK được)
CREATE OR REPLACE FUNCTION core.check_scope_and_role() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, core
AS $$
DECLARE
  ut core."UserType";
  r text;
BEGIN
  -- scope_id NULL để CHECK *_scope_shape báo lỗi (CHECK chạy sau trigger BEFORE)
  IF NEW.scope_type = 'STORE' AND NEW.scope_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.stores s WHERE s.id = NEW.scope_id) THEN
    RAISE EXCEPTION 'scope_id % không phải cửa hàng', NEW.scope_id USING ERRCODE = 'foreign_key_violation';
  ELSIF NEW.scope_type = 'WAREHOUSE' AND NEW.scope_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.warehouses w WHERE w.id = NEW.scope_id) THEN
    RAISE EXCEPTION 'scope_id % không phải kho', NEW.scope_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF TG_TABLE_NAME = 'user_role_assignments' THEN
    SELECT u.type INTO ut FROM core.users u WHERE u.id = NEW.user_id;
    r := NEW.role::text;
    IF NOT (
      (r = 'MASTER_ADMIN' AND ut = 'MASTER' AND NEW.scope_type = 'ALL')
      OR (r = 'VIEW_ONLY_ADMIN' AND ut = 'VIEWER' AND NEW.scope_type = 'ALL')
      OR (r = 'CUSTOMER' AND ut = 'CUSTOMER' AND NEW.scope_type = 'ALL')
      OR (r IN ('STORE_MANAGER', 'CASHIER', 'PICKER', 'SHIPPER') AND ut = 'STAFF' AND NEW.scope_type = 'STORE')
      OR (r = 'WAREHOUSE_STAFF' AND ut = 'STAFF' AND NEW.scope_type = 'WAREHOUSE')
    ) THEN
      RAISE EXCEPTION 'Vai trò % không hợp với người dùng loại % / phạm vi %', r, ut, NEW.scope_type
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ura_check BEFORE INSERT OR UPDATE ON core.user_role_assignments
  FOR EACH ROW EXECUTE FUNCTION core.check_scope_and_role();
CREATE TRIGGER upg_check BEFORE INSERT OR UPDATE ON core.user_permission_grants
  FOR EACH ROW EXECUTE FUNCTION core.check_scope_and_role();

-- Vòng đời thiết bị POS chỉ đi tới: PENDING → ACTIVE → REVOKED, PENDING → REVOKED; khóa công khai bất biến
CREATE OR REPLACE FUNCTION core.pos_device_transition() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.public_key <> OLD.public_key OR NEW.fingerprint <> OLD.fingerprint OR NEW.store_id <> OLD.store_id THEN
    RAISE EXCEPTION 'pos_devices: không đổi được khóa/cửa hàng của thiết bị đã đăng ký' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('ACTIVE', 'REVOKED'))
    OR (OLD.status = 'ACTIVE' AND NEW.status = 'REVOKED')) THEN
    RAISE EXCEPTION 'pos_devices: chuyển trạng thái % → % không hợp lệ', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pos_device_transition BEFORE UPDATE ON core.pos_devices
  FOR EACH ROW EXECUTE FUNCTION core.pos_device_transition();

-- ─────────── 3. Bảng chỉ-thêm: audit.* (FR-INV-05/10, ADR-011) ───────────
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
GRANT INSERT ON audit.login_logs TO audit_writer;                     -- log đăng nhập ngoài transaction nghiệp vụ
GRANT INSERT ON audit.viewer_access TO viewer_act;

-- ─────────── 4. Quyền theo bảng (ADR-011) ───────────
-- core: default privileges (000) cho app_rw SELECT/INSERT/UPDATE; thu hẹp ở bảng tham chiếu, mở DELETE cho bảng tạm.
REVOKE INSERT, UPDATE ON core.permissions, core.role_permissions FROM app_rw;   -- chỉ đổi bằng migration
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
  SET search_path = pg_catalog
AS $$ SELECT NULLIF(current_setting('app.viewer_profile_id', true), '')::uuid $$;

-- SECURITY DEFINER: viewer không có USAGE reporting_private/core; hồ sơ lưu trữ hoặc NULL → mảng rỗng (0 dòng)
CREATE OR REPLACE FUNCTION reporting.allowed_stores(p_profile uuid) RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT COALESCE(
    (SELECT CASE WHEN vp.all_stores
                 THEN (SELECT array_agg(s.id) FROM core.stores s WHERE s.archived_at IS NULL)
                 ELSE (SELECT array_agg(sc.store_id) FROM reporting_private.viewer_profile_scopes sc WHERE sc.profile_id = vp.id)
            END
     FROM core.viewer_profiles vp
     WHERE vp.id = p_profile AND vp.archived_at IS NULL),
    '{}'::uuid[])
$$;
REVOKE EXECUTE ON FUNCTION reporting.current_profile(), reporting.allowed_stores(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.current_profile(), reporting.allowed_stores(uuid) TO viewer_ro;

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

-- Ánh xạ vai trò → mã quyền từ ma trận §2.2 (phạm vi cửa hàng/kho áp ở tầng API qua user_role_assignments.scope).
-- MASTER_ADMIN: mọi mã trừ mã riêng của viewer, khách, shipper. WAREHOUSE_STAFF KHÔNG có purchase_price:write —
-- Master cấp riêng qua user_permission_grants (§2.1).
INSERT INTO core.role_permissions (role, permission_code)
SELECT 'MASTER_ADMIN', code FROM core.permissions WHERE code NOT IN ('viewer:read', 'customer:self', 'shipper:deliver');
INSERT INTO core.role_permissions (role, permission_code)
SELECT r.role::core."Role", p.code
FROM (VALUES
  ('VIEW_ONLY_ADMIN', ARRAY['viewer:read']),
  ('STORE_MANAGER', ARRAY['catalog:read', 'price:read', 'receipt:read', 'batch:read', 'stock:read',
     'transfer:create', 'transfer:receive', 'stocktake:create', 'stocktake:approve', 'spoilage:create',
     'spoilage:approve', 'ripeness:check', 'markdown:approve', 'pos:sell', 'pos:void_line', 'pos:void_sale',
     'pos:refund', 'pos:discount', 'pos:manual_weight', 'pos:no_sale_open', 'shift:open', 'shift:close',
     'day:close', 'cash:movement', 'cash:approve', 'app_order:manage', 'wholesale:read', 'deal:read',
     'customer:read_masked', 'staff:write', 'role:assign', 'badge:issue', 'device:write', 'report:read',
     'internal_use:create', 'internal_use:approve', 'return:create', 'phone_order:create', 'complaint:resolve']),
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
JOIN core.permissions p ON p.code = c.code;   -- mã gõ sai → thiếu dòng → test seed bắt

-- Hạn mức duyệt §2.3 + §5.8 (markdown ≤ 20% cho cửa hàng trưởng). Không có dòng = không được làm.
INSERT INTO core.approval_limits (role, action, allowed, max_amount, max_pct_bp, same_day_only, requires_pin, requires_note) VALUES
  ('CASHIER', 'LINE_DELETE', true, NULL, NULL, false, false, false),
  ('STORE_MANAGER', 'LINE_DISCOUNT', true, 50000, 1000, false, false, false),
  ('MASTER_ADMIN', 'LINE_DISCOUNT', true, NULL, NULL, false, false, false),
  ('STORE_MANAGER', 'SALE_VOID', true, 500000, NULL, true, false, false),
  ('MASTER_ADMIN', 'SALE_VOID', true, NULL, NULL, false, false, false),
  ('STORE_MANAGER', 'REFUND', true, 200000, NULL, false, false, false),
  ('MASTER_ADMIN', 'REFUND', true, NULL, NULL, false, false, false),
  ('STORE_MANAGER', 'SPOILAGE_APPROVE', true, 1000000, NULL, false, false, false),
  ('MASTER_ADMIN', 'SPOILAGE_APPROVE', true, NULL, NULL, false, false, false),
  ('STORE_MANAGER', 'STOCKTAKE_ADJUST', true, 1000000, 200, false, false, false),
  ('MASTER_ADMIN', 'STOCKTAKE_ADJUST', true, NULL, NULL, false, false, false),
  ('STORE_MANAGER', 'MANUAL_WEIGHT', true, NULL, NULL, false, true, true),
  ('MASTER_ADMIN', 'MANUAL_WEIGHT', true, NULL, NULL, false, false, true),
  ('STORE_MANAGER', 'NO_SALE_OPEN', true, NULL, NULL, false, true, true),
  ('STORE_MANAGER', 'MARKDOWN', true, NULL, 2000, false, false, false),
  ('MASTER_ADMIN', 'MARKDOWN', true, NULL, NULL, false, false, false);

-- 2 hồ sơ viewer mặc định (§10.3, §19.7) — toàn chuỗi
INSERT INTO core.viewer_profiles (id, code, name, all_stores, modules, customer_visibility, cost_visibility, supplier_visibility, pos_control_visibility) VALUES
  ('019a9b00-0000-7000-8000-000000000001', 'SHAREHOLDER', 'Cổ đông / nhà đầu tư', true,
   ARRAY['TODAY_REVENUE', 'TODAY_ORDERS', 'SNAPSHOTS'], 'AGGREGATE', 'SNAPSHOT_ACTUAL', 'HIDDEN', 'HIDDEN'),
  ('019a9b00-0000-7000-8000-000000000002', 'EXECUTIVE', 'Ban giám đốc', true,
   ARRAY['TODAY_REVENUE', 'TODAY_ORDERS', 'STORE_STATUS', 'LIVE_ORDERS', 'STOCK', 'SNAPSHOTS'], 'MASKED',
   'SNAPSHOT_ACTUAL_OR_STANDARD', 'SHOWN', 'AGGREGATE');
