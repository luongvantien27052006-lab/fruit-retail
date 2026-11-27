-- 0009_catalog — CP04 lát 1: schema M04 (danh mục, đơn vị, giá, mã vạch, nhập file, mã lý do, bì, thương hiệu, NCC cơ bản
-- NC-27) + mở rộng M03 (stores §4.6, registers, locations). bundle_* / processing_recipe* để CP17 (nơi dùng), devices để CP07.
-- Phần 1: DDL theo schema.prisma (định dạng migrate diff).
-- CreateEnum
CREATE TYPE "core"."StorePosStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "core"."StoreAppStatus" AS ENUM ('ONLINE', 'PAUSED');

-- CreateEnum
CREATE TYPE "core"."LocationType" AS ENUM ('STORAGE', 'COLD_ROOM', 'SHELF', 'CHILLER', 'RIPENING', 'IN_TRANSIT');

-- CreateEnum
CREATE TYPE "core"."SaleUnitType" AS ENUM ('WEIGHT', 'PIECE_BY_WEIGHT', 'PIECE_FIXED', 'PACK_FIXED', 'PACK_VARIABLE', 'BUNDLE', 'SERVICE');

-- CreateEnum
CREATE TYPE "core"."UnitKind" AS ENUM ('WEIGHT', 'COUNT');

-- CreateEnum
CREATE TYPE "core"."PriceScope" AS ENUM ('GLOBAL', 'STORE');

-- CreateEnum
CREATE TYPE "core"."PriceField" AS ENUM ('PER_KG', 'PER_UNIT', 'SKU_UNIT');

-- CreateEnum
CREATE TYPE "core"."BarcodeRuleType" AS ENUM ('WEIGHT', 'PRICE', 'PRODUCT', 'BATCH', 'ORDER', 'STAFF');

-- CreateEnum
CREATE TYPE "core"."ImportType" AS ENUM ('CATALOG', 'SUPPLIER');

-- CreateEnum
CREATE TYPE "core"."ImportDuplicateMode" AS ENUM ('SKIP', 'UPDATE', 'STOP');

-- CreateEnum
CREATE TYPE "core"."ImportStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "core"."ReasonGroup" AS ENUM ('SPOILAGE', 'POS_LINE_DELETE', 'APP_ORDER_CANCEL', 'DELIVERY_FAILED', 'STOCKTAKE_VARIANCE', 'MANUAL_WEIGHT');

-- CreateEnum
CREATE TYPE "core"."SupplierType" AS ENUM ('FARM', 'COOPERATIVE', 'WHOLESALER', 'IMPORTER', 'OTHER');

-- AlterTable
ALTER TABLE "core"."stores" ADD COLUMN     "app_capacity_per_hour" INTEGER,
ADD COLUMN     "app_status" "core"."StoreAppStatus" NOT NULL DEFAULT 'PAUSED',
ADD COLUMN     "lat" DOUBLE PRECISION,
ADD COLUMN     "lng" DOUBLE PRECISION,
ADD COLUMN     "opening_hours" JSONB,
ADD COLUMN     "pos_status" "core"."StorePosStatus" NOT NULL DEFAULT 'CLOSED';

-- AlterTable
ALTER TABLE "core"."registers" ADD COLUMN     "archived_at" TIMESTAMPTZ(6),
ADD COLUMN     "name" TEXT;

-- CreateTable
CREATE TABLE "core"."locations" (
    "id" UUID NOT NULL,
    "store_id" UUID,
    "warehouse_id" UUID,
    "type" "core"."LocationType" NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."units" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "core"."UnitKind" NOT NULL,
    "fixed_g" INTEGER,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "units_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "core"."categories" (
    "id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."products" (
    "id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "origin" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."skus" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sku_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sale_unit_type" "core"."SaleUnitType" NOT NULL,
    "std_weight_g" INTEGER,
    "weight_min_g" INTEGER,
    "weight_max_g" INTEGER,
    "tare_g" INTEGER,
    "retail_price_per_kg" BIGINT,
    "retail_price_per_unit" BIGINT,
    "scale_plu" TEXT,
    "sold_by_scale" BOOLEAN NOT NULL DEFAULT false,
    "shelf_life_days" INTEGER,
    "storage_note" TEXT,
    "has_ripeness" BOOLEAN NOT NULL DEFAULT false,
    "shrink_norm_bps_week" INTEGER,
    "is_high_value" BOOLEAN NOT NULL DEFAULT false,
    "cold_required" BOOLEAN NOT NULL DEFAULT false,
    "alert_days_before_expiry" INTEGER,
    "stop_app_days_before_expiry" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "skus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."sku_units" (
    "id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "unit_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "factor_g" INTEGER,
    "factor_units" INTEGER,
    "is_variable" BOOLEAN NOT NULL DEFAULT false,
    "for_sale" BOOLEAN NOT NULL DEFAULT false,
    "for_purchase" BOOLEAN NOT NULL DEFAULT false,
    "barcode" TEXT,
    "price_per_unit" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "sku_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."store_prices" (
    "store_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "retail_price_per_kg" BIGINT,
    "retail_price_per_unit" BIGINT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "store_prices_pkey" PRIMARY KEY ("store_id","sku_id")
);

