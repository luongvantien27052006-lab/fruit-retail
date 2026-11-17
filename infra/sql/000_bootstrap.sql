-- 000_bootstrap.sql — nền DB chạy TRƯỚC Prisma migrate (ADR-011, ADR-017, ERD M01).
-- Chạy bằng role owner (DATABASE_URL_MIGRATE). Idempotent. Mật khẩu role do bộ chạy đặt từ biến môi trường,
-- KHÔNG nằm trong file này (FR-INV-18).

-- Extension
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Không ai ngoài owner dùng schema public
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- Schema
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS reporting;
CREATE SCHEMA IF NOT EXISTS reporting_private;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS integration;
REVOKE ALL ON SCHEMA core, reporting, reporting_private, audit, integration FROM PUBLIC;

-- Role đăng nhập (ADR-011). NOINHERIT, không SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_rw', 'projector_rw', 'viewer_ro', 'viewer_act', 'audit_writer'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', r);
    ELSE
      EXECUTE format('ALTER ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', r);
    END IF;
  END LOOP;
END $$;

-- USAGE schema (không role nào được CREATE)
GRANT USAGE ON SCHEMA core, audit, integration, reporting TO app_rw;
GRANT USAGE ON SCHEMA core, reporting, integration TO projector_rw;
GRANT USAGE ON SCHEMA reporting TO viewer_ro;
GRANT USAGE ON SCHEMA reporting_private, audit TO viewer_act;
GRANT USAGE ON SCHEMA audit TO audit_writer;

-- Quyền mặc định cho bảng do owner tạo sau này. KHÔNG có quyền mặc định nào cho viewer_ro/viewer_act (ADR-011):
-- bảng viewer được đọc phải GRANT tường minh từng bảng + bật RLS.
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT SELECT, INSERT, UPDATE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT SELECT ON TABLES TO projector_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA integration GRANT SELECT, INSERT ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA reporting GRANT SELECT ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA reporting GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO projector_rw;
-- audit: quyền INSERT cấp theo từng bảng khi tạo bảng (CP03), không mặc định.

-- Function: không mở EXECUTE cho PUBLIC
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA core, reporting, reporting_private, audit, integration FROM PUBLIC;

-- Trigger function cho bảng chỉ-thêm (FR-INV-05, FR-INV-12)
CREATE OR REPLACE FUNCTION core.raise_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Bảng %.% chỉ được thêm (append-only): % bị chặn', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
REVOKE EXECUTE ON FUNCTION core.raise_immutable() FROM PUBLIC;

-- Sổ migration SQL tay (ADR-017)
CREATE TABLE IF NOT EXISTS integration.sql_migrations (
  file text PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON integration.sql_migrations FROM app_rw, projector_rw;
