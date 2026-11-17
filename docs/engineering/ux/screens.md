# Danh sách màn hình, hành động và nhánh lỗi (CP01)

Nguồn: SPEC §6, §7.2, §8.6–§8.8, §10.1–§10.2, §21.3 · Route ở `packages/contracts/openapi.yaml` · Trạng thái ở
`packages/contracts/state-machines/`. Mỗi màn hiện thực ở CP ghi trong cột CP; khi hiện thực phải đủ các nhánh lỗi
chung (mục 0) + nhánh riêng của màn.

## 0. Nhánh lỗi chung (bắt buộc cho mọi màn có ghi dữ liệu)

| Mã | Tình huống | Hành vi UI |
|---|---|---|
| E-NET | Mất mạng / timeout | Không coi là thất bại; giữ thao tác với cùng `Idempotency-Key`, thử lại; POS counter chuyển chế độ offline (chỉ tiền mặt) |
| E-STALE | `VERSION_CONFLICT` | Tải lại dữ liệu mới nhất, giữ phần người dùng đã nhập nếu còn hợp lệ |
| E-AUTH | 401 / token hết hạn | Refresh; thất bại → về màn đăng nhập, không mất dữ liệu nháp |
| E-PERM | 403 `ACTION_FORBIDDEN` / mất quyền giữa chừng | Ẩn/khóa hành động, nói rõ cần ai duyệt |
| E-STEP | 403 `STEP_UP_REQUIRED` | Hộp nhập lại 2FA rồi gửi lại cùng key |
| E-APPROVE | 422 `APPROVAL_REQUIRED` | Mở luồng duyệt tại chỗ (thẻ + PIN quản lý) hoặc gửi yêu cầu duyệt |
| E-CFG | 503 `CONFIGURATION_NOT_READY` / `DEPENDENCY_UNAVAILABLE` | Báo tính năng chưa sẵn sàng; với thanh toán: KHÔNG kết luận tiền chưa thu |
| E-RATE | 429 | Đếm ngược thử lại |
| E-STOCK | 422 `STOCK_INSUFFICIENT` / `DEAL_SOLD_OUT` | Hiện số còn lại, gợi ý giảm số lượng |
| E-PAYWAIT | Thanh toán đang chờ / `UNKNOWN` | Hiện "đang chờ xác nhận", polling REST; không cho tạo VA thứ hai cho cùng phần tiền |

## 1. App người dùng — `apps/customer_app` (§7.2)

| # | Màn | Hành động chính (route) | Nhánh riêng | CP |
|---|---|---|---|---|
| U01 | Khởi động / bắt buộc cập nhật | kiểm phiên bản tối thiểu | Bản cũ → chặn, mở store | CP14 |
| U02 | Đăng nhập | `POST /auth/otp/request`, `/auth/otp/verify`; hỏi quyền thông báo | `OTP_INVALID`, `OTP_RATE_LIMITED`; từ chối quyền thông báo vẫn dùng được | CP14 |
| U03 | Địa chỉ của tôi | `GET/POST /app/addresses` (trả vùng) | `OUT_OF_ZONE` → hiện "ngoài vùng giao" | CP14 |
| U04 | Hàng đang đẩy | `GET /app/deals?address_id=` | Deal ngoài vùng: khóa nút + "Chỉ giao khu vực …" hoặc ẩn (cấu hình); danh sách rỗng | CP14 |
| U05 | Chi tiết mặt hàng đẩy | `GET /app/deals/{id}` | Hết hạn mức → "Đã hết"; đếm ngược hết giờ; "giá tham khảo — tiền thật theo cân" | CP14 |
| U06 | Giỏ hàng | (cục bộ) + `POST /app/orders/quote` | Khác cửa hàng phục vụ → không cho thêm | CP14 |
| U07 | Đặt hàng | `POST /app/orders/quote`, `POST /app/orders` | `DEAL_SOLD_OUT`, `DEAL_LIMIT_EXCEEDED`, `OUT_OF_ZONE`, `COD_LIMIT_EXCEEDED` | CP14 |
| U08 | Thanh toán VietQR | `POST /app/orders/{id}/payments` | Đếm ngược 30 phút; hết hạn → đơn hủy; E-PAYWAIT | CP14 |
| U09 | Theo dõi đơn | `GET /app/orders/{id}` + socket `order:{id}` | Mất socket → REST; `DELIVERY_FAILED` hiện lý do | CP14/CP15 |
| U10 | Thanh toán sau khi cân | `GET /app/orders/{id}`, `POST …/payments`, `POST …/confirm` (thiếu hàng) | Thiếu hàng → chọn nhận phần còn lại / hủy | CP14 |
| U11 | Lịch sử đơn | `GET /app/orders` | Rỗng | CP14 |
| U12 | Khiếu nại | `POST /app/complaints` (ảnh chụp trực tiếp) | `COMPLAINT_WINDOW_EXPIRED` (>24h), `COMPLAINT_LIMIT_EXCEEDED` → chuyển Master | CP14 |
| U13 | Hộp thông báo | `GET /app/notifications`, `POST …/{id}/open` | Deep link tới deal đã hết → màn "đã kết thúc" | CP14 |
| U14 | Tài khoản | `PATCH /app/me/preferences`, `DELETE /app/me` | Xóa tài khoản: xác nhận 2 bước; đơn đang xử lý → chặn đến khi xong | CP14 |