-- CreateTable
CREATE TABLE "core"."price_change_logs" (
    "id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "sku_unit_id" UUID,
    "store_id" UUID,
    "scope" "core"."PriceScope" NOT NULL,
    "field" "core"."PriceField" NOT NULL,
    "old_value" BIGINT,
    "new_value" BIGINT,
    "reason" TEXT NOT NULL,
    "changed_by" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."sku_default_locations" (
    "store_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,

    CONSTRAINT "sku_default_locations_pkey" PRIMARY KEY ("store_id","sku_id")
);

-- CreateTable
CREATE TABLE "core"."barcode_rules" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "type" "core"."BarcodeRuleType" NOT NULL,
    "pattern" TEXT NOT NULL,
    "value_scale" INTEGER NOT NULL DEFAULT 1,
    "ean13_checksum" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "barcode_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."import_jobs" (
    "id" UUID NOT NULL,
    "type" "core"."ImportType" NOT NULL,
    "file_id" UUID NOT NULL,
    "mode_on_duplicate" "core"."ImportDuplicateMode" NOT NULL,
    "dry_run" BOOLEAN NOT NULL,
    "status" "core"."ImportStatus" NOT NULL DEFAULT 'PENDING',
    "total_rows" INTEGER,
    "ok_rows" INTEGER,
    "skipped_rows" INTEGER,
    "error_rows" INTEGER,
    "report" JSONB,
    "error" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."reason_codes" (
    "group" "core"."ReasonGroup" NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "requires_note" BOOLEAN NOT NULL DEFAULT false,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "reason_codes_pkey" PRIMARY KEY ("group","code")
);

-- CreateTable
CREATE TABLE "core"."container_types" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tare_g" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "container_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."brand_settings" (
    "id" SMALLINT NOT NULL,
    "brand_name" TEXT NOT NULL,
    "hotline" TEXT,
    "display_address" TEXT,
    "receipt_footer" TEXT,
    "primary_color" TEXT,
    "privacy_url" TEXT,
    "logo_mono_file_id" UUID,
    "logo_color_file_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "brand_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."suppliers" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "core"."SupplierType" NOT NULL,
    "contact_name" TEXT,
    "phone_enc" BYTEA,
    "phone_hash" BYTEA,
    "bank_name" TEXT,
    "bank_enc" BYTEA,
    "payment_terms_days" INTEGER,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."supplier_skus" (
    "supplier_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "supplier_sku_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_skus_pkey" PRIMARY KEY ("supplier_id","sku_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "locations_store_id_code_key" ON "core"."locations"("store_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "locations_warehouse_id_code_key" ON "core"."locations"("warehouse_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "locations_id_store_id_key" ON "core"."locations"("id", "store_id");

-- CreateIndex
CREATE INDEX "categories_parent_id_idx" ON "core"."categories"("parent_id");

-- CreateIndex
CREATE INDEX "products_category_id_idx" ON "core"."products"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "skus_sku_code_key" ON "core"."skus"("sku_code");

-- CreateIndex
CREATE INDEX "skus_product_id_idx" ON "core"."skus"("product_id");

-- CreateIndex
CREATE INDEX "sku_units_sku_id_idx" ON "core"."sku_units"("sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "sku_units_id_sku_id_key" ON "core"."sku_units"("id", "sku_id");

-- CreateIndex
CREATE INDEX "store_prices_sku_id_idx" ON "core"."store_prices"("sku_id");

-- CreateIndex
CREATE INDEX "price_change_logs_sku_id_changed_at_idx" ON "core"."price_change_logs"("sku_id", "changed_at");

-- CreateIndex
CREATE INDEX "price_change_logs_store_id_sku_id_changed_at_idx" ON "core"."price_change_logs"("store_id", "sku_id", "changed_at");

-- CreateIndex
CREATE INDEX "price_change_logs_sku_unit_id_sku_id_idx" ON "core"."price_change_logs"("sku_unit_id", "sku_id");

-- CreateIndex
CREATE INDEX "price_change_logs_changed_by_idx" ON "core"."price_change_logs"("changed_by");

-- CreateIndex
CREATE INDEX "sku_default_locations_sku_id_idx" ON "core"."sku_default_locations"("sku_id");

-- CreateIndex
CREATE INDEX "sku_default_locations_location_id_store_id_idx" ON "core"."sku_default_locations"("location_id", "store_id");

-- CreateIndex
CREATE UNIQUE INDEX "barcode_rules_code_key" ON "core"."barcode_rules"("code");

-- CreateIndex
CREATE UNIQUE INDEX "barcode_rules_priority_key" ON "core"."barcode_rules"("priority");

-- CreateIndex
CREATE INDEX "import_jobs_created_by_created_at_idx" ON "core"."import_jobs"("created_by", "created_at");

-- CreateIndex
CREATE INDEX "import_jobs_file_id_idx" ON "core"."import_jobs"("file_id");

-- CreateIndex
CREATE UNIQUE INDEX "container_types_code_key" ON "core"."container_types"("code");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_code_key" ON "core"."suppliers"("code");

-- CreateIndex
CREATE INDEX "suppliers_phone_hash_idx" ON "core"."suppliers"("phone_hash");

-- CreateIndex
CREATE INDEX "supplier_skus_sku_id_idx" ON "core"."supplier_skus"("sku_id");

-- AddForeignKey
ALTER TABLE "core"."locations" ADD CONSTRAINT "locations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "core"."stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."locations" ADD CONSTRAINT "locations_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "core"."warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "core"."categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "core"."categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."skus" ADD CONSTRAINT "skus_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "core"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."sku_units" ADD CONSTRAINT "sku_units_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "core"."skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."sku_units" ADD CONSTRAINT "sku_units_unit_code_fkey" FOREIGN KEY ("unit_code") REFERENCES "core"."units"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."store_prices" ADD CONSTRAINT "store_prices_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "core"."stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."store_prices" ADD CONSTRAINT "store_prices_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "core"."skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."store_prices" ADD CONSTRAINT "store_prices_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."price_change_logs" ADD CONSTRAINT "price_change_logs_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "core"."skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."price_change_logs" ADD CONSTRAINT "price_change_logs_sku_unit_id_sku_id_fkey" FOREIGN KEY ("sku_unit_id", "sku_id") REFERENCES "core"."sku_units"("id", "sku_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."price_change_logs" ADD CONSTRAINT "price_change_logs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "core"."stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."price_change_logs" ADD CONSTRAINT "price_change_logs_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."sku_default_locations" ADD CONSTRAINT "sku_default_locations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "core"."stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."sku_default_locations" ADD CONSTRAINT "sku_default_locations_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "core"."skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."sku_default_locations" ADD CONSTRAINT "sku_default_locations_location_id_store_id_fkey" FOREIGN KEY ("location_id", "store_id") REFERENCES "core"."locations"("id", "store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."import_jobs" ADD CONSTRAINT "import_jobs_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "core"."files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."import_jobs" ADD CONSTRAINT "import_jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."brand_settings" ADD CONSTRAINT "brand_settings_logo_mono_file_id_fkey" FOREIGN KEY ("logo_mono_file_id") REFERENCES "core"."files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."brand_settings" ADD CONSTRAINT "brand_settings_logo_color_file_id_fkey" FOREIGN KEY ("logo_color_file_id") REFERENCES "core"."files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."brand_settings" ADD CONSTRAINT "brand_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."supplier_skus" ADD CONSTRAINT "supplier_skus_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "core"."suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."supplier_skus" ADD CONSTRAINT "supplier_skus_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "core"."skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────── Phần 2: SQL tay ───────────

-- ── 2.1. Ràng buộc dữ liệu ──
ALTER TABLE core.stores
  ADD CONSTRAINT stores_latlng CHECK ((lat IS NULL) = (lng IS NULL)
    AND (lat IS NULL OR (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180))),
  ADD CONSTRAINT stores_opening_hours CHECK (opening_hours IS NULL OR jsonb_typeof(opening_hours) = 'object'),
  ADD CONSTRAINT stores_app_capacity CHECK (app_capacity_per_hour IS NULL OR app_capacity_per_hour BETWEEN 0 AND 10000);
ALTER TABLE core.registers
  ADD CONSTRAINT registers_name CHECK (name IS NULL OR length(btrim(name)) BETWEEN 1 AND 100);

ALTER TABLE core.locations
  ADD CONSTRAINT locations_one_owner CHECK (num_nonnulls(store_id, warehouse_id) = 1),
  ADD CONSTRAINT locations_code CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  ADD CONSTRAINT locations_name CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  ADD CONSTRAINT locations_sort CHECK (sort >= 0);
-- một vị trí "đang vận chuyển" (chưa lưu trữ) mỗi kho / cửa hàng
CREATE UNIQUE INDEX locations_one_in_transit ON core.locations (COALESCE(store_id, warehouse_id))
  WHERE type = 'IN_TRANSIT' AND archived_at IS NULL;

ALTER TABLE core.units
  ADD CONSTRAINT units_code CHECK (code ~ '^[A-Z][A-Z0-9_]{0,15}$'),
  ADD CONSTRAINT units_name CHECK (length(btrim(name)) BETWEEN 1 AND 50),
  -- đơn vị khối lượng có số gram cố định; đơn vị đếm (hộp, thùng…) thì không
  ADD CONSTRAINT units_fixed_g CHECK ((kind = 'WEIGHT') = (fixed_g IS NOT NULL) AND (fixed_g IS NULL OR fixed_g > 0));

ALTER TABLE core.categories
  ADD CONSTRAINT categories_name CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  ADD CONSTRAINT categories_not_self CHECK (parent_id IS DISTINCT FROM id),
  ADD CONSTRAINT categories_sort CHECK (sort >= 0);
-- tên không trùng trong cùng nhánh (không phân biệt hoa thường), chỉ tính mục chưa lưu trữ
CREATE UNIQUE INDEX categories_sibling_name ON core.categories
  (COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name))) WHERE archived_at IS NULL;

ALTER TABLE core.products
  ADD CONSTRAINT products_name CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  ADD CONSTRAINT products_text CHECK (length(description) <= 2000 AND length(origin) <= 100);

-- SKU: kiểu bán quyết định giá / cân / PLU (§4.2–4.3). "Giá theo kg" = WEIGHT, PIECE_BY_WEIGHT, PACK_VARIABLE.
ALTER TABLE core.skus
  ADD CONSTRAINT skus_code CHECK (sku_code ~ '^[A-Z0-9][A-Z0-9_.-]{0,31}$'),
  ADD CONSTRAINT skus_name CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  ADD CONSTRAINT skus_weights_positive CHECK (
    (std_weight_g IS NULL OR std_weight_g BETWEEN 1 AND 100000)
    AND (weight_min_g IS NULL OR weight_min_g BETWEEN 1 AND 100000)
    AND (weight_max_g IS NULL OR weight_max_g BETWEEN 1 AND 100000)
    AND (tare_g IS NULL OR tare_g BETWEEN 0 AND 20000)),
  ADD CONSTRAINT skus_weight_range CHECK (
    (weight_min_g IS NULL OR weight_max_g IS NULL OR weight_min_g <= weight_max_g)
    AND (std_weight_g IS NULL OR weight_min_g IS NULL OR weight_min_g <= std_weight_g)
    AND (std_weight_g IS NULL OR weight_max_g IS NULL OR std_weight_g <= weight_max_g)),
  ADD CONSTRAINT skus_prices_positive CHECK (
    (retail_price_per_kg IS NULL OR retail_price_per_kg BETWEEN 1 AND 1000000000)
    AND (retail_price_per_unit IS NULL OR retail_price_per_unit BETWEEN 1 AND 1000000000)),
  -- giá/kg chỉ cho hàng tính theo cân; giá/đơn vị chỉ cho hàng tính theo cái/hộp/giỏ/lần
  ADD CONSTRAINT skus_price_kind CHECK (
    CASE WHEN sale_unit_type IN ('WEIGHT', 'PIECE_BY_WEIGHT', 'PACK_VARIABLE')
         THEN retail_price_per_unit IS NULL
         ELSE retail_price_per_kg IS NULL END),
  ADD CONSTRAINT skus_plu CHECK (scale_plu IS NULL OR (scale_plu ~ '^[0-9]{5}$' AND scale_plu <> '00000'
    AND sale_unit_type IN ('WEIGHT', 'PIECE_BY_WEIGHT', 'PACK_VARIABLE'))),
  ADD CONSTRAINT skus_sold_by_scale CHECK (NOT sold_by_scale OR scale_plu IS NOT NULL),
  -- giỏ/combo và dịch vụ không có cân, bì, PLU; dịch vụ không tồn kho ⇒ không hạn dùng/độ chín/giữ lạnh
  ADD CONSTRAINT skus_no_weight_kinds CHECK (sale_unit_type NOT IN ('BUNDLE', 'SERVICE')
    OR num_nonnulls(std_weight_g, weight_min_g, weight_max_g, tare_g) = 0),
  ADD CONSTRAINT skus_service CHECK (sale_unit_type <> 'SERVICE' OR (shelf_life_days IS NULL AND NOT has_ripeness
    AND NOT cold_required AND NOT is_high_value AND alert_days_before_expiry IS NULL
    AND stop_app_days_before_expiry IS NULL AND shrink_norm_bps_week IS NULL)),
  -- hộp cố định (tồn theo hộp) phải ghi định lượng hộp — dùng để kiểm định lượng khi đóng hộp và giá tham khảo app
  ADD CONSTRAINT skus_pack_fixed_weight CHECK (sale_unit_type <> 'PACK_FIXED' OR std_weight_g IS NOT NULL),
  ADD CONSTRAINT skus_shelf CHECK (
    (shelf_life_days IS NULL OR shelf_life_days BETWEEN 1 AND 3650)
    AND (alert_days_before_expiry IS NULL OR alert_days_before_expiry BETWEEN 0 AND 3650)
    AND (stop_app_days_before_expiry IS NULL OR stop_app_days_before_expiry BETWEEN 0 AND 3650)
    AND (shelf_life_days IS NULL OR alert_days_before_expiry IS NULL OR alert_days_before_expiry <= shelf_life_days)
    AND (shelf_life_days IS NULL OR stop_app_days_before_expiry IS NULL OR stop_app_days_before_expiry <= shelf_life_days)),
  ADD CONSTRAINT skus_shrink CHECK (shrink_norm_bps_week IS NULL OR shrink_norm_bps_week BETWEEN 0 AND 10000),
  ADD CONSTRAINT skus_storage_note CHECK (length(storage_note) <= 500),
  ADD CONSTRAINT skus_version CHECK (version >= 0);
-- PLU duy nhất trong các SKU đang dùng (SKU lưu trữ trả PLU lại cho SKU khác)
CREATE UNIQUE INDEX skus_scale_plu_active ON core.skus (scale_plu) WHERE scale_plu IS NOT NULL AND archived_at IS NULL;

-- Đơn vị bán/mua: đúng MỘT cách quy đổi (§21.3.1)
ALTER TABLE core.sku_units
  ADD CONSTRAINT sku_units_one_factor CHECK (num_nonnulls(factor_g, factor_units) + is_variable::int = 1),
  ADD CONSTRAINT sku_units_factor_positive CHECK (
    (factor_g IS NULL OR factor_g BETWEEN 1 AND 1000000) AND (factor_units IS NULL OR factor_units BETWEEN 1 AND 100000)),
  ADD CONSTRAINT sku_units_use CHECK (for_sale OR for_purchase),
  -- thùng/sọt danh nghĩa chỉ để mua: bán phải quy đổi cứng được (cân thực luôn khi nhận — §5.3)
  ADD CONSTRAINT sku_units_variable_not_for_sale CHECK (NOT (is_variable AND for_sale)),
  ADD CONSTRAINT sku_units_price CHECK (price_per_unit IS NULL OR (price_per_unit BETWEEN 1 AND 1000000000 AND for_sale)),
  ADD CONSTRAINT sku_units_name CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  -- mã vạch hàng: số/chữ in hoa; KHÔNG dùng dải 20–29 dài 13 số (dành cho tem cân / tem nội bộ — §6.5, §21.3.8)
  ADD CONSTRAINT sku_units_barcode CHECK (barcode IS NULL OR (barcode ~ '^[0-9A-Z-]{4,32}$' AND barcode !~ '^2[0-9]{12}$'));
CREATE UNIQUE INDEX sku_units_barcode_active ON core.sku_units (barcode) WHERE barcode IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX sku_units_name_active ON core.sku_units (sku_id, lower(btrim(name))) WHERE archived_at IS NULL;

ALTER TABLE core.store_prices
  ADD CONSTRAINT store_prices_some CHECK (num_nonnulls(retail_price_per_kg, retail_price_per_unit) = 1),
  ADD CONSTRAINT store_prices_positive CHECK (
    (retail_price_per_kg IS NULL OR retail_price_per_kg BETWEEN 1 AND 1000000000)
    AND (retail_price_per_unit IS NULL OR retail_price_per_unit BETWEEN 1 AND 1000000000));

ALTER TABLE core.price_change_logs
  ADD CONSTRAINT price_change_logs_scope CHECK ((scope = 'STORE') = (store_id IS NOT NULL)),
  ADD CONSTRAINT price_change_logs_field CHECK ((field = 'SKU_UNIT') = (sku_unit_id IS NOT NULL)),
  -- giá riêng cửa hàng chỉ áp cho giá chính của SKU (đơn vị phụ dùng giá chung)
  ADD CONSTRAINT price_change_logs_unit_global CHECK (field <> 'SKU_UNIT' OR scope = 'GLOBAL'),
  ADD CONSTRAINT price_change_logs_values CHECK ((old_value IS NULL OR old_value BETWEEN 1 AND 1000000000) AND (new_value IS NULL OR new_value BETWEEN 1 AND 1000000000)
    AND old_value IS DISTINCT FROM new_value),
  ADD CONSTRAINT price_change_logs_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 500);

ALTER TABLE core.barcode_rules
  ADD CONSTRAINT barcode_rules_code CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,15}$'),
  ADD CONSTRAINT barcode_rules_name CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  ADD CONSTRAINT barcode_rules_priority CHECK (priority BETWEEN 1 AND 10000),
  ADD CONSTRAINT barcode_rules_scale CHECK (value_scale IN (1, 10, 100)),
  -- mẫu: hằng (số/chữ in hoa/-) và token {PLU:n} {W:n} {P:n} {C} {ID} {CODE}
  ADD CONSTRAINT barcode_rules_pattern CHECK (length(pattern) <= 64
    AND pattern ~ '^([0-9A-Z-]|\{PLU:[1-9]\}|\{W:[1-9]\}|\{P:[1-9]\}|\{C\}|\{ID\}|\{CODE\})+$'),
  ADD CONSTRAINT barcode_rules_weight CHECK (type <> 'WEIGHT'
    OR (pattern ~ '\{PLU:[1-9]\}' AND pattern ~ '\{W:[1-9]\}' AND pattern !~ '\{P:')),
  ADD CONSTRAINT barcode_rules_price CHECK (type <> 'PRICE'
    OR (pattern ~ '\{PLU:[1-9]\}' AND pattern ~ '\{P:[1-9]\}' AND pattern !~ '\{W:')),
  ADD CONSTRAINT barcode_rules_checksum CHECK (NOT ean13_checksum OR pattern ~ '\{C\}$');

ALTER TABLE core.import_jobs
  ADD CONSTRAINT import_jobs_counts CHECK ((total_rows IS NULL OR total_rows >= 0) AND (ok_rows IS NULL OR ok_rows >= 0)
    AND (skipped_rows IS NULL OR skipped_rows >= 0) AND (error_rows IS NULL OR error_rows >= 0)),
  ADD CONSTRAINT import_jobs_report CHECK (report IS NULL OR jsonb_typeof(report) = 'object'),
  ADD CONSTRAINT import_jobs_status CHECK (
    (status <> 'PENDING' OR (started_at IS NULL AND finished_at IS NULL))
    AND (status <> 'RUNNING' OR (started_at IS NOT NULL AND finished_at IS NULL))
    AND (status NOT IN ('COMPLETED', 'FAILED') OR finished_at IS NOT NULL)
    AND (status <> 'FAILED' OR error IS NOT NULL)
    AND (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)),
  ADD CONSTRAINT import_jobs_count_sum CHECK (total_rows IS NULL
    OR COALESCE(ok_rows, 0) + COALESCE(skipped_rows, 0) + COALESCE(error_rows, 0) <= total_rows),
  ADD CONSTRAINT import_jobs_error CHECK (length(error) <= 2000);

ALTER TABLE core.reason_codes
  ADD CONSTRAINT reason_codes_code CHECK (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  ADD CONSTRAINT reason_codes_name CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  ADD CONSTRAINT reason_codes_sort CHECK (sort >= 0);

ALTER TABLE core.container_types
  ADD CONSTRAINT container_types_code CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  ADD CONSTRAINT container_types_name CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  ADD CONSTRAINT container_types_tare CHECK (tare_g BETWEEN 1 AND 20000);

ALTER TABLE core.brand_settings
  ADD CONSTRAINT brand_settings_singleton CHECK (id = 1),
  ADD CONSTRAINT brand_settings_name CHECK (length(btrim(brand_name)) BETWEEN 1 AND 100),
  ADD CONSTRAINT brand_settings_color CHECK (primary_color IS NULL OR primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  ADD CONSTRAINT brand_settings_privacy_url CHECK (privacy_url IS NULL OR privacy_url ~ '^https://[^\s]{1,500}$'),
  ADD CONSTRAINT brand_settings_text CHECK (length(hotline) <= 30 AND length(display_address) <= 300
    AND length(receipt_footer) <= 300);

ALTER TABLE core.suppliers
  ADD CONSTRAINT suppliers_code CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  ADD CONSTRAINT suppliers_name CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  -- SĐT mã hóa đi cặp với hash tra cứu (ADR-015); HMAC-SHA256 = 32 byte
  ADD CONSTRAINT suppliers_phone_pair CHECK ((phone_enc IS NULL) = (phone_hash IS NULL)
    AND (phone_hash IS NULL OR octet_length(phone_hash) = 32)),
  -- version(1) | key_id(2) | nonce(12) | ciphertext | tag(16) ⇒ tối thiểu 31 byte
  ADD CONSTRAINT suppliers_enc_len CHECK ((phone_enc IS NULL OR octet_length(phone_enc) BETWEEN 32 AND 1024)
    AND (bank_enc IS NULL OR octet_length(bank_enc) BETWEEN 32 AND 2048)),
  ADD CONSTRAINT suppliers_terms CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365),
  ADD CONSTRAINT suppliers_text CHECK (length(contact_name) <= 100 AND length(bank_name) <= 100 AND length(note) <= 2000);
ALTER TABLE core.supplier_skus
  ADD CONSTRAINT supplier_skus_code CHECK (supplier_sku_code IS NULL OR length(btrim(supplier_sku_code)) BETWEEN 1 AND 64);

-- ── 2.2. Trigger ──

-- Cây danh mục: không vòng, sâu tối đa 5 cấp. Khóa advisory chung cho cây ⇒ hai lần đổi cha đồng thời không tạo vòng.
CREATE OR REPLACE FUNCTION core.categories_tree_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE depth int;
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN RETURN NEW; END IF;
  -- snapshot của REPEATABLE READ/SERIALIZABLE không thấy lần đổi cha vừa commit ⇒ chỉ chấp nhận READ COMMITTED (ADR-016)
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'categories: đổi cây danh mục phải chạy ở READ COMMITTED' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('catalog:category_tree', 0));
  WITH RECURSIVE up(id, parent_id, n, path) AS (
    SELECT c.id, c.parent_id, 1, ARRAY[c.id] FROM core.categories c WHERE c.id = NEW.parent_id
    UNION ALL
    SELECT c.id, c.parent_id, up.n + 1, up.path || c.id
    FROM core.categories c JOIN up ON c.id = up.parent_id
    WHERE NOT c.id = ANY (up.path) AND up.n < 10
  )
  SELECT CASE WHEN bool_or(id = NEW.id) THEN -1 ELSE max(n) END INTO depth FROM up;
  IF depth = -1 THEN
    RAISE EXCEPTION 'categories: đổi cha tạo vòng' USING ERRCODE = 'check_violation';
  END IF;
  -- độ sâu của NEW = độ sâu cha + 1, cộng chiều sâu cây con của NEW (khi đổi cha)
  IF depth + 1 + (CASE WHEN TG_OP = 'UPDATE' THEN (
       WITH RECURSIVE down(id, n) AS (
         SELECT c.id, 1 FROM core.categories c WHERE c.parent_id = NEW.id
         UNION ALL SELECT c.id, down.n + 1 FROM core.categories c JOIN down ON c.parent_id = down.id WHERE down.n < 10)
       SELECT COALESCE(max(n), 0) FROM down) ELSE 0 END) > 5 THEN
    RAISE EXCEPTION 'categories: cây danh mục sâu tối đa 5 cấp' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER categories_tree_guard BEFORE INSERT OR UPDATE OF parent_id ON core.categories
  FOR EACH ROW EXECUTE FUNCTION core.categories_tree_guard();

-- Đơn vị của SKU phải khớp đơn vị tồn của kiểu bán và loại đơn vị (§21.3.1). Kiểu bán, mã đơn vị, hệ số không sửa được
-- (quyền theo cột) ⇒ phần quy đổi chỉ kiểm khi INSERT; giá đơn vị sửa được ⇒ kiểm cả UPDATE OF price_per_unit.
CREATE OR REPLACE FUNCTION core.sku_units_kind_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE t core."SaleUnitType"; k core."UnitKind"; fg int; arch timestamptz;
BEGIN
  SELECT s.sale_unit_type INTO t FROM core.skus s WHERE s.id = NEW.sku_id;
  IF t IS NULL THEN RETURN NEW; END IF; -- FK báo lỗi
  IF TG_OP = 'INSERT' THEN
    SELECT u.kind, u.fixed_g, u.archived_at INTO k, fg, arch FROM core.units u WHERE u.code = NEW.unit_code;
    IF arch IS NOT NULL THEN
      RAISE EXCEPTION 'sku_units: đơn vị % đã lưu trữ', NEW.unit_code USING ERRCODE = 'check_violation';
    END IF;
    -- đơn vị khối lượng (kg) quy đổi đúng số gram cố định của nó
    IF k = 'WEIGHT' AND NEW.factor_g IS DISTINCT FROM fg THEN
      RAISE EXCEPTION 'sku_units: đơn vị % phải quy đổi đúng % g', NEW.unit_code, fg USING ERRCODE = 'check_violation';
    END IF;
    IF t IN ('WEIGHT', 'PACK_VARIABLE') AND NEW.factor_units IS NOT NULL THEN
      RAISE EXCEPTION 'sku_units: SKU % tồn theo gram — đơn vị phải quy đổi ra gram hoặc là danh nghĩa', t
        USING ERRCODE = 'check_violation';
    END IF;
    IF t IN ('PIECE_FIXED', 'PACK_FIXED', 'BUNDLE', 'SERVICE') AND NEW.factor_g IS NOT NULL THEN
      RAISE EXCEPTION 'sku_units: SKU % tồn theo đơn vị đếm — đơn vị phải quy đổi ra số đơn vị', t
        USING ERRCODE = 'check_violation';
    END IF;
    -- thùng/sọt danh nghĩa = cân thực khi nhận ⇒ chỉ cho SKU tồn theo gram (hàng đếm dùng factor_units, vd. thùng 24 quả)
    IF NEW.is_variable AND t NOT IN ('WEIGHT', 'PIECE_BY_WEIGHT', 'PACK_VARIABLE') THEN
      RAISE EXCEPTION 'sku_units: đơn vị danh nghĩa (cân khi nhận) chỉ dùng cho hàng tồn theo gram' USING ERRCODE = 'check_violation';
    END IF;
    -- dịch vụ không nhập kho; giỏ/combo là hàng lắp, không mua
    IF t IN ('SERVICE', 'BUNDLE') AND NEW.for_purchase THEN
      RAISE EXCEPTION 'sku_units: SKU % không mua/nhập từ NCC', t USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- một nguồn giá: đơn vị gốc (kg của hàng cân, 1 đơn vị của hàng đếm) lấy giá của SKU; quả theo cân luôn tính đ/kg
  IF NEW.price_per_unit IS NOT NULL AND (
       t = 'PIECE_BY_WEIGHT'
    OR (t IN ('WEIGHT', 'PACK_VARIABLE') AND NEW.factor_g = 1000)
    OR (t NOT IN ('WEIGHT', 'PIECE_BY_WEIGHT', 'PACK_VARIABLE') AND NEW.factor_units = 1)) THEN
    RAISE EXCEPTION 'sku_units: đơn vị gốc / quả theo cân dùng giá của SKU, không đặt giá riêng' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sku_units_kind_guard BEFORE INSERT OR UPDATE OF price_per_unit ON core.sku_units
  FOR EACH ROW EXECUTE FUNCTION core.sku_units_kind_guard();

-- Giá theo cửa hàng phải đúng loại giá của SKU (giá/kg ↔ hàng cân)
CREATE OR REPLACE FUNCTION core.store_prices_kind_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE t core."SaleUnitType";
BEGIN
  SELECT s.sale_unit_type INTO t FROM core.skus s WHERE s.id = NEW.sku_id;
  IF t IS NULL THEN RETURN NEW; END IF;
  IF (t IN ('WEIGHT', 'PIECE_BY_WEIGHT', 'PACK_VARIABLE')) <> (NEW.retail_price_per_kg IS NOT NULL) THEN
    RAISE EXCEPTION 'store_prices: SKU % phải có đúng loại giá (giá/kg cho hàng cân, giá/đơn vị cho hàng đếm)', t
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER store_prices_kind_guard BEFORE INSERT OR UPDATE ON core.store_prices
  FOR EACH ROW EXECUTE FUNCTION core.store_prices_kind_guard();

-- Lịch sử giá (review lát 1 C1): là nguồn tra "giá hiệu lực tại thời điểm" nên phải có THỨ TỰ đúng theo từng khóa giá
-- (sku, cửa hàng, loại giá, đơn vị):
--  * khóa advisory theo khóa giá ⇒ các lần ghi cùng khóa nối tiếp nhau;
--  * changed_at = clock_timestamp() lấy SAU khi có khóa (không phải now() = lúc bắt đầu transaction) ⇒ tăng dần theo khóa;
--  * old_value phải bằng new_value của bản ghi trước cùng khóa (bản đầu: old_value NULL) ⇒ chuỗi liền, không chen ngang.
-- Thứ tự đọc: ORDER BY changed_at DESC, id DESC. Giá thực thu luôn là giá chụp trên dòng bán; log để tra cứu/kiểm toán.
CREATE OR REPLACE FUNCTION core.price_change_logs_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE t core."SaleUnitType"; prev_found boolean; prev bigint;
BEGIN
  SELECT s.sale_unit_type INTO t FROM core.skus s WHERE s.id = NEW.sku_id;
  IF t IS NOT NULL AND NEW.field <> 'SKU_UNIT'
     AND (t IN ('WEIGHT', 'PIECE_BY_WEIGHT', 'PACK_VARIABLE')) <> (NEW.field = 'PER_KG') THEN
    RAISE EXCEPTION 'price_change_logs: loại giá % không hợp kiểu bán %', NEW.field, t USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'price:' || NEW.sku_id::text || ':' || COALESCE(NEW.store_id::text, '-') || ':' || NEW.field::text || ':'
      || COALESCE(NEW.sku_unit_id::text, '-'), 0));
  SELECT true, l.new_value INTO prev_found, prev FROM core.price_change_logs l
  WHERE l.sku_id = NEW.sku_id AND l.store_id IS NOT DISTINCT FROM NEW.store_id AND l.field = NEW.field
    AND l.sku_unit_id IS NOT DISTINCT FROM NEW.sku_unit_id
  ORDER BY l.changed_at DESC, l.id DESC LIMIT 1;
  IF COALESCE(prev_found, false) AND NEW.old_value IS DISTINCT FROM prev THEN
    RAISE EXCEPTION 'price_change_logs: giá cũ % không khớp bản ghi trước (%)', NEW.old_value, prev USING ERRCODE = 'check_violation';
  END IF;
  IF NOT COALESCE(prev_found, false) AND NEW.old_value IS NOT NULL THEN
    RAISE EXCEPTION 'price_change_logs: bản ghi đầu của một giá phải có old_value NULL' USING ERRCODE = 'check_violation';
  END IF;
  NEW.changed_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER price_change_logs_guard BEFORE INSERT ON core.price_change_logs
  FOR EACH ROW EXECUTE FUNCTION core.price_change_logs_guard();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON core.price_change_logs
  FOR EACH ROW EXECUTE FUNCTION core.raise_immutable();
CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON core.price_change_logs
  FOR EACH STATEMENT EXECUTE FUNCTION core.raise_immutable();

-- Review lát 1 N1: mọi giá đang có hiệu lực phải khớp bản ghi lịch sử mới nhất của nó — kiểm lúc COMMIT (constraint trigger
-- DEFERRABLE INITIALLY DEFERRED) ⇒ API ghi giá và log trong cùng transaction, thứ tự tùy ý; thiếu log ⇒ rollback.
CREATE OR REPLACE FUNCTION core.price_log_latest(p_sku uuid, p_store uuid, p_field core."PriceField", p_unit uuid)
  RETURNS TABLE (found boolean, val bigint)
  LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$
  SELECT true, l.new_value FROM core.price_change_logs l
  WHERE l.sku_id = p_sku AND l.store_id IS NOT DISTINCT FROM p_store AND l.field = p_field
    AND l.sku_unit_id IS NOT DISTINCT FROM p_unit
  ORDER BY l.changed_at DESC, l.id DESC LIMIT 1
$$;
-- lát 3 dùng để tra giá hiện hành của một khóa giá; trigger dưới chạy với quyền app_rw ⇒ cần EXECUTE
GRANT EXECUTE ON FUNCTION core.price_log_latest(uuid, uuid, core."PriceField", uuid) TO app_rw;
CREATE OR REPLACE FUNCTION core.price_log_required() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE cur_kg bigint; cur_unit bigint; cur bigint; f boolean; v bigint; k_sku uuid; k_store uuid;
BEGIN
  IF TG_TABLE_NAME = 'skus' THEN
    SELECT s.retail_price_per_kg, s.retail_price_per_unit INTO cur_kg, cur_unit FROM core.skus s WHERE s.id = NEW.id;
    SELECT x.found, x.val INTO f, v FROM core.price_log_latest(NEW.id, NULL, 'PER_KG', NULL) x;
    IF COALESCE(v, -1) IS DISTINCT FROM COALESCE(cur_kg, -1) THEN
      RAISE EXCEPTION 'skus: giá/kg của SKU % đổi mà không ghi price_change_logs', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    SELECT x.found, x.val INTO f, v FROM core.price_log_latest(NEW.id, NULL, 'PER_UNIT', NULL) x;
    IF COALESCE(v, -1) IS DISTINCT FROM COALESCE(cur_unit, -1) THEN
      RAISE EXCEPTION 'skus: giá/đơn vị của SKU % đổi mà không ghi price_change_logs', NEW.id USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'sku_units' THEN
    SELECT u.price_per_unit INTO cur FROM core.sku_units u WHERE u.id = NEW.id;
    SELECT x.found, x.val INTO f, v FROM core.price_log_latest(NEW.sku_id, NULL, 'SKU_UNIT', NEW.id) x;
    IF COALESCE(v, -1) IS DISTINCT FROM COALESCE(cur, -1) THEN
      RAISE EXCEPTION 'sku_units: giá của đơn vị % đổi mà không ghi price_change_logs', NEW.id USING ERRCODE = 'check_violation';
    END IF;
  ELSE -- store_prices (INSERT / UPDATE / DELETE)
    IF TG_OP = 'DELETE' THEN k_sku := OLD.sku_id; k_store := OLD.store_id; ELSE k_sku := NEW.sku_id; k_store := NEW.store_id; END IF;
    BEGIN
      SELECT p.retail_price_per_kg, p.retail_price_per_unit INTO cur_kg, cur_unit
      FROM core.store_prices p WHERE p.store_id = k_store AND p.sku_id = k_sku;
      SELECT x.found, x.val INTO f, v FROM core.price_log_latest(k_sku, k_store, 'PER_KG', NULL) x;
      IF COALESCE(v, -1) IS DISTINCT FROM COALESCE(cur_kg, -1) THEN
        RAISE EXCEPTION 'store_prices: giá/kg riêng cửa hàng đổi mà không ghi price_change_logs' USING ERRCODE = 'check_violation';
      END IF;
      SELECT x.found, x.val INTO f, v FROM core.price_log_latest(k_sku, k_store, 'PER_UNIT', NULL) x;
      IF COALESCE(v, -1) IS DISTINCT FROM COALESCE(cur_unit, -1) THEN
        RAISE EXCEPTION 'store_prices: giá/đơn vị riêng cửa hàng đổi mà không ghi price_change_logs' USING ERRCODE = 'check_violation';
      END IF;
    END;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER price_log_required AFTER INSERT OR UPDATE OF retail_price_per_kg, retail_price_per_unit
  ON core.skus DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.price_log_required();
CREATE CONSTRAINT TRIGGER price_log_required AFTER INSERT OR UPDATE OF price_per_unit
  ON core.sku_units DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.price_log_required();
CREATE CONSTRAINT TRIGGER price_log_required AFTER INSERT OR UPDATE OR DELETE
  ON core.store_prices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.price_log_required();

-- Vị trí mặc định: vị trí đang dùng, không phải "đang vận chuyển"
CREATE OR REPLACE FUNCTION core.sku_default_locations_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.locations l
                 WHERE l.id = NEW.location_id AND l.archived_at IS NULL AND l.type <> 'IN_TRANSIT' FOR SHARE) THEN
    RAISE EXCEPTION 'sku_default_locations: vị trí đã lưu trữ hoặc là "đang vận chuyển"' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sku_default_locations_guard BEFORE INSERT OR UPDATE ON core.sku_default_locations
  FOR EACH ROW EXECUTE FUNCTION core.sku_default_locations_guard();

