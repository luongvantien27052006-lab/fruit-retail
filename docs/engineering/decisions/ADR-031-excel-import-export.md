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
   lần). Lỗi hệ thống ⇒ FAILED (không ném — BullMQ không thử lại lượt hỏng; người dùng tạo lượt mới). Runner cho consumer này
   transaction 10 phút (`timeoutMs`), transaction nhập 4 phút.
4. **Một transaction, mỗi dòng một SAVEPOINT:** lỗi dòng (quy tắc, trùng do đua, DB) chỉ hoàn tác dòng đó, các dòng khác vẫn
   nhập; báo cáo ghi `row` (số dòng Excel), `status` CREATED / UPDATED / SKIPPED / ERROR, `field`, `duplicate_of`, `message`.
   **Chạy thử** = chạy đủ rồi rollback cả transaction (số liệu đúng như chạy thật), báo cáo lưu ở transaction riêng.
5. **Trùng:** mã SKU / mã vạch đơn vị gốc / PLU (so cả bản ghi lưu trữ) và trùng trong file (dòng sau trùng dòng trước); NCC
   theo mã. `SKIP` bỏ dòng; `UPDATE` chỉ cập nhật khi trùng ĐÚNG mã của chính bản ghi (mã vạch / PLU của SKU khác, hoặc trùng
   dòng khác trong file ⇒ lỗi dòng); kiểu bán không đổi qua nhập (lỗi dòng); `STOP` dừng ở dòng trùng đầu tiên ⇒ FAILED,
   rollback, không nhập dòng nào.
6. **File độc** (`xlsx-safe.ts`): duyệt thư mục zip bằng `yauzl` TRƯỚC exceljs — ≤ 200 mục, giải nén ≤ 30 MB / mục, ≤ 50 MB
   tổng, tỉ lệ nén ≤ 150 với mục > 1 MB (zip bomb), giải nén thử từng mục và đếm byte thật (khai gian ⇒ từ chối); cấm mục mã
   hóa, đường dẫn lạ, `vbaProject.bin`, `externalLinks/`, `embeddings/`, `activeX/`, `connections.xml`; `[Content_Types].xml`
   phải là workbook .xlsx thường (không .xlsm). exceljs đọc; **ô công thức ở bất kỳ sheet nào ⇒ từ chối cả file** (không tin
   giá trị cache). ≤ 5.000 dòng, ≤ 60 cột, ô ≤ 2.000 ký tự. Từ chối ⇒ FAILED + `report.reason`.
7. **PII:** SĐT / số tài khoản NCC vào service (mã hóa như API); báo cáo và thông điệp lỗi dòng KHÔNG nhắc lại giá trị ô
   (thông điệp zod chỉ có tên cột), audit theo quy tắc lát 4 (`changed_pii`).
8. **Cột:** tiêu đề "Tên hiển thị (khoa)" — khớp theo khóa trong ngoặc (người dùng đổi tên hiển thị không sao); cột lạ bỏ qua,
   cột trùng ⇒ từ chối; thiếu cột bắt buộc ⇒ FAILED. Danh mục theo đường dẫn "Cha > Con" (tìm theo tên như `btrim/lower`, chưa
   có thì tạo); sản phẩm theo tên trong danh mục. File mẫu: `GET /admin/imports/templates/{CATALOG|SUPPLIER}` (tĩnh, có sheet
   hướng dẫn, cột mã định dạng chữ để giữ số 0 đầu).
9. **Xuất:** `POST /admin/catalog-exports {list}` (quyền `report:export` + quyền đọc của danh sách; cửa hàng / vị trí theo phạm
   vi) tạo .xlsx trong request, lưu S3 (file `EXPORT_XLSX` READY do server tạo), audit `export.create`, trả URL tải 60 giây.
   `skus` cùng cột với file nhập (xuất → sửa → nhập lại UPDATE). `suppliers` KHÔNG có SĐT / tài khoản (chỉ "có / không").
   Chữ bắt đầu bằng `= + - @` thêm `'` (chống chèn công thức khi chuyển sang CSV). ≤ 20.000 dòng.

## Hệ quả / ghi nhận
- `exceljs@4.4.0` kéo `uuid@8` (GHSA-w5hq-g745-h8pq: chỉ v3/v5/v6 có `buf`) — exceljs chỉ dùng `v4` ⇒ không ảnh hưởng; ép bản
  qua `overrides` của pnpm 11 không có tác dụng — theo dõi khi nâng exceljs.
- `TransactionHost` của `@nestjs-cls/transactional` là biến tĩnh theo tiến trình: API và worker PHẢI là hai tiến trình (đúng
  ADR-002); test dựng worker cùng tiến trình chỉ được chạy cuối.
- Lượt RUNNING khi worker chết giữa chừng (transaction đã rollback) nằm lại RUNNING — dọn / cảnh báo ở CP19 (giám sát).
- Một lượt giữ một transaction tới 4 phút (5.000 dòng): khóa danh mục / SKU giữ suốt lượt — chạy ngoài giờ cao điểm.
