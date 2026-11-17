# CONTEXT.md — Thuật ngữ miền & điểm cần xác nhận

> Chỉ chứa nghĩa nghiệp vụ ổn định (skill `context-and-decisions`). Không ghi chi tiết hiện thực, tiến độ, lý do
> kiến trúc (→ ADR) hay lịch sử (→ `LOG.md`). Nguồn: SPEC v3.2 §1.5 và các mục được dẫn.

## 1. Thuật ngữ (SPEC §1.5)

| Thuật ngữ | Nghĩa | Ghi chú phân biệt |
|---|---|---|
| **SKU** | Đơn vị bán cụ thể, ví dụ "Nho Mẫu Đơn — bán theo kg" | Nhiều quy cách cùng hàng thật dùng chung tồn qua `sku_units` (§21.3.1); khác size/xuất xứ thì tách SKU |
| **Lô (Batch)** | Một lần nhận hàng của 1 SKU; có giá nhập, hạn, độ chín riêng | Mã lô giữ nguyên khi điều chuyển; giá vốn tính theo lô |
| **Hàng cân** | Hàng niêm yết giá theo kg; tiền = giá/kg × số cân thực | Đặt qua app chỉ có **giá tham khảo**, tiền thật có sau khi cân |
| **Gross / Tare / Net** | Cả bì / Bì / Tịnh | Tồn và tiền luôn theo Net (gram) |
| **FEFO** | Hết hạn trước xuất trước | Sắp theo `expiry_date`; đơn app/sỉ bỏ lô qua `stop_sell_app_date` |
| **Mặt hàng đẩy (Push Deal)** | Mặt hàng Master chọn đưa lên app trong một khoảng thời gian, cho 1 hoặc nhiều vùng giao, có gửi thông báo | Có hạn mức (`quota_g`/`quota_units`) |
| **Vùng giao (Delivery Zone)** | Khu vực đa giác trên bản đồ do Master vẽ, gắn với 1 cửa hàng phục vụ | Khác "Đăng ký điểm bán" (§7.6, hoãn) |
| **Giá xuất** | Giá bán ra: lẻ tại quầy, giá đẩy trên app, giá sỉ | Ba loại giá xuất §4.4 |
| **Giá nhập** | Giá mua từ NCC (giá hóa đơn) và giá nhập đã cộng chi phí (landed) | Giá vốn = `landed_cost_per_kg` của lô |
| **Snapshot** | Bản báo cáo Master đã phát hành cho Admin Chỉ Xem, không sửa được | Sửa = phiên bản mới |
| **Z-report** | Báo cáo chốt ca/chốt ngày của cửa hàng | — |

Thuật ngữ bổ trợ hay dùng: **Admin Chỉ Xem / Viewer** (`VIEW_ONLY_ADMIN`, hồ sơ `SHAREHOLDER`, `EXECUTIVE` §10.3);
**ngày kinh doanh** (`business_date`, Asia/Ho_Chi_Minh, mốc `BUSINESS_DAY_CUTOFF=04:00` §19.4); **phiếu tạm /
hoàn thành / đã hủy** (DRAFT/COMPLETED/CANCELLED §21.3.2); **trả sau khi cân** (thanh toán VietQR theo số tiền
thực sau khi cân, D10).

## 2. Needs confirmation (cần Tiến xác nhận)