-- Lượt nhập chỉ đi tới: PENDING → RUNNING → COMPLETED | FAILED (PENDING → FAILED khi kiểm file hỏng); kết thúc là cuối
CREATE OR REPLACE FUNCTION core.import_jobs_transition() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' THEN
      RAISE EXCEPTION 'import_jobs: lượt nhập mới phải PENDING' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('COMPLETED', 'FAILED') THEN
    RAISE EXCEPTION 'import_jobs: lượt nhập đã kết thúc' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('RUNNING', 'FAILED'))
    OR (OLD.status = 'RUNNING' AND NEW.status IN ('COMPLETED', 'FAILED'))) THEN
    RAISE EXCEPTION 'import_jobs: chuyển trạng thái % → % không hợp lệ', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'import_jobs: mốc bắt đầu bất biến' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER import_jobs_transition BEFORE INSERT OR UPDATE ON core.import_jobs
  FOR EACH ROW EXECUTE FUNCTION core.import_jobs_transition();

-- Thời điểm do server đặt (mẫu 0001)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['core.locations', 'core.categories', 'core.products', 'core.skus', 'core.sku_units',
                           'core.barcode_rules', 'core.import_jobs', 'core.container_types', 'core.suppliers',
                           'core.supplier_skus'] LOOP
    EXECUTE format('CREATE TRIGGER set_created BEFORE INSERT ON %s FOR EACH ROW EXECUTE FUNCTION core.set_created_now()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['core.categories', 'core.products', 'core.skus', 'core.sku_units', 'core.store_prices',
                           'core.barcode_rules', 'core.brand_settings', 'core.suppliers'] LOOP
    EXECUTE format('CREATE TRIGGER touch_updated BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at()', t);
  END LOOP;
