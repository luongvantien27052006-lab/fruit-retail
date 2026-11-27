# ADR-031: Nhập / xuất Excel danh mục và nhà cung cấp (CP04 lát 5)

- Trạng thái: accepted (kỹ thuật) · Ngày: 2026-11-27 · Người quyết: phiên điều phối (CP04 lát 5)
- Làm rõ: ADR-014 / ADR-025 (file qua S3, outbox + worker), ADR-015 (PII), ADR-016 (transaction + audit), SPEC §21.3.17

## Bối cảnh
Tiến cần nạp danh mục thật (≥ 20 SKU, cổng CP04) và danh bạ NCC từ Excel; kế hoạch lát 5 yêu cầu file mẫu, chạy thử
(dry-run) báo lỗi từng dòng, xử lý trùng bỏ qua / cập nhật / dừng, chạy nền ở worker, xuất Excel các danh sách, và từ chối file
độc (công thức, zip bomb). File Excel là đầu vào KHÔNG tin cậy.

## Quyết định
1. **Luồng nhập:** client tải file loại `IMPORT_XLSX` (chỉ Master, ≤ 5 MB, nhận dạng zip theo byte đầu) qua presign → PUT →
   complete (ADR-025) ⇒ `POST /admin/imports {type, file_id, mode_on_duplicate, dry_run}` (quyền `import:run`, chỉ Master,
   **step-up** — nhập ghi giá lẻ hàng loạt và SĐT / tài khoản NCC, ngang `PUT /admin/prices`). Lượt `PENDING` + sự kiện outbox
   `catalog.import_requested` cùng transaction; tối đa 2 lượt chờ / chạy mỗi người. Client hỏi `GET /admin/imports/{id}`.
2. **Worker** (consumer `catalog-import`): WorkerModule có CLS + plugin transaction như API ⇒ dùng lại CHÍNH service nghiệp
   vụ (SkusService, CatalogService, PricesService, SuppliersService): cùng quy tắc kiểu bán, thứ tự khóa (ERD §6.2), audit
   từng bản ghi, lịch sử giá (lý do "Nhập file Excel (lượt …)"). Người thực hiện = người tạo lượt (Principal dựng lại từ DB;
   phải còn là Master ACTIVE có `import:run`, nếu không ⇒ FAILED); `request_id` audit = id lượt.
3. **Đúng một lần:** giành lượt PENDING → RUNNING bằng khóa dòng; không PENDING ⇒ bỏ qua (sự kiện giao lại không chạy hai
   lần). Lỗi hệ thống ⇒ FAILED (không ném — BullMQ không thử lại lượt hỏng; người dùng tạo lượt mới). Consumer **tự quản**
   (`selfManaged`): runner KHÔNG mở transaction quanh lượt (kết nối "idle in transaction" bị Postgres cắt sau 30 s), chỉ
   ghi `processed_events` sau khi xong. Mỗi tiến trình chạy một lượt một lúc (exceljs nạp cả file vào bộ nhớ).
4. **Phân loại trước, ghi theo lô:** mọi dòng được phân loại TRƯỚC khi ghi (sai dữ liệu, trùng trong file, trùng bản ghi đã
   có) ⇒ STOP gặp trùng thì FAILED mà không ghi gì. Ghi theo lô 500 dòng, mỗi lô một transaction (≤ 500 SAVEPOINT — tránh
   tràn subtransaction của PostgreSQL; khóa giữ ngắn), mỗi dòng một SAVEPOINT: lỗi dòng chỉ hoàn tác dòng đó (bộ nhớ đệm
   danh mục / sản phẩm được khôi phục). Báo cáo: `row` (số dòng Excel), `status` CREATED / UPDATED / SKIPPED / ERROR,
   `field`, `duplicate_of`, `message`. **Chạy thử** = chạy đủ từng lô rồi rollback lô đó (số liệu như chạy thật). Chạy thật
   lỗi hệ thống giữa chừng ⇒ các lô trước ĐÃ ghi (nêu trong `error`); quyền người tạo kiểm một lần lúc bắt đầu.
5. **Trùng:** mã SKU / mã vạch đơn vị gốc / PLU (so cả bản ghi lưu trữ) và trùng trong file (dòng sau trùng dòng trước); NCC
   theo mã. `SKIP` bỏ dòng; `UPDATE` chỉ cập nhật khi trùng ĐÚNG mã của chính bản ghi (mã vạch / PLU của SKU khác, hoặc trùng
   dòng khác trong file ⇒ lỗi dòng); kiểu bán không đổi qua nhập (lỗi dòng); `STOP` dừng ở dòng trùng đầu tiên ⇒ FAILED,
   rollback, không nhập dòng nào.