| # | Vấn đề | Nguồn | Trạng thái |
|---|---|---|---|
| NC-01 | Thư mục ADR: SPEC §19.5 ghi `docs/adr/`, KẾ HOẠCH ghi `docs/engineering/decisions/` | §19.5 vs KẾ HOẠCH CP01 | **Đã quyết:** `docs/engineering/decisions/` (Tiến, 2026-11-17, ADR-001) |
| NC-02 | Nguồn token thiết kế (vị trí file token, công cụ sinh) — SPEC không quy định | §18.5, §19.1 | **needs confirmation** — dời tới CP có UI đầu tiên (CP07/CP10); CP01 không chặn |
| NC-03 | Mã đơn app: §12.1 ví dụ `APP-251117-0007` (theo ngày), §21.3.14 quy định ngẫu nhiên `APP-7KQ2XH9M` | §12.1 vs §21.3.14 | Tạm theo §21.3.14 (§21 thắng thân bài); xác nhận ở CP01 |
| NC-04 | §1.2 dẫn tới "§7.8" không tồn tại (SPEC chỉ có tới §7.7) | §1.2 | Hiểu là §7.7; xác nhận |
| NC-05 | H1 và H5 ở §1.3 trùng nội dung "Đăng ký điểm bán" | §1.3 | Coi là một mục; **đã quyết HOÃN** (2026-11-17) |
| NC-06 | Bảng quyết định §1.4 không có D6, D16 | §1.4 | Xác nhận đây là số bị bỏ, không phải quyết định bị mất |
| NC-07 | §7.6 "Đăng ký điểm bán" | §7.6 | **Đã quyết: HOÃN** (Tiến, 2026-11-17) |
| NC-08 | SPEC §19.6/§21.8 thiếu mã quyền cho: khách tự thao tác (`customer:self`), cấu hình hệ thống (`settings:write`), khớp tay giao dịch ngân hàng (`payment:reconcile`), phiếu sơ chế (`processing:create`), xử lý khiếu nại (`complaint:resolve`) | §19.6, §21.8, §10.1 | **Đã quyết:** thêm 5 mã (Tiến duyệt 2026-11-17); ghi trong `openapi.yaml` (`x-added-outside-spec`) |
| NC-09 | Một số route cần cho màn hình nhưng không có trong §13.2 (đánh dấu `x-not-in-spec-13-2` trong OpenAPI), ví dụ `GET /app/orders`, `POST /pos/receipts/{id}/complete` | §13.2 vs §7.2, §21.3.2 | **Đã quyết:** giữ các route này (Tiến duyệt 2026-11-17) |
| NC-10 | §12.3 `reporting.live_sales_hourly` có `cogs_amount`, mâu thuẫn FR-INV-11 / D14 (viewer không thấy giá vốn ngoài snapshot) | §12.3 vs §2.5, D14 | **Đã quyết:** tách giá vốn sang `reporting.live_sales_hourly_cost`, viewer không có quyền (Tiến duyệt 2026-11-17) |
| NC-11 | FR-INV-14: SPEC chỉ bắt buộc người tạo ≠ người duyệt cho **phiếu hủy hàng** (§5.9, §14 F4). Dự án mở rộng cho điều chỉnh kiểm kê vượt định mức, hoàn tiền, dùng nội bộ, đối soát PENDING_VERIFY. Nếu chỉ có 1 Master tạo phiếu thì cần Master thứ 2 duyệt (§2.1 đã yêu cầu tối thiểu 2 Master) | §5.9, §14, §2.1 | **Đã quyết: mở rộng** (Tiến, 2026-11-17); Master tự tạo cần Master thứ 2 duyệt |
| NC-12 | T38 kỳ vọng "tồn khả dụng giảm 2 kg" khi giữ 2 kg xoài, nhưng §8.3 giữ tồn ×1,1 (= 2,2 kg) cho đơn app và §21.3.12 nói đơn PHONE giữ tồn "như đơn app" | §21.7 T38 vs §8.3 | **Tiến trả lời (2026-11-17):** "số tồn sẽ do người đăng (master) nhập khi đăng sản phẩm cần bán lên". Diễn giải đang áp dụng: lượng bán/giữ là số do người đăng nhập (hạn mức mặt hàng đẩy do Master nhập); hệ số giữ tồn không cố định trong code — là cấu hình, mặc định 1,1 cho đơn app theo §8.3; đơn PHONE giữ đúng số nhân viên nhập → T38 giữ kỳ vọng 2 kg. **Tiến xác nhận diễn giải 2026-11-17 — Đã quyết** |
| NC-13 | Đơn COD: cân xong số tiền thực vượt "giá trị tối đa COD" (lúc đặt chỉ kiểm theo giá tham khảo) | §8.4 | **Đã quyết** (Tiến, 2026-11-17): vượt ≤ 10% (ngưỡng cấu hình) → cho qua; vượt hơn → đề nghị khách chuyển trả sau khi cân (VietQR), cửa hàng trưởng có thể duyệt cho qua |
| NC-14 | Điều chuyển đã xuất (IN_TRANSIT) hoặc đã nhận có được hủy-đảo không | §21.3.2 vs §5.10 | **Đã quyết theo §21.3.2** (§21 thắng): cho hủy-đảo, có lý do, chặn khi hàng đã xuất tiếp/kỳ đã khóa |
| NC-15 | H2 (điểm thưởng) vừa "hoãn" (§1.3) vừa "không làm" (D11) | §1.3 vs §1.4 | **Đã quyết theo D11** (§1.4 thắng): không làm |
| NC-16 | Đơn sỉ: §13.2 ghi `/pos/wholesale-orders/{id}/*` "tương tự" đơn app (có `accept`); máy trạng thái §9.2 không có bước nhận/từ chối → contract dùng `start-picking` thay `accept` | §13.2 vs §9.2 | Theo §9.2; ghi kèm NC-09 |
| NC-17 | Thanh toán: tiền về sau khi payment đã hủy/hết hạn → `LATE_RECEIVED` + nghĩa vụ hoàn; `PENDING_VERIFY` cho chuyển khoản thủ công/mất mạng | §6.6 | Đã đưa vào máy `payment` (theo §6.6) |