END $$;

-- ── 2.3. Quyền (ADR-011): default privileges cấp UPDATE cả bảng ⇒ thu lại, mở theo cột; không TRUNCATE ──
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['core.locations', 'core.units', 'core.categories', 'core.products', 'core.skus',
                           'core.sku_units', 'core.store_prices', 'core.price_change_logs', 'core.sku_default_locations',
                           'core.barcode_rules', 'core.import_jobs', 'core.reason_codes', 'core.container_types',
                           'core.brand_settings', 'core.suppliers', 'core.supplier_skus'] LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM app_rw', t);
  END LOOP;
END $$;
-- cột bất biến (không có trong danh sách): mã (code / sku_code), kiểu bán, hệ số quy đổi, đơn vị gốc, units.kind/fixed_g, chủ của vị trí,
-- loại quy tắc mã vạch, loại/tệp/chế độ của lượt nhập, mốc tạo
GRANT UPDATE (lat, lng, opening_hours, pos_status, app_status, app_capacity_per_hour) ON core.stores TO app_rw;
GRANT UPDATE (name, archived_at) ON core.registers TO app_rw;
GRANT UPDATE (name, sort, archived_at) ON core.locations TO app_rw;
GRANT UPDATE (name, archived_at) ON core.units TO app_rw;
GRANT UPDATE (parent_id, name, sort, updated_at, archived_at) ON core.categories TO app_rw;
GRANT UPDATE (category_id, name, description, origin, updated_at, archived_at) ON core.products TO app_rw;
GRANT UPDATE (product_id, name, std_weight_g, weight_min_g, weight_max_g, tare_g, retail_price_per_kg,
              retail_price_per_unit, scale_plu, sold_by_scale, shelf_life_days, storage_note, has_ripeness,
              shrink_norm_bps_week, is_high_value, cold_required, alert_days_before_expiry, stop_app_days_before_expiry,
              updated_at, archived_at, version) ON core.skus TO app_rw;
