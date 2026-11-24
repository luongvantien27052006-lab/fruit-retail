-- 001_extension_privileges.sql — thu hồi quyền PUBLIC trên đối tượng của extension (CP03 lát 1, ADR-011, ADR-019).
-- Image postgis/postgis tạo sẵn trong POSTGRES_DB các extension postgis_topology, postgis_tiger_geocoder (schema
-- `topology`, `tiger`, `tiger_data`) và bảng/view PostGIS ở `public` với GRANT SELECT cho PUBLIC. Bộ kiểm
-- checkViewerRls (ADR-011 "Kiểm tra bắt buộc") phát hiện viewer_ro SELECT được các bảng đó. Dự án không dùng
-- topology/tiger ⇒ đóng hẳn; bảng PostGIS ở public chỉ mở cho role cần gọi hàm không gian.
-- Idempotent. Chạy bằng owner (superuser) như 000.

DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['topology', 'tiger', 'tiger_data'] LOOP
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', s);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM PUBLIC', s);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM PUBLIC', s);
      EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA %I FROM PUBLIC', s);
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
DO $$
BEGIN
  -- spatial_ref_sys cần cho ST_Transform/geography; chỉ role dùng PostGIS (app_rw, projector_rw)
  IF to_regclass('public.spatial_ref_sys') IS NOT NULL THEN
    GRANT SELECT ON public.spatial_ref_sys TO app_rw, projector_rw;
  END IF;
  IF to_regclass('public.geometry_columns') IS NOT NULL THEN
    GRANT SELECT ON public.geometry_columns, public.geography_columns TO app_rw, projector_rw;
  END IF;
END $$;