## 2. POS quầy — `apps/staff_app` chế độ counter, Windows (§6, §21.3)

| # | Màn | Hành động chính | Nhánh riêng | CP |
|---|---|---|---|---|
| P01 | Kích hoạt thiết bị / đăng nhập PIN | `POST /auth/pin` | `DEVICE_NOT_ACTIVATED`, `ACCOUNT_LOCKED` (5 lần sai) | CP03/CP07 |
| P02 | Mở ca | `POST /pos/shifts/open` (tiền đầu ca theo mệnh giá) | `SHIFT_ALREADY_OPEN` | CP08 |
| P03 | Bán hàng | thêm dòng (cân / tem EAN-13 / mã vạch / giỏ), `POST /pos/sales` | Cân chưa ổn định/0 g → không nhận; ngoài `weight_min..max` → cảnh báo; `BARCODE_CHECKSUM_INVALID`; tem nhúng giá cũ → cảnh báo; tem quét 2 lần/ngày → cảnh báo; `SHIFT_NOT_OPEN`; `BATCH_EXPIRED` | CP07 |
| P04 | Cân lỗi / nhập cân tay | dòng `MANUAL` + PIN quản lý + lý do | Mất kết nối cân → báo đỏ, không nuốt lỗi | CP07 |
| P05 | Thanh toán | tiền mặt / `POST /pos/payments/va` / CK thủ công / chia phương thức | VA hết hạn → tạo VA mới; webhook đến sau khi đã thu tiền mặt → "thu thừa"; offline → chỉ tiền mặt hoặc `PENDING_VERIFY` | CP08 |
| P06 | Màn hình phụ hướng khách | hiện dòng, tổng, QR | Màn phụ mất kết nối → vẫn bán | CP08 |
| P07 | Đổi người bán / khóa màn hình | `POST /pos/shifts/{id}/switch-staff` (thẻ / PIN) | Thẻ bị thu hồi; tự khóa sau N phút | CP09 |
| P08 | Đổi – trả | `POST /pos/returns` | Quá thời hạn trả → cần cửa hàng trưởng; khối lượng trả > đã mua → chặn | CP09 |
| P09 | Hủy hóa đơn / hoàn tiền | `POST /pos/sales/{id}/void`, `/refund` | `APPROVAL_REQUIRED` vượt hạn mức; khác ngày → chặn | CP08/CP09 |
| P10 | Thu chi / mở két không bán | `POST /pos/cash-movements` | PIN + lý do | CP09 |
| P11 | Đóng ca | `POST /pos/shifts/{id}/close` (đếm mù theo mệnh giá, đối chiếu từng phương thức) | `CASH_DIFFERENCE_APPROVAL_REQUIRED` khi vượt ngưỡng; không cho nhập lại số đếm | CP08 |
| P12 | Đóng ngày / Z-report, in K80 | `POST /pos/day-close` | Còn ca mở → chặn | CP08 |
| P13 | Đồng bộ offline | `POST /pos/sync/upload`, `GET /pos/sync/catalog` | `OFFLINE_WINDOW_EXCEEDED` (>24h) → khóa bán; lệch giờ > 10 phút → cảnh báo | CP09 |
| P14 | Đơn đặt qua điện thoại | `POST /pos/phone-orders` | `STOCK_INSUFFICIENT` | CP14 |

