-- 0010_org_defaults — CP04 lát 4 (tổ chức & NCC): vị trí "đang vận chuyển" (IN_TRANSIT) tự có cho MỌI cửa hàng / kho (§4.6).
-- Không đổi schema.prisma (chỉ SQL tay) ⇒ drift Prisma = 0.

-- Tạo cửa hàng / kho ⇒ thêm đúng một vị trí IN_TRANSIT (index locations_one_in_transit giữ "một mỗi nơi"). Cùng transaction
-- với INSERT gốc; quyền của người gọi (app_rw có INSERT locations). Mã/ tên cố định; API không cho tạo / lưu trữ IN_TRANSIT.
CREATE OR REPLACE FUNCTION core.add_in_transit_location() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_TABLE_NAME = 'stores' THEN
    INSERT INTO core.locations (id, store_id, type, code, name, sort)
    VALUES (gen_random_uuid(), NEW.id, 'IN_TRANSIT', 'IN_TRANSIT', 'Đang vận chuyển', 0);
  ELSE
    INSERT INTO core.locations (id, warehouse_id, type, code, name, sort)
    VALUES (gen_random_uuid(), NEW.id, 'IN_TRANSIT', 'IN_TRANSIT', 'Đang vận chuyển', 0);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER add_in_transit_location AFTER INSERT ON core.stores
  FOR EACH ROW EXECUTE FUNCTION core.add_in_transit_location();
CREATE TRIGGER add_in_transit_location AFTER INSERT ON core.warehouses
  FOR EACH ROW EXECUTE FUNCTION core.add_in_transit_location();

-- Bổ sung cho cửa hàng / kho đã có (chưa có IN_TRANSIT đang dùng). Mã 'IN_TRANSIT' đã bị một vị trí khác chiếm ⇒ hậu tố.
INSERT INTO core.locations (id, store_id, type, code, name, sort)
SELECT gen_random_uuid(), s.id, 'IN_TRANSIT',
       CASE WHEN EXISTS (SELECT 1 FROM core.locations x WHERE x.store_id = s.id AND x.code = 'IN_TRANSIT')
            THEN 'IN_TRANSIT_' || upper(substr(md5(gen_random_uuid()::text), 1, 6)) ELSE 'IN_TRANSIT' END,
       'Đang vận chuyển', 0
FROM core.stores s
WHERE NOT EXISTS (SELECT 1 FROM core.locations l WHERE l.store_id = s.id AND l.type = 'IN_TRANSIT' AND l.archived_at IS NULL);
INSERT INTO core.locations (id, warehouse_id, type, code, name, sort)
SELECT gen_random_uuid(), w.id, 'IN_TRANSIT',
       CASE WHEN EXISTS (SELECT 1 FROM core.locations x WHERE x.warehouse_id = w.id AND x.code = 'IN_TRANSIT')
            THEN 'IN_TRANSIT_' || upper(substr(md5(gen_random_uuid()::text), 1, 6)) ELSE 'IN_TRANSIT' END,
       'Đang vận chuyển', 0
FROM core.warehouses w
WHERE NOT EXISTS (SELECT 1 FROM core.locations l WHERE l.warehouse_id = w.id AND l.type = 'IN_TRANSIT' AND l.archived_at IS NULL);

-- IN_TRANSIT không lưu trữ / đổi loại / xóa được (tồn đang chuyển cần chỗ ghi — CP05/CP06); chặn cả owner để luồng nhập file
-- sau này không lọt (review bảo mật lát 4 G8: đổi type rồi mới lưu trữ, hoặc DELETE)
CREATE OR REPLACE FUNCTION core.locations_in_transit_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.type = 'IN_TRANSIT' THEN
      RAISE EXCEPTION 'locations: vị trí "đang vận chuyển" không xóa được' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (OLD.type = 'IN_TRANSIT') <> (NEW.type = 'IN_TRANSIT') THEN
    RAISE EXCEPTION 'locations: không đổi loại vị trí "đang vận chuyển"' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.type = 'IN_TRANSIT' AND NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
    RAISE EXCEPTION 'locations: vị trí "đang vận chuyển" không lưu trữ được' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER locations_in_transit_guard BEFORE UPDATE OR DELETE ON core.locations
  FOR EACH ROW EXECUTE FUNCTION core.locations_in_transit_guard();
