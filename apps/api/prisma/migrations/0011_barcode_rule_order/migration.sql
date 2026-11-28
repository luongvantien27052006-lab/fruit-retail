-- 0011_barcode_rule_order — CP04 lát 7: sắp lại thứ tự quy tắc mã vạch (màn A10) trong MỘT transaction.
-- priority vẫn duy nhất, nhưng kiểm được hoãn tới cuối lệnh `SET CONSTRAINTS … IMMEDIATE` (đổi chỗ hai quy tắc không cần
-- giá trị tạm). Mặc định INITIALLY IMMEDIATE ⇒ mọi lệnh khác vẫn kiểm ngay như cũ.
-- Prisma xem ràng buộc UNIQUE (có index cùng tên) như @unique ⇒ không đổi schema.prisma, drift = 0.
DROP INDEX core.barcode_rules_priority_key;
ALTER TABLE core.barcode_rules
  ADD CONSTRAINT barcode_rules_priority_key UNIQUE (priority) DEFERRABLE INITIALLY IMMEDIATE;
