-- 0003_pos_enrollment_codes — CP03 lát 4, sửa M1 kiểm thử agent lần 1 (ADR-022; Tiến duyệt 2026-11-25, NC-20).
-- Phần 1: DDL theo schema.prisma (định dạng migrate diff).
-- CreateTable
CREATE TABLE "core"."pos_enrollment_codes" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "code_hash" BYTEA NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "used_by_device_id" UUID,

    CONSTRAINT "pos_enrollment_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pos_enrollment_codes_code_hash_key" ON "core"."pos_enrollment_codes"("code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "pos_enrollment_codes_used_by_device_id_key" ON "core"."pos_enrollment_codes"("used_by_device_id");

-- CreateIndex
CREATE INDEX "pos_enrollment_codes_store_id_expires_at_idx" ON "core"."pos_enrollment_codes"("store_id", "expires_at");

-- AddForeignKey
ALTER TABLE "core"."pos_enrollment_codes" ADD CONSTRAINT "pos_enrollment_codes_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "core"."stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."pos_enrollment_codes" ADD CONSTRAINT "pos_enrollment_codes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."pos_enrollment_codes" ADD CONSTRAINT "pos_enrollment_codes_used_by_device_id_fkey" FOREIGN KEY ("used_by_device_id") REFERENCES "core"."pos_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────── Phần 2: SQL tay ───────────
-- Mã ghi danh: Master/cửa hàng trưởng tạo cho MỘT cửa hàng, dùng MỘT lần, hạn ngắn. Lưu SHA-256 của mã (60 bit ngẫu
-- nhiên), không lưu mã rõ. Mốc tạo/dùng do server đặt; đã dùng thì không sửa được nữa; thiết bị dùng mã phải thuộc đúng
-- cửa hàng của mã và mã phải còn hạn tại thời điểm dùng.
ALTER TABLE core.pos_enrollment_codes
  ADD CONSTRAINT pos_enrollment_codes_hash_len CHECK (octet_length(code_hash) = 32),
  ADD CONSTRAINT pos_enrollment_codes_ttl CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour'),
  ADD CONSTRAINT pos_enrollment_codes_used_pair CHECK ((used_at IS NULL) = (used_by_device_id IS NULL));

CREATE OR REPLACE FUNCTION core.pos_enrollment_code_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    IF NEW.used_at IS NOT NULL OR NEW.used_by_device_id IS NOT NULL THEN
      RAISE EXCEPTION 'pos_enrollment_codes: mã mới phải chưa dùng' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'pos_enrollment_codes: mã đã dùng' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.used_at IS NULL THEN
    RETURN NEW;
  END IF;
  NEW.used_at := now();
  IF NEW.used_at >= OLD.expires_at THEN
    RAISE EXCEPTION 'pos_enrollment_codes: mã đã hết hạn' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.pos_devices d
                 WHERE d.id = NEW.used_by_device_id AND d.store_id = OLD.store_id AND d.status = 'PENDING') THEN
    RAISE EXCEPTION 'pos_enrollment_codes: thiết bị phải PENDING và cùng cửa hàng với mã' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pos_enrollment_code_guard BEFORE INSERT OR UPDATE ON core.pos_enrollment_codes
  FOR EACH ROW EXECUTE FUNCTION core.pos_enrollment_code_guard();

-- default privileges cho app_rw SELECT/INSERT/UPDATE cả bảng ⇒ thu UPDATE cả bảng, chỉ mở hai cột đánh dấu đã dùng.
-- Không DELETE: mã hết hạn để lại làm vết (ít dòng — mỗi mã do người quản trị tạo, có trần theo cửa hàng).
REVOKE UPDATE, DELETE, TRUNCATE ON core.pos_enrollment_codes FROM app_rw;
GRANT SELECT, INSERT ON core.pos_enrollment_codes TO app_rw;
GRANT UPDATE (used_at, used_by_device_id) ON core.pos_enrollment_codes TO app_rw;