GRANT UPDATE (name, for_sale, for_purchase, barcode, price_per_unit, updated_at, archived_at) ON core.sku_units TO app_rw;
GRANT UPDATE (retail_price_per_kg, retail_price_per_unit, updated_at, updated_by) ON core.store_prices TO app_rw;
GRANT DELETE ON core.store_prices TO app_rw;                 -- bỏ giá riêng ⇒ về giá chung (ghi lịch sử new_value NULL)
GRANT UPDATE (location_id) ON core.sku_default_locations TO app_rw;
GRANT DELETE ON core.sku_default_locations TO app_rw;
GRANT UPDATE (name, priority, pattern, value_scale, ean13_checksum, enabled, updated_at) ON core.barcode_rules TO app_rw;
GRANT UPDATE (status, total_rows, ok_rows, skipped_rows, error_rows, report, error, started_at, finished_at)
  ON core.import_jobs TO app_rw;
GRANT UPDATE (name, requires_note, sort, archived_at) ON core.reason_codes TO app_rw;
GRANT UPDATE (name, tare_g, archived_at) ON core.container_types TO app_rw;
REVOKE INSERT ON core.brand_settings FROM app_rw;            -- đúng một dòng, tạo ở đây
GRANT UPDATE (brand_name, hotline, display_address, receipt_footer, primary_color, privacy_url, logo_mono_file_id,
              logo_color_file_id, updated_at, updated_by) ON core.brand_settings TO app_rw;
