# Runbook — nạp danh mục thật (cổng CP04, NC-28)

Căn cứ: SPEC §21.3.17; ADR-031 (nhập / xuất Excel); CP04 §3 mục "Nạp được danh mục thật của Tiến (≥ 20 SKU)".
Chạy trên **local** (chưa có staging — CP02 còn CHẶN). Diễn tập tự động cùng luồng: `apps/api/test/catalog-dev-load.test.ts`
(25 SKU mẫu nhãn DEV).

## 1. Chuẩn bị file (Tiến)

1. Mở trang quản lý → **Nhập / xuất Excel** → **Tải file mẫu: Danh mục (SKU + giá)**. Sheet "Hướng dẫn" ghi từng cột.
2. Mỗi dòng một SKU. Cột bắt buộc: Danh mục (đường dẫn cây, vd `Trái cây > Cam`), Sản phẩm, Mã SKU, Tên SKU, Kiểu bán.
   - Kiểu bán: `WEIGHT` (bán cân, giá/kg), `PIECE_BY_WEIGHT` (theo quả, tính theo cân — cần khối lượng chuẩn),
     `PIECE_FIXED` (cái/quả giá cố định), `PACK_FIXED` (hộp định lượng — cần khối lượng chuẩn), `PACK_VARIABLE`,
     `BUNDLE` (combo), `SERVICE`.
   - Giá lẻ: số nguyên đồng; hàng cân là giá **mỗi kg**.
   - PLU cân: 5 chữ số, không trùng; đánh dấu "Bán qua cân" = `có` nếu in tem ở cân.
   - Mã vạch: mã in trên bao bì (không dùng mã 13 số bắt đầu bằng 2 — dành cho tem cân).
3. Không có công thức, macro, sheet ẩn; ≤ 5 MB, ≤ 5000 dòng. File có công thức bị từ chối cả file.
4. **Không** commit file thật vào repo (chứa giá kinh doanh). Để ngoài repo hoặc thư mục bị gitignore.

## 2. Nạp (trên trang quản lý local)

1. Stack local chạy (`infra/` — Tiến khởi động; cần `infra/.env` đủ khóa + `S3_*` trỏ kho thật hoặc SeaweedFS local).
2. Đăng nhập Master (2FA) → **Nhập / xuất Excel** → Loại "Danh mục" → chọn file → **Tải file lên**.
3. **Chạy thử** (nhập mã 2FA nếu được hỏi). Đọc bảng lỗi từng dòng; sửa file, tải lại, chạy thử lại tới khi Lỗi = 0.
4. Chọn cách xử lý dòng trùng (lần đầu: **Bỏ qua**) → **Nhập thật**.
5. Kiểm: **Danh mục & giá** → tìm vài SKU, mở chi tiết thấy giá + lịch sử giá ("nhập file"); **Tem & mã vạch** → File PLU
   cho cân có đủ SKU bán qua cân; In tem giá kệ một danh mục.

## 3. Ghi nhận cổng

Ghi vào `checkpoints/CP04.md` mục Báo cáo cổng: ngày, số dòng, số tạo / bỏ qua / lỗi (từ "Lượt nhập gần đây"), id lượt nhập.
Không ghi giá / tên NCC thật vào tài liệu.