## 3. Tablet — `apps/staff_app` chế độ tablet, Android (§5, §8.6)

| # | Màn | Hành động chính | Nhánh riêng | CP |
|---|---|---|---|---|
| T01 | Hàng đợi soạn | `GET /pos/queue` + socket `store:{id}` (chuông lặp 15 s) | Không nhận trong 3/5 phút → báo cửa hàng trưởng/Master | CP14 |
| T02 | Soạn đơn app | `accept/reject/weigh-line/report-shortage/pack/dispatch` | Cân lệch >15% so với đặt → cảnh báo picker (không hỏi khách); `BATCH_STOP_SELL_APP`; thiếu hàng | CP14 |
| T03 | Soạn đơn sỉ | `/pos/wholesale-orders/{id}/*` | Như T02 | CP16 |
| T04 | Nhận hàng NCC | `POST /pos/receipts`, `/complete` (cân, bì, QC, ảnh) | Thùng danh nghĩa: luôn cân tịnh; thiếu giá → lô "chờ giá" | CP05 |
| T05 | Điều chuyển (xuất/nhận) | `/pos/transfers*` | Lệch > ngưỡng → bắt buộc ảnh + lý do | CP06 |
| T06 | Kiểm kê | `/pos/stocktakes*` (4 tab, đếm mù, Hủy ngay) | Vượt định mức → cần duyệt; người duyệt ≠ người tạo | CP06 |
| T07 | Hủy hàng / dùng nội bộ | `POST /pos/spoilage`, `/pos/internal-use` | Ảnh chụp trực tiếp có watermark; ảnh trùng hash → cảnh báo | CP06 |
| T08 | Độ chín / sơ chế | `/pos/ripeness-*`, `/pos/processing-orders` | Lô quá hạn → chỉ hủy/sơ chế có xác nhận | CP17 |

## 4. Shipper — `apps/staff_app` chế độ shipper, Android (§8.7)

| # | Màn | Hành động chính | Nhánh riêng | CP |
|---|---|---|---|---|
| S01 | Danh sách chuyến | `GET /shipper/jobs` | `SHIPPER_COD_LIMIT_EXCEEDED` → không nhận chuyến mới | CP15 |
| S02 | Chi tiết chuyến | `pickup / deliver (ảnh, thu COD) / fail (lý do)`, `POST /shipper/location` | Gọi khách qua nút (không hiện SĐT đầy đủ) | CP15 |
| S03 | Nộp COD | `POST /shipper/cod/remit` | Lệch số → cửa hàng đối soát | CP15 |

## 5. Trang quản lý — `apps/admin-web` (§10.1, §10.2)

### 5.1. Master Admin