GRANT UPDATE (name, type, contact_name, phone_enc, phone_hash, bank_name, bank_enc, payment_terms_days, note, updated_at,
              archived_at) ON core.suppliers TO app_rw;
GRANT UPDATE (supplier_sku_code) ON core.supplier_skus TO app_rw;
GRANT DELETE ON core.supplier_skus TO app_rw;
-- price_change_logs: chỉ SELECT, INSERT (default) — trigger raise_immutable chặn cả owner

-- ── 2.4. Seed tham chiếu (§19.7) — id seed dùng gen_random_uuid() (không phải UUID v7 của ứng dụng) ──
INSERT INTO core.units (code, name, kind, fixed_g) VALUES
  ('KG', 'kg', 'WEIGHT', 1000),
  ('PIECE', 'quả', 'COUNT', NULL),
  ('PACK', 'hộp', 'COUNT', NULL),
  ('TRAY', 'khay', 'COUNT', NULL),
  ('BAG', 'túi', 'COUNT', NULL),
  ('BUNCH', 'nải / chùm', 'COUNT', NULL),
  ('BOX', 'thùng', 'COUNT', NULL),
  ('CRATE', 'sọt', 'COUNT', NULL),
  ('BASKET', 'giỏ', 'COUNT', NULL),
  ('SERVICE', 'lần', 'COUNT', NULL);