6. **File độc** (`xlsx-safe.ts`): duyệt thư mục zip bằng `yauzl` TRƯỚC exceljs — ≤ 200 mục, ≤ 20 sheet, tỉ lệ nén ≤ 150 với
   mục > 1 MB (zip bomb), giải nén ≤ 10 MB / mục, ≤ 20 MB tổng (exceljs tốn ~35× bộ nhớ theo XML; 5.000 × 60 ô thật ≈ 7 MB),
   giải nén thử từng mục và đếm byte thật (khai gian ⇒ từ chối); cấm mục mã hóa, đường dẫn lạ, tên phần chủ động
   (`vbaProject.bin`, `externalLinks/`, `embeddings/`, `activeX/`…). Kiểm theo NGHĨA, không theo tên, bằng DANH SÁCH CHO PHÉP: mọi ContentType và mọi kiểu quan hệ (đoạn cuối URI) trong
   `*.rels` phải thuộc loại của workbook thường (form control, ActiveX, OLE, macro VBA / XLM, liên kết ngoài, kết nối dữ liệu,
   template KHÔNG có ⇒ file có checkbox form control bị từ chối); phần officeDocument (`_rels/.rels`) khai đúng MỘT lần với loại
   workbook .xlsx thường; đích External chỉ cho hyperlink. Các phần này phải ở dạng Excel tự tạo — có thực thể (`&…;`), nháy
   đơn, tiền tố namespace, `<!…`, số thẻ thô khác số thẻ đọc được, hoặc > 1 MB ⇒ từ chối (không đoán); chỉ nhận 5 thực thể có sẵn (`&amp;` trong URL hyperlink…), nháy đơn được TRONG giá trị nháy
   kép. Hai mục zip trùng tên (không phân biệt hoa thường), `.RELS` / `[content_types].xml` sai hoa thường, mục trong `_rels/` không
   phải `.rels` ⇒ từ chối. exceljs đọc (saxes không nhận
   DOCTYPE ⇒ chặn XXE / billion laughs); **ô công thức ở bất kỳ sheet nào ⇒ từ chối cả file**; sheet đầu bị ẩn ⇒ từ chối.
   ≤ 5.000 dòng, ≤ 60 cột, ô ≤ 2.000 ký tự. Từ chối ⇒ FAILED + `report.reason`.
6b. **Đọc ô:** cột vắng = trống; ô kiểu SỐ phải là số nguyên an toàn (45000.5 / số > 2^53 ⇒ lỗi dòng — không tự bỏ dấu
   chấm); chữ "45.000" / "45,000 đ" là 45.000 đồng (chỉ bỏ phân cách nghìn đúng mẫu); cột mã (số tài khoản, SĐT) ô kiểu số ⇒
   lỗi dòng (Excel bỏ số 0 đầu / làm tròn); mã vạch ô số chỉ nhận dài 8 / 13 / 14. Quy ước trùng: dòng trước dù lỗi / bị bỏ
   vẫn "chiếm" khóa; chủ sở hữu PLU / mã vạch chụp lúc phân loại.
7. **PII:** SĐT / số tài khoản NCC vào service (mã hóa như API); báo cáo và thông điệp lỗi dòng KHÔNG nhắc lại giá trị ô
   (thông điệp zod chỉ có tên cột), audit theo quy tắc lát 4 (`changed_pii`).
8. **Cột:** tiêu đề "Tên hiển thị (khoa)" — khớp theo khóa trong ngoặc (người dùng đổi tên hiển thị không sao); cột lạ bỏ qua,
   cột trùng ⇒ từ chối; thiếu cột bắt buộc ⇒ FAILED. Danh mục theo đường dẫn "Cha > Con" (tìm theo tên như `btrim/lower`, chưa
   có thì tạo); sản phẩm theo tên trong danh mục. File mẫu: `GET /admin/imports/templates/{CATALOG|SUPPLIER}` (tĩnh, có sheet
   hướng dẫn, cột mã định dạng chữ để giữ số 0 đầu).
9. **Xuất:** `POST /admin/catalog-exports {list}` (quyền `report:export` + quyền đọc của danh sách; cửa hàng / vị trí theo phạm
   vi; cột giá lẻ chỉ khi có `price:read`, cờ "có tài khoản NH" chỉ khi có `supplier:write`) tạo .xlsx trong request, lưu S3 (file `EXPORT_XLSX` READY do server tạo), audit `export.create`, trả URL tải 60 giây.
   `skus` cùng cột với file nhập (xuất → sửa → nhập lại UPDATE). `suppliers` KHÔNG có SĐT / tài khoản (chỉ "có / không").
   Chữ bắt đầu bằng `= + - @` thêm `'` (chống chèn công thức khi chuyển sang CSV). ≤ 20.000 dòng.

## Hệ quả / ghi nhận
- `exceljs@4.4.0` kéo `uuid@8` (GHSA-w5hq-g745-h8pq: chỉ v3/v5/v6 có `buf`) — exceljs chỉ dùng `v4` ⇒ không ảnh hưởng; ép bản
  qua `overrides` của pnpm 11 không có tác dụng — theo dõi khi nâng exceljs.
- `TransactionHost` của `@nestjs-cls/transactional` là biến tĩnh theo tiến trình: API và worker PHẢI là hai tiến trình (đúng
  ADR-002); test dựng worker cùng tiến trình chỉ được chạy cuối.
- Lượt RUNNING khi worker chết giữa chừng nằm lại RUNNING — không tính vào trần 2 lượt sau 15 phút; dọn / cảnh báo ở CP19.
- Mỗi lô giữ một transaction (≤ 2 phút): khóa cây danh mục / SKU giữ trong lô — lượt lớn nên chạy ngoài giờ cao điểm.
- Trần presign 20 file / giờ / người (CP03) áp cả file nhập.
- Phân loại trùng đọc DB ngoài transaction (không cùng snapshot): ghi đồng thời bởi người khác ⇒ dòng "tạo" gặp trùng khi ghi
  thành ERROR (không phải SKIPPED / UPDATED) — chấp nhận.
- Dòng / cột ẨN trong sheet hiện vẫn được nhập (chỉ chặn sheet ẩn) — báo cáo dòng nêu số dòng Excel để đối chiếu.
- Hàng đợi một lượt / tiến trình: lượt treo (S3 / DB không trả lời) chặn các lượt sau của worker đó; khi thêm consumer khác
  (CP12) cần tách hàng đợi / concurrency cho consumer nhập.