| # | Mục §10.1 | Hành động chính | Nhánh riêng | CP |
|---|---|---|---|---|
| A01 | Đăng nhập + 2FA | `/auth/login`, `/auth/2fa/verify` | Bắt buộc bật 2FA lần đầu; thiết bị mới → cảnh báo | CP03 |
| A02 | Tổng quan hôm nay | `GET /admin/reports/{code}` + socket `admin:master` | Mất socket → REST | CP10 |
| A03 | Báo cáo doanh thu | `/admin/reports/{code}`, `POST /admin/exports` | Kỳ dài → xuất nền, thông báo khi xong | CP10 |
| A04 | Giá nhập – giá xuất | `/admin/reports/{code}`, `POST /admin/batches/{id}/cost` | Lô đã bán → step-up | CP10/CP05 |
| A05 | Đơn bán sỉ | `/admin/wholesale-*`, `/admin/wholesale-orders/{id}/*` | Vượt hạn mức nợ → cảnh báo, Master quyết | CP16 |
| A06 | Mặt hàng đẩy & thông báo | `/admin/push-deals*`, `/admin/notifications` | Tồn khả dụng < hạn mức → cảnh báo + gợi ý điều chuyển; giới hạn tần suất push | CP13 |
| A07 | Đơn app | `/admin/app-orders*`, `/admin/refunds`, `/admin/complaints/{id}/resolve` | Can thiệp trạng thái bắt buộc lý do | CP14 |
| A08 | Kho | tồn, phiếu nhập, chi phí nhập, điều chuyển, kiểm kê, `/admin/approvals/*` | Người duyệt ≠ người tạo (`APPROVER_MUST_DIFFER`) | CP06 |
| A09 | Kiểm soát POS | báo cáo log xóa dòng/cân tay/giảm giá/hủy/mở két | — | CP10 |
| A10 | Danh mục | `/admin/categories|products|skus|units|barcode-rules`, `/admin/prices`, `/admin/imports`, `/admin/plu-export` | Nhập Excel dry-run, trùng mã: bỏ qua/cập nhật/dừng | CP04 |
| A11 | Cửa hàng & vùng giao | `/admin/stores|devices|zones`, `/admin/pos-devices/*` | Vẽ đa giác chồng lấn → cảnh báo | CP04/CP13 |
| A12 | Giao hàng | shipper, sổ COD, cấu hình 3PL | 3PL thiếu cấu hình → `CONFIGURATION_NOT_READY` | CP15 |
| A13 | Nhà cung cấp | `/admin/suppliers` | — | CP05 |
| A14 | Khách hàng app | `GET /admin/customers`, `POST /admin/customers/export` | Xuất → step-up + log | CP14 |
| A15 | Nhân viên & phân quyền | `/admin/staff`, `/admin/role-assignments`, `/admin/approval-limits`, `/admin/badges` | Tối thiểu 2 Master; không tự gỡ quyền Master cuối cùng | CP03 |
| A16 | Phát hành báo cáo | `/admin/publish/*`, `/admin/snapshots/{id}/revoke`, `/admin/viewer-profiles*` | Phát hành/thu hồi → step-up; "Xem như viewer" | CP12 |
| A17 | Nhật ký | `GET /admin/audit-logs` | — | CP03 |
| A18 | Cấu hình | `GET/PATCH /admin/settings`, `/admin/lock-dates`, `/admin/cash-accounts` | Sửa cấu hình tiền → step-up | CP03/CP08 |

### 5.2. Admin Chỉ Xem (§10.2) — không có nút ghi

| # | Mục | Route | Nhánh riêng | CP |
|---|---|---|---|---|
| V01 | Hôm nay | `/viewer/today/*` + socket `viewer:{profile_id}` | Nhãn "Tạm tính, chưa chốt" | CP12 |
| V02 | Doanh thu theo ngày | `/viewer/daily-revenue` | Ngày chưa chốt → không hiện | CP12 |
| V03 | Đơn hàng | `/viewer/orders` | Khách luôn che | CP12 |
| V04 | Tồn kho | `/viewer/stock` | Chỉ số lượng | CP12 |
| V05 | Báo cáo đã phát hành | `/viewer/snapshots*`, `POST /viewer/files/{id}/download` | Snapshot bị thu hồi → hiện "đã thu hồi" + phiên bản thay thế | CP12 |
