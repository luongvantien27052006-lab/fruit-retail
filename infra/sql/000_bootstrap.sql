-- 000_bootstrap.sql — nền DB chạy TRƯỚC Prisma migrate (ADR-011, ADR-017, ERD M01).
-- Chạy bằng role owner là SUPERUSER của cluster (cần cho CREATE EXTENSION postgis và thuộc tính role) — ADR-017.
-- Idempotent (chạy lại nội dung không lỗi). Mật khẩu role do bộ chạy đặt dạng SCRAM verifier từ biến môi trường,
-- KHÔNG nằm trong file này (FR-INV-18).

-- Không ai ngoài owner dùng schema public / tạo bảng tạm / kết nối mặc định
REVOKE ALL ON SCHEMA public FROM PUBLIC;
DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;

-- Extension ở schema public (image postgis/postgis cài sẵn PostGIS vào public; PostGIS không chuyển schema được).
-- public: không ai CREATE; chỉ app_rw/projector_rw có USAGE để gọi hàm; viewer không có (ADR-019).
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Schema nghiệp vụ
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
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), r);
  END LOOP;
END $$;

-- USAGE schema (không role nào được CREATE)
GRANT USAGE ON SCHEMA core, audit, integration, reporting, public TO app_rw;
GRANT USAGE ON SCHEMA core, reporting, integration, public TO projector_rw;
GRANT USAGE ON SCHEMA reporting TO viewer_ro;
GRANT USAGE ON SCHEMA reporting_private, audit TO viewer_act;
GRANT USAGE ON SCHEMA audit TO audit_writer;
-- Hàm PostGIS/unaccent/pg_trgm tìm thấy không cần ghi schema
ALTER ROLE app_rw SET search_path = core, public;
ALTER ROLE projector_rw SET search_path = reporting, public;
ALTER ROLE viewer_ro SET search_path = reporting;

-- Quyền mặc định (ADR-011). CHỈ app_rw có mặc định, và chỉ ở core/integration/reporting(SELECT).
-- projector_rw, viewer_ro, viewer_act, audit_writer: KHÔNG có mặc định — GRANT tường minh từng bảng trong migration.
-- Bảng chỉ-thêm ở core: migration tạo bảng PHẢI `REVOKE UPDATE, DELETE` trong cùng file; bộ kiểm
-- `checkAppendOnlyPrivileges` (apps/api/src/db/privilege-checks.ts) chặn ở CI nếu quên.
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT SELECT, INSERT, UPDATE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA integration GRANT SELECT, INSERT ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA reporting GRANT SELECT ON TABLES TO app_rw;
-- audit: quyền INSERT cấp theo từng bảng khi tạo bảng (CP03), không mặc định.

-- Function: không mở EXECUTE cho PUBLIC (kể cả function tạo sau này)
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