-- Phụ lục D; "OTHER" bắt buộc ghi chú
INSERT INTO core.reason_codes ("group", code, name, requires_note, sort) VALUES
  ('SPOILAGE', 'DAMAGED_TRANSPORT', 'Dập khi vận chuyển', false, 10),
  ('SPOILAGE', 'OVERRIPE', 'Chín quá', false, 20),
  ('SPOILAGE', 'ROTTEN', 'Hỏng / thối', false, 30),
  ('SPOILAGE', 'EXPIRED', 'Hết hạn', false, 40),
  ('SPOILAGE', 'SUPPLIER_DEFECT', 'Lỗi từ nhà cung cấp', false, 50),
  ('SPOILAGE', 'OTHER', 'Khác', true, 90),
  ('POS_LINE_DELETE', 'CUSTOMER_CHANGED_MIND', 'Khách đổi ý', false, 10),
  ('POS_LINE_DELETE', 'WRONG_ITEM', 'Chọn nhầm hàng', false, 20),
  ('POS_LINE_DELETE', 'WRONG_WEIGHT', 'Cân sai', false, 30),
  ('POS_LINE_DELETE', 'OTHER', 'Khác', true, 90),
  ('APP_ORDER_CANCEL', 'CUSTOMER_REQUEST', 'Khách yêu cầu hủy', false, 10),
  ('APP_ORDER_CANCEL', 'OUT_OF_STOCK', 'Hết hàng', false, 20),
  ('APP_ORDER_CANCEL', 'PAYMENT_TIMEOUT', 'Quá hạn thanh toán', false, 30),
  ('APP_ORDER_CANCEL', 'STORE_OVERLOAD', 'Cửa hàng quá tải', false, 40),
  ('APP_ORDER_CANCEL', 'OUT_OF_ZONE', 'Ngoài vùng giao', false, 50),
  ('DELIVERY_FAILED', 'NO_ANSWER', 'Không liên lạc được', false, 10),
  ('DELIVERY_FAILED', 'WRONG_ADDRESS', 'Sai địa chỉ', false, 20),
  ('DELIVERY_FAILED', 'CUSTOMER_REFUSED', 'Khách từ chối nhận', false, 30),
  ('DELIVERY_FAILED', 'DAMAGED_IN_TRANSIT', 'Hư hỏng khi giao', false, 40),
  ('DELIVERY_FAILED', 'WEATHER', 'Thời tiết', false, 50),
  ('STOCKTAKE_VARIANCE', 'NATURAL_SHRINK', 'Hao hụt tự nhiên', false, 10),
  ('STOCKTAKE_VARIANCE', 'UNRECORDED_SPOILAGE', 'Hủy chưa ghi', false, 20),
  ('STOCKTAKE_VARIANCE', 'UNRECORDED_SAMPLING', 'Cho thử chưa ghi', false, 30),
  ('STOCKTAKE_VARIANCE', 'MISCOUNT', 'Đếm / cân nhầm', false, 40),
  ('STOCKTAKE_VARIANCE', 'THEFT_SUSPECTED', 'Nghi mất cắp', true, 50),
  ('STOCKTAKE_VARIANCE', 'UNKNOWN', 'Chưa rõ', true, 90),
  ('MANUAL_WEIGHT', 'SCALE_DISCONNECTED', 'Mất kết nối cân', false, 10),
  ('MANUAL_WEIGHT', 'SCALE_ERROR', 'Cân lỗi', false, 20),
  ('MANUAL_WEIGHT', 'OTHER', 'Khác', true, 90);

