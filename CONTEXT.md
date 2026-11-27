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
| NC-18 | Bundle ID / applicationId của 2 app Flutter: đang tạm `vn.fruitretail.customer_app`, `vn.fruitretail.staff_app` | §19.10 ("Bundle ID app người dùng mới") | **needs confirmation** — Tiến chốt trước khi đăng ký Play Console/Firebase (CP13) |
| NC-19 | Seed vai trò → mã quyền & hạn mức (CP03 lát 1): SPEC §2.2/§2.3 không ánh xạ hết, phiên phải suy diễn. Đã chọn đọc CHẶT (ô "R" không cho mã ghi): (a) STORE_MANAGER **không** có `pos:sell`, `pos:void_line`, `app_order:manage` (§2.2 "R", §2.3 "—"); (b) mã §21.8/NC-08 SPEC chưa gán: SM `internal_use:create/approve`, `badge:issue`, `return:create`, `phone_order:create`, `complaint:resolve`; CASHIER `return:create`, `phone_order:create`, `internal_use:create`; WAREHOUSE_STAFF `internal_use:create`, `processing:create`; (c) "≤ 10% hoặc ≤ 50.000đ", "≤ 2% hoặc ≤ 1.000.000đ" hiểu là đạt MỘT ngưỡng là được (`limit_mode = ANY`); (d) MASTER có mọi mã trừ `viewer:read`, `customer:self`, `shipper:deliver` — nhưng hành động có hạn mức chỉ làm được khi có dòng `approval_limits`: MASTER không có dòng `LINE_DELETE` (xóa dòng trước thanh toán) và `NO_SALE_OPEN` (mở két không bán) ⇒ bị cấm, đúng §2.3 ("—"); (e) quyền cấp riêng (`user_permission_grants`) chỉ cho nhân viên; (f) thiếu mã `zone:read` (SM và viewer có R vùng giao ở §2.2) và mã xem "log thao tác thu ngân" (SM có R) — đề xuất thêm 2 mã mới `zone:read` (MASTER, STORE_MANAGER) và `pos_log:read` (MASTER, STORE_MANAGER); hiện SM chưa xem được vùng giao cho đến khi Tiến quyết; (g) `app_rw` được SELECT `audit.*` cho chức năng "Nhật ký hệ thống" của Master (ADR-020 nới ADR-011) | §2.1–2.3, §19.6, §21.8 | **Đã quyết (Tiến, 2026-11-26)**: (a) đọc chặt — SM không bán/xóa dòng/xử lý đơn app; (b)(d)(e)(g) giữ nguyên; (c) đạt MỘT ngưỡng (ANY) — áp cho kiểm kê, hủy hàng…; (f) thêm `zone:read`, `pos_log:read` cho MASTER + SM. Migration `0004_nc19_permissions`. Phần giảm giá → NC-21 |
| NC-20 | Route `POST /admin/pos-devices/enrollment-codes` ngoài §13.2: mã ghi danh thiết bị POS dùng một lần, hạn 30 phút; `/auth/devices/register` nhận mã ghi danh thay mã cửa hàng (chống lấp hàng chờ, dò mã cửa hàng) | §2.4 SEC3, §13.2 | **Đã quyết (Tiến, 2026-11-25)** — ADR-022, migration 0003 |
| NC-21 | Giảm giá: (1) **bỏ hẳn giảm giá tay trên dòng ở POS** (§2.3 "Giảm giá tay trên dòng", Z-report §6.x, R14/R18 phần giảm giá tay) — giá bán chỉ theo bảng giá admin đặt cho từng mặt hàng; bỏ mã `pos:discount`, hạn mức `LINE_DISCOUNT` (CHECK chặn cấu hình lại); (2) **giảm giá cận hạn theo lô (§5.8) chỉ Master duyệt** — cửa hàng trưởng xem/đề xuất, không duyệt (bỏ "SM ≤ 20%"); (3) voucher/coupon vẫn để sau (D11) | §2.3, §5.8, §6.x, §19.6 | **Đã quyết (Tiến, 2026-11-26)** — migration `0004_nc19_permissions` + `0005_nc21_grant_guard` (cấm cấp riêng `markdown:approve`; Master không có hạn mức xóa dòng/mở két). Hợp đồng: bỏ `POST /pos/markdowns/{id}/approve` (Master duyệt qua `/admin/approvals`), bỏ MARKDOWN khỏi `/pos/approvals*`; `GET /admin/zones*` dùng `zone:read`. **CP07 phải thêm route xem log thao tác thu ngân mang `pos_log:read`**; thêm `GET /admin/approvals` (ngoài §13.2) để Master lấy danh sách chờ duyệt; `/admin/zones*` `x-scope: store` (SM chỉ xem vùng giao của cửa hàng mình); CP07 (POS) và CP10/CP17 (markdown) làm theo |
| NC-22 | Route `POST /auth/password` ngoài §13.2: đổi mật khẩu Master/Viewer; mật khẩu tạm (Master tạo tài khoản / CLI) phải đổi trước khi đăng ký 2FA (`PASSWORD_CHANGE_REQUIRED`); tài khoản chưa kích hoạt quá 72 giờ không đăng nhập được; đổi xong thu hồi các phiên khác | §2.4 SEC1/SEC2, §13.2 | **Đã quyết (Tiến, 2026-11-27)** — ADR-026, migration 0007 |
| NC-23 | SEC5 khóa sau 5 lần sai: khóa theo cặp (tài khoản, nguồn = mạng IP /64 hoặc máy POS) thay vì cả tài khoản; ≥ 10 nguồn bị khóa ⇒ khóa toàn tài khoản 1 giờ; xác thực lại trong phiên (step-up, mật khẩu hiện tại) đếm theo phiên — sai 5 lần ⇒ thu hồi phiên; Master gỡ được khóa tạm | §2.4 SEC2/SEC5 | **Đã quyết (Tiến, 2026-11-27)** — ADR-030, migration 0008 |
| NC-24 | Cửa hàng trưởng GIỮ quyền tạo nhân viên / đặt lại PIN thu ngân (tiện vận hành); bù bằng báo cáo bất thường ở CP10: hủy/hoàn trên hóa đơn của nhân viên do chính cửa hàng trưởng tạo hoặc vừa đặt lại PIN trong N ngày | §2.2, §2.3, §10 | **Đã quyết (Tiến, 2026-11-27)** — làm ở CP10 (báo cáo kiểm soát POS) |
| NC-25 | Bổ sung NC-23 sau review cổng lần 2: trình duyệt/app QUEN (X-Device-Id khớp phiên đã qua 2FA — admin-web: cookie HttpOnly `__Host-fa_dev`) có nguồn khóa riêng và KHÔNG bị khóa toàn tài khoản; nhờ đó ngân sách toàn tài khoản đặt chặt (50 lần sai/24 giờ, IPv6 gộp /48) và bước 2FA đếm theo tài khoản; trình duyệt MỚI của Master lúc đang bị tấn công có thể bị chặn tới khi Master khác gỡ | §2.4 SEC5 | **Đã quyết (Tiến, 2026-11-27)** — ADR-030 |