-- Quy tắc mã vạch §6.5: W1 bật mặc định; W2 (nhúng giá) / W3 (PLU 4 số) tắt tới khi cấu hình theo cân thật
INSERT INTO core.barcode_rules (id, code, name, priority, type, pattern, value_scale, ean13_checksum, enabled) VALUES
  (gen_random_uuid(), 'W1', 'Tem cân nhúng trọng lượng (PLU 5 số, gram)', 10, 'WEIGHT', '20{PLU:5}{W:5}{C}', 1, true, true),
  (gen_random_uuid(), 'W2', 'Tem cân nhúng giá tiền (PLU 5 số, đồng)', 20, 'PRICE', '21{PLU:5}{P:5}{C}', 1, true, false),
  (gen_random_uuid(), 'W3', 'Tem cân PLU 4 số, trọng lượng 6 số', 30, 'WEIGHT', '22{PLU:4}{W:6}{C}', 1, true, false),
  (gen_random_uuid(), 'PRODUCT', 'Mã vạch hàng đóng gói (sku_units.barcode)', 100, 'PRODUCT', '{CODE}', 1, false, true);

-- Bì chuẩn MẪU — cân lại trước vận hành (Tiến cung cấp loại thùng/sọt thật)
INSERT INTO core.container_types (id, code, name, tare_g) VALUES
  (gen_random_uuid(), 'CRATE-PLASTIC', 'Sọt nhựa (mẫu — cân lại)', 1500),
  (gen_random_uuid(), 'CARTON-IMPORT', 'Thùng carton nhập khẩu (mẫu — cân lại)', 800),
  (gen_random_uuid(), 'FOAM-BOX', 'Thùng xốp (mẫu — cân lại)', 400);

-- Thương hiệu: giá trị DEV tới khi Tiến gửi logo / tên / hotline (CP04 §4)
INSERT INTO core.brand_settings (id, brand_name, receipt_footer) VALUES (1, 'DEV — Tên thương hiệu', 'DEV — Cảm ơn quý khách');
