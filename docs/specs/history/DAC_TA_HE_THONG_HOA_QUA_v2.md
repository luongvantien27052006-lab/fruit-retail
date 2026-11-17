# ĐẶC TẢ HỆ THỐNG v2.0 — HỆ SINH THÁI BÁN LẺ HOA QUẢ ĐA KÊNH

> **Phạm vi:** App Khách Hàng (Flutter) · Phần mềm Bán hàng Cửa hàng (POS) · Hệ thống Admin 2 tầng (Admin Toàn Quyền / Admin Chỉ Xem) · Kho tổng & giao vận
> **Phiên bản:** 2.1 — 17/11/2026 (đã chốt 16 quyết định — xem §0.4) · Bản rà soát + mở rộng từ bản v1 "Đặc Tả Kiến Trúc & Nghiệp Vụ Hệ Sinh Thái Bán Lẻ Hoa Quả Đa Kênh"
> **Stack mục tiêu:** NestJS · PostgreSQL · Redis · Next.js · Flutter (iOS/Android/Windows)
> **Đọc theo thứ tự:** Phần 0 (đánh giá bản v1) → Phần 1–3 (phạm vi, pháp lý, phân quyền) → Phần 4–11 (nghiệp vụ từng phân hệ) → Phần 12–17 (dữ liệu, API, kỹ thuật, lộ trình) → Phụ lục.

---

## MỤC LỤC

- [Phần 0. Đánh giá bản v1: giữ gì, sửa gì, thiếu gì](#phần-0-đánh-giá-bản-v1)
- [Phần 1. Tổng quan, phạm vi & thuật ngữ](#phần-1-tổng-quan-phạm-vi--thuật-ngữ)
- [Phần 2. Ràng buộc pháp lý & tuân thủ (Việt Nam, 2026)](#phần-2-ràng-buộc-pháp-lý--tuân-thủ)
- [Phần 3. Vai trò, phân quyền & bảo mật tài khoản](#phần-3-vai-trò-phân-quyền--bảo-mật-tài-khoản)
- [Phần 4. Kiến trúc kỹ thuật tổng thể](#phần-4-kiến-trúc-kỹ-thuật-tổng-thể)
- [Phần 5. Dữ liệu danh mục (Master Data)](#phần-5-dữ-liệu-danh-mục-master-data)
- [Phần 6. Kho, lô hàng, giá vốn, hao hụt, chế biến](#phần-6-kho-lô-hàng-giá-vốn-hao-hụt-chế-biến)
- [Phần 7. Phần mềm bán hàng tại cửa hàng (POS)](#phần-7-phần-mềm-bán-hàng-tại-cửa-hàng-pos)
- [Phần 8. Đơn online, Catch-Weight, fulfillment & giao vận](#phần-8-đơn-online-catch-weight-fulfillment--giao-vận)
- [Phần 9. App Khách Hàng](#phần-9-app-khách-hàng)
- [Phần 10. Hệ thống Admin 2 tầng & Cổng phát hành (Publish Gate)](#phần-10-hệ-thống-admin-2-tầng--cổng-phát-hành)
- [Phần 11. Báo cáo & định nghĩa KPI](#phần-11-báo-cáo--định-nghĩa-kpi)
- [Phần 12. Thiết kế cơ sở dữ liệu](#phần-12-thiết-kế-cơ-sở-dữ-liệu)
- [Phần 13. API, sự kiện realtime & tích hợp bên thứ ba](#phần-13-api-sự-kiện-realtime--tích-hợp)
- [Phần 14. Kiểm soát gian lận & nhật ký kiểm toán](#phần-14-kiểm-soát-gian-lận--nhật-ký-kiểm-toán)
- [Phần 15. Yêu cầu phi chức năng](#phần-15-yêu-cầu-phi-chức-năng)
- [Phần 16. Lộ trình triển khai (thực tế cho 1 dev)](#phần-16-lộ-trình-triển-khai)
- [Phần 17. Kịch bản kiểm thử nghiệm thu](#phần-17-kịch-bản-kiểm-thử-nghiệm-thu)
- [Phần 18. Các quyết định cần chốt trước khi code](#phần-18-các-quyết-định-cần-chốt)
- [Phụ lục A–F](#phụ-lục)

---

## Phần 0. Đánh giá bản v1

### 0.1. Những điểm bản v1 làm tốt — GIỮ NGUYÊN

| # | Điểm mạnh | Ghi chú |
|---|---|---|
| 1 | Nhận diện đúng 4 bài toán đặc thù ngành: Catch-Weight, FEFO + độ chín, hao hụt/trừ bì, BOM giỏ quà | Đây là lõi khác biệt so với POS tạp hóa — giữ làm trục thiết kế |
| 2 | Tách dữ liệu báo cáo cho Admin Chỉ Xem ra vùng riêng, không cho truy vấn thẳng bảng vận hành | Đúng hướng; v2 làm rõ cơ chế (xem Phần 10) |
| 3 | Lưu song song số cân tạm tính (`est_weight`) và số cân thực (`actual_weight`) + ảnh cân | Giữ, bổ sung quy tắc làm tròn & dung sai |
| 4 | Mã vạch cân EAN-13 nhúng trọng lượng `20 PPPPP WWWWW C` | Đúng chuẩn GS1 (tiền tố 20–29 dành cho lưu hành nội bộ). v2 cho phép cấu hình nhiều định dạng |
| 5 | Ảnh hủy hàng bắt buộc chụp trực tiếp, không lấy từ thư viện | Giữ, bổ sung watermark + hash phía server |
| 6 | Blind cash count khi đóng ca | Giữ |
| 7 | Phiếu sơ chế (5 kg dưa → 12 khay) và hoán đổi thành phần giỏ quà | Giữ, bổ sung tỷ lệ thu hồi (yield) và giới hạn giá vốn |

### 0.2. Những chỗ SAI hoặc chưa chính xác — PHẢI SỬA

| # | Nội dung bản v1 | Vấn đề | Sửa trong v2 |
|---|---|---|---|
| S1 | "Middleware chặn mọi HTTP method khác GET" cho Admin Chỉ Xem | Admin Chỉ Xem vẫn cần `POST` cho đăng nhập, refresh token, đổi mật khẩu, yêu cầu xuất file, đánh dấu đã đọc thông báo. Chặn theo method sẽ làm hỏng các luồng này, còn API `GET` nhạy cảm thì vẫn lọt | Dùng **allowlist theo endpoint + permission code**, mặc định từ chối (deny-by-default). Xem §3.6 |
| S2 | Đồng bộ realtime "độ trễ dưới 200ms" | Không đảm bảo được qua mạng di động + chuỗi xử lý projection; hứa con số này tạo kỳ vọng sai | SLO: **p95 ≤ 3 giây** từ lúc sự kiện xảy ra đến khi hiện trên dashboard |
| S3 | "Hao hụt bay hơi tự nhiên mỗi ngày 1.5%–3.0%" và ngầm hiểu hệ thống tự trừ | Tự động trừ kho theo % lý thuyết tạo ra **tồn kho ảo theo chiều ngược lại** và che giấu thất thoát thật (trộm, cân sai). Tỷ lệ cũng khác nhau rất xa giữa các loại quả | **Không tự trừ kho.** Hao hụt chỉ ghi nhận qua **kiểm kê thực tế**, rồi phân loại trong/ngoài định mức. Để tránh bán quá, dùng **hệ số an toàn khi tính tồn khả dụng (ATP)**. Xem §6.7 |
| S4 | Tự động chuyển 5 giai đoạn độ chín theo số ngày | Độ chín phụ thuộc nhiệt độ, giống, lô; tự chuyển theo lịch sẽ sai thường xuyên | Lịch theo ngày chỉ là **gợi ý**; trạng thái thật do **kiểm tra QC đầu ngày** trên POS/App kho xác nhận. Xem §6.5 |
| S5 | Tự động Flash Sale giảm 15%–35% khi lô sang giai đoạn 4 | Không có giá sàn, không có duyệt → có thể bán dưới giá vốn hàng loạt, hoặc nhân viên lợi dụng đánh dấu "cận hạn" để mua rẻ | Rule engine có **giá sàn**, **giới hạn % theo vai trò**, **duyệt** khi vượt ngưỡng; nhân viên không được mua hàng markdown do chính mình đánh dấu. Xem §6.9 |
| S6 | "Ví trả trước của tiệm" để thanh toán | Theo NĐ 52/2024, tiền điện tử chỉ được lưu trên ví điện tử/thẻ trả trước do ngân hàng hoặc tổ chức trung gian thanh toán được cấp phép cung ứng. Cửa hàng tự làm ví nạp tiền có rủi ro pháp lý | Thay bằng **"Điểm thưởng/Credit hoàn tiền"**: chỉ phát sinh từ hoàn tiền/khuyến mãi, **không nạp tiền, không rút tiền mặt, có hạn dùng**. Nếu muốn ví nạp tiền thật → tích hợp ví của đơn vị được cấp phép. Xem §2.4 |
| S7 | Tên schema không thống nhất: `exec_view` / `exec_reporting` | Gây nhầm khi code | Thống nhất: `core`, `reporting`, `audit`, `integration` (xem §4.3) |
| S8 | Tiền tệ "BIGINT hoặc NUMERIC(15,2)" | VNĐ không có phần lẻ; dùng 2 kiểu sẽ lệch khi cộng/so sánh | **Mọi số tiền = `BIGINT` (đồng)**. Đơn giá/kg cũng BIGINT. Xem §12.1 |
| S9 | Trọng lượng `NUMERIC(10,3)` kg | Dùng được nhưng dễ lẫn đơn vị giữa các tầng (kg/g) | Khuyến nghị **`INTEGER` đơn vị gram** (`*_g`) ở mọi tầng, chỉ đổi ra kg khi hiển thị. Xem §12.1 |
| S10 | POS "Flutter Desktop / Web POS + SQLite Offline" | Web POS không truy cập được cổng serial ổn định (Web Serial chỉ có ở Chromium, không có trên Safari/Firefox), không có SQLite native → 2 lựa chọn này không tương đương | Chọn **1 nền tảng chính**. Khuyến nghị Flutter Windows cho trạm thu ngân có cân/két. Xem §4.2 & quyết định Q3 |
| S11 | "Giá nhập hạch toán nội bộ… điều chỉnh theo chính sách quản trị nội bộ" rồi hiển thị cho cổ đông/nhà đầu tư như "giá nhập" | Nếu người xem là cổ đông, nhà đầu tư, đối tác liên doanh mà nhận số liệu giá vốn đã bị thay đổi **không có nhãn**, đó là thông tin sai lệch — rủi ro tranh chấp/pháp lý cho chính chủ hệ thống | Tách 2 việc: **(a) Ẩn** (không cho xem) — hoàn toàn hợp lệ; **(b) Thay số** — chỉ cho phép dưới dạng **"Giá vốn định mức/quản trị"** có nhãn rõ, kèm dòng **chênh lệch**, có phiên bản và lịch sử. Xem §10.4 |
| S12 | 4 nhóm quyền (MASTER_ADMIN, VIEW_ONLY_ADMIN, STORE_STAFF, CUSTOMER) | Quá thô: thu ngân, picker, cửa hàng trưởng, thủ kho, shipper, kế toán có quyền rất khác nhau; không có cách quản lý chính các Master Admin | 13 vai trò + phạm vi (toàn chuỗi/vùng/cửa hàng) + quyền theo trường dữ liệu. Xem Phần 3 |
| S13 | Lộ trình 12 tuần cho toàn bộ hệ thống | Với 1 lập trình viên, khối lượng (POS phần cứng + app 2 nền tảng + admin + kho + giao vận + hóa đơn điện tử) thực tế cần **6–9 tháng** cho bản dùng được ngoài đời | Lộ trình theo MVP có thể vận hành sớm. Xem Phần 16 |
| S14 | Lỗi chữ "tạo ngay टिकट hoàn tiền" (ký tự Hindi) | Lỗi copy | Sửa thành "tạo ngay **phiếu yêu cầu (ticket)** hoàn tiền" |
| S15 | `exec_reporting.published_snapshots` lưu `summary_metrics_jsonb` | Chỉ JSONB thì Admin Chỉ Xem không lọc/drill-down được (theo cửa hàng, theo mặt hàng, theo ngày) | Snapshot = **header + các bảng fact bất biến gắn `snapshot_id`**; JSONB chỉ để lưu bản tóm tắt. Xem §10.5 |
| S16 | Số cân "tự động nhảy… chặn tuyệt đối thu ngân sửa số cân" | Thiếu xử lý khi cân hỏng/mất kết nối → quầy tê liệt | Có chế độ **nhập tay khẩn cấp** cần PIN cửa hàng trưởng + lý do + log + báo cáo. Xem §7.4 |

### 0.3. Những phần bản v1 CÒN THIẾU — v2 bổ sung

**Pháp lý & thuế (thiếu hoàn toàn):**
- Hóa đơn điện tử khởi tạo từ máy tính tiền — bắt buộc với nhiều hộ/doanh nghiệp bán lẻ (§2.1)
- Chuyển từ thuế khoán sang kê khai từ 01/01/2026 → hệ thống phải là nguồn số liệu doanh thu chuẩn (§2.2)
- Luật Bảo vệ dữ liệu cá nhân 2025 + NĐ 356/2025: đồng ý, quyền xóa, thời hạn xử lý yêu cầu (§2.3)
- Kiểm định cân thương mại (§2.5)

**Nghiệp vụ (thiếu hoặc chỉ nhắc tên):**
- Mua hàng: đơn đặt hàng NCC, nhận hàng có QC, trả hàng NCC, phân bổ chi phí nhập (landed cost), công nợ NCC, chiết khấu cuối kỳ (§6.3–6.4)
- Định nghĩa giá vốn cụ thể (theo lô) và cách hạch toán hao hụt trong/ngoài định mức (§6.6)
- Điều chuyển kho có trạng thái "đang vận chuyển" và chênh lệch khi nhận (§6.8)
- Máy trạng thái đơn hàng đầy đủ (hủy, giao thất bại, giao một phần, thay thế hàng) (§8.2)
- Giữ hàng (reservation) khi khách đặt online (§8.4)
- Thuật toán phân bổ đơn về cửa hàng (§8.3)
- Khung giờ giao và năng lực xử lý theo khung (§8.8)
- Đơn doanh nghiệp B2B: báo giá, đặt cọc, giao nhiều địa chỉ, công nợ, hóa đơn VAT (§8.11)
- Đặt trước theo mùa (Tết, Trung thu, 8/3, 20/10) (§8.12)
- Bảng giá đa tầng (kênh, cửa hàng, khung giờ, hạng thành viên) và quy tắc làm tròn (§5.4)
- Khuyến mãi/voucher, tích điểm, hạng thành viên có điều kiện & hạn dùng (§9.6–9.7)
- Sổ quỹ, thu chi ngoài bán hàng, đối soát COD theo shipper, đối soát cổng thanh toán (§7.10, §8.10)
- Quản lý nhân viên: đăng nhập PIN, ca làm, phân quyền theo cửa hàng (§3)
- Đề xuất đặt hàng bổ sung (reorder) theo tồn & hạn dùng (§6.10)

**Kỹ thuật (thiếu):**
- Offline POS: phạm vi, khóa idempotency, giải quyết xung đột (§7.11)
- Outbox pattern để phát sự kiện không mất (§4.4)
- Xác thực webhook thanh toán, chống replay, khớp giao dịch (§13.4)
- Nhật ký kiểm toán bất biến, sao lưu & khôi phục (Phần 14, §15.4)
- Kịch bản kiểm thử nghiệm thu (Phần 17)

### 0.4. Quyết định đã chốt (17/11/2026)

| # | Chủ đề | Lựa chọn | Tác động lên đặc tả |
|---|---|---|---|
| D1 | Mô hình pháp lý | **Công ty TNHH/CP** | HĐĐT theo doanh nghiệp (kế toán chọn: HĐĐT có mã hoặc khởi tạo từ máy tính tiền cho bán lẻ); VAT theo phương pháp của công ty; báo cáo tài chính cho cổ đông dùng số thực tế (§10.4). Bỏ phần "sổ doanh thu hộ kinh doanh" (§2.2 L2.1) → thay bằng xuất dữ liệu cho phần mềm kế toán |
| D2 | Quy mô 12 tháng | **2–5 cửa hàng + kho tổng** | Bắt buộc: kho tổng, điều chuyển (§6.8), phân bổ đơn đa cửa hàng (§8.3), viewer profile theo cửa hàng. Chưa cần cấp "vùng" (giữ `regions` nhưng mặc định 1 vùng) |
| D3 | POS quầy | **Flutter Windows** | Tablet soạn đơn/kiểm kê: Flutter Android. Next.js POS cũ không dùng cho dự án này |
| D4 | Hạ tầng | **VPS tự quản + Docker** | Docker Compose: api, worker, postgres, redis, reverse proxy (Caddy/Nginx); backup PITR (pgBackRest/WAL-G) đẩy ra object storage **ở nhà cung cấp khác**; giám sát uptime ngoài VPS |
| D5 | Xác nhận thanh toán | **SePay — VA theo đơn hàng** | Mỗi payment 1 VA đúng số tiền (§13.4); vẫn giữ màn khớp tay cho giao dịch lạ; kiểm tra ngân hàng nhận hỗ trợ VA trước khi mở tài khoản |
| D6 | HĐĐT | **MISA meInvoice** | Adapter đầu tiên = MISA; vẫn giữ interface `EInvoiceProvider` |
| D7 | Giao hàng | **Shipper nội bộ + 1 đối tác 3PL** | Làm app/module shipper + sổ COD (§8.9.2); 1 `CourierAdapter` đầu tiên (chọn Ahamove/Grab/Lalamove theo bên ký được hợp đồng) |
| D8 | Cân | **Cân quầy nối POS + cân in tem** | Làm cả `ScaleAdapter` (§7.12) và giải mã EAN-13 (§7.5); xuất file PLU cho cân in tem ở bản đầu |
| D9 | Catch-weight | **Cửa hàng chịu ≤3% (≤20.000đ); hỏi khách khi >5% hoặc >50.000đ; nhẹ hơn luôn hoàn** | Giá trị mặc định của `catch_weight_policies` (§8.5.3) |
| D10 | Thanh toán app | **Cả 3: trả trước theo tạm tính · trả sau khi cân · COD** | Trả sau khi cân bắt buộc với SKU `is_high_value`; COD có thể giới hạn theo giá trị đơn |
| D11 | Điểm thưởng | **Không làm điểm ở bản đầu** | Bỏ `loyalty_ledger` khỏi G3/G5; giữ **hạng thành viên + voucher**. **Credit cửa hàng vẫn cần** cho hoàn chênh cân & bảo hành (§2.4) — hạch toán credit do kế toán xác nhận |
| D12 | Bảo hành 24h | **Tự duyệt ≤100.000đ, tối đa 2 lần/30 ngày/khách; vượt → CSKH** | Tham số mặc định §8.13 |
| D13 | Người dùng Admin Chỉ Xem | **Cổ đông/nhà đầu tư + Ban giám đốc** | Tạo tối thiểu 2 viewer profile: `SHAREHOLDER` (báo cáo tài chính cơ sở **THỰC TẾ**, nhãn rõ; không thấy log thu ngân chi tiết) và `EXECUTIVE` (vận hành toàn chuỗi + báo cáo quản trị, được phép thấy số định mức có nhãn) |
| D14 | Giá vốn với viewer | **Chỉ thấy số đã phát hành** (`cost_visibility = PUBLISHED`) | Live mirror R1 không có giá vốn/lãi gộp; mọi giá vốn đi qua snapshot |
| D15 | Dữ liệu khách với viewer | **Che một phần** (`MASKED`) | Tên viết tắt + `098***4321`, không địa chỉ chi tiết; thống kê đầy đủ |
| D16 | Rebate NCC | **Theo kế toán quyết** | Hỗ trợ cả 2 cách (§6.3.5), cấu hình 1 lần |

**Còn mở — cần kế toán xác nhận:** loại HĐĐT cụ thể cho bán lẻ của công ty; nhóm thuế VAT từng loại hàng (quả tươi, khay cắt/nước ép, dịch vụ gọt, phí ship); cách hạch toán credit cửa hàng; cách hạch toán rebate. **Còn mở — cần bạn chốt sau:** model cân/máy in cụ thể, đối tác 3PL cụ thể, mẫu phiếu in & thương hiệu.

---

## Phần 1. Tổng quan, phạm vi & thuật ngữ

### 1.1. Mục tiêu kinh doanh

1. Bán hoa quả tươi đa kênh: tại quầy, app khách hàng, đơn doanh nghiệp/giỏ quà.
2. Minh bạch cân nặng với khách (ảnh cân, phiếu cân) → xóa tâm lý "mua online sợ thiếu cân, không tươi".
3. Giảm hủy hàng nhờ FEFO + độ chín + markdown có kiểm soát + chuyển chế biến.
4. Chủ hệ thống (Admin Toàn Quyền) kiểm soát tuyệt đối dữ liệu gốc; lãnh đạo/đối tác (Admin Chỉ Xem) theo dõi đầy đủ vận hành mà không chạm được dữ liệu nhạy cảm chưa được phép.
5. Tuân thủ hóa đơn điện tử, kê khai thuế, bảo vệ dữ liệu cá nhân ngay từ đầu.

### 1.2. Các ứng dụng trong hệ sinh thái

| Mã | Ứng dụng | Người dùng | Nền tảng khuyến nghị |
|---|---|---|---|
| A1 | **App Khách Hàng** | Khách lẻ, khách VIP, người tặng quà | Flutter iOS/Android (+ web đặt hàng nhanh ở giai đoạn sau) |
| A2 | **POS Cửa hàng** | Thu ngân, picker/đóng gói, cửa hàng trưởng | Flutter Windows (trạm quầy) + Flutter Android tablet (soạn đơn, kiểm kê) |
| A3 | **App Kho** (module của A2 hoặc riêng) | Thủ kho, nhân viên kho tổng | Flutter Android (quét mã, chụp ảnh, cân nhập) |
| A4 | **Admin Web** | Owner, Master Admin, Kế toán, Vận hành, Admin Chỉ Xem | Next.js (giao diện chính, đầy đủ nhất) |
| A5 | **Admin Mobile** | Master Admin, Admin Chỉ Xem | Flutter (dashboard, duyệt nhanh, thông báo) |
| A6 | **App Shipper nội bộ** (tùy chọn) | Shipper của cửa hàng | Flutter Android, hoặc module trong A2 |
| B1 | **Backend API + Realtime** | Tất cả | NestJS (modular monolith) + PostgreSQL + Redis |

> **Ghi chú:** "App Admin chia 2 phần" trong yêu cầu = **một codebase A4/A5**, giao diện và API khác nhau theo vai trò. Không làm 2 app riêng (tốn gấp đôi công bảo trì).

### 1.3. Ngoài phạm vi bản 1.0 (để sau)

- Đa doanh nghiệp (SaaS cho nhiều chuỗi khác) — thiết kế không chặn, nhưng không làm.
- Kế toán tổng hợp đầy đủ (sổ cái theo hệ thống tài khoản TT133/TT200) — chỉ xuất dữ liệu cho phần mềm kế toán.
- Dự báo nhu cầu bằng ML — bản 1.0 chỉ dùng trung bình động.
- Marketplace (Shopee/Grab Mart) — để giai đoạn sau qua module tích hợp.

### 1.4. Thuật ngữ

| Thuật ngữ | Nghĩa trong hệ thống |
|---|---|
| **Sản phẩm (Product)** | Loại quả nói chung: "Táo Envy" |
| **SKU / Biến thể** | Đơn vị bán cụ thể: "Táo Envy NZ size 24 — bán theo kg" |
| **Lô (Batch)** | Một dòng nhận hàng của 1 SKU từ 1 phiếu nhập; có giá vốn, hạn, độ chín riêng |
| **Catch-Weight** | Hàng đếm theo quả/chùm nhưng tính tiền theo cân thực |
| **Net / Gross / Tare** | Tịnh / Cả bì / Bì |
| **ATP (Available-To-Promise)** | Tồn khả dụng để nhận đơn = tồn thực − đang giữ − hệ số an toàn |
| **FEFO** | Hết hạn trước xuất trước |
| **Markdown** | Giảm giá do cận hạn/chín kỹ |
| **BOM** | Định mức thành phần (giỏ quà, khay cắt) |
| **Yield** | Tỷ lệ thu hồi khi sơ chế (5 kg dưa → 3.4 kg thịt quả = 68%) |
| **Landed cost** | Giá vốn nhập đã cộng cước, bốc xếp, phí khác |
| **Publish Gate** | Cổng phát hành dữ liệu từ vùng vận hành sang vùng báo cáo cho Admin Chỉ Xem |
| **Snapshot** | Bản báo cáo bất biến đã phát hành, có phiên bản |
| **Ca (Shift)** | Phiên làm việc của 1 thu ngân trên 1 két |
| **Z-report** | Báo cáo chốt ca/chốt ngày không sửa được |

---

## Phần 2. Ràng buộc pháp lý & tuân thủ

> Phần này tổng hợp từ các nguồn công khai (xem Phụ lục F). **Không thay thế tư vấn của kế toán/luật sư** — cần xác nhận với họ trước khi vận hành, đặc biệt mục 2.1, 2.2, 2.4.

### 2.1. Hóa đơn điện tử khởi tạo từ máy tính tiền

**Căn cứ:** NĐ 123/2020/NĐ-CP được sửa đổi bởi NĐ 70/2025/NĐ-CP (hiệu lực 01/06/2025).

**Điểm chính ảnh hưởng thiết kế:**
- Hộ kinh doanh có doanh thu từ 1 tỷ đồng/năm trở lên phải dùng hóa đơn điện tử khởi tạo từ máy tính tiền có kết nối dữ liệu với cơ quan thuế.
- Hóa đơn phải được lập **ngay tại thời điểm hoàn thành giao dịch**, không phụ thuộc khách có lấy hóa đơn hay không.
- Thông tin người mua (tên, địa chỉ, MST/số định danh/SĐT) chỉ cần khi người mua yêu cầu; nếu người mua là cơ sở kinh doanh có MST thì phải ghi.
- Hộ có nhiều địa điểm kinh doanh dùng chung MST và **phải ghi rõ địa chỉ từng điểm** trên hóa đơn.

**Yêu cầu hệ thống:**
| Mã | Yêu cầu |
|---|---|
| L1.1 | Mỗi giao dịch hoàn tất (POS hoặc đơn online đã giao/đã thanh toán) sinh **1 yêu cầu phát hành hóa đơn** gửi qua nhà cung cấp HĐĐT (MISA meInvoice, Viettel, VNPT, Sapo Invoice…) qua API |
| L1.2 | Bảng `core.einvoices` lưu: mã tra cứu, ký hiệu, số, trạng thái (PENDING/ISSUED/FAILED/REPLACED/ADJUSTED/CANCELLED), payload gửi, phản hồi, số lần thử |
| L1.3 | Hàng đợi gửi lại tự động khi mất mạng (BullMQ, backoff mũ); cảnh báo Master Admin nếu PENDING > 30 phút |
| L1.4 | Mỗi cửa hàng cấu hình: địa chỉ in trên hóa đơn, ký hiệu hóa đơn, tài khoản nhà cung cấp HĐĐT |
| L1.5 | Hủy/điều chỉnh/thay thế hóa đơn theo đúng nghiệp vụ của nhà cung cấp (không xóa) |
| L1.6 | Đơn catch-weight: hóa đơn **phát hành theo số cân thực tế cuối cùng**, không theo số tạm tính |
| L1.7 | Phiếu in từ máy in nhiệt in kèm **mã tra cứu/QR tra cứu hóa đơn** nếu nhà cung cấp hỗ trợ |
| L1.8 | Tách rõ "Phiếu tạm tính" (chưa phải hóa đơn) và "Hóa đơn" trên mẫu in |

### 2.2. Thuế hộ kinh doanh: bỏ thuế khoán từ 01/01/2026

- Theo NQ 198/2025/QH15, từ 01/01/2026 hộ/cá nhân kinh doanh không áp dụng phương pháp khoán, chuyển sang tự kê khai, tự nộp theo doanh thu thực tế.
- **Hệ quả thiết kế:** hệ thống là **nguồn số liệu doanh thu chính thức** để kê khai → số liệu doanh thu trong `core` **không được sửa sau khi khóa kỳ**, mọi điều chỉnh qua chứng từ điều chỉnh có log.
- **Yêu cầu:**
  - L2.1 Báo cáo "Sổ doanh thu bán hàng" theo kỳ khai thuế (tháng/quý), theo từng địa điểm, có thể xuất Excel cho kế toán.
  - L2.2 Danh mục **nhóm thuế** gắn với SKU (hàng nông sản chưa chế biến, hàng đã chế biến như nước ép/khay cắt, dịch vụ gọt/giao hàng) — tỷ lệ thuế **cấu hình được**, không hardcode, vì chính sách thay đổi (ví dụ NĐ 68/2026/NĐ-CP về chính sách thuế với hộ kinh doanh). **Kế toán xác nhận tỷ lệ cụ thể.**
  - L2.3 Chức năng **khóa kỳ (period close)** — xem §10.6.
  - L2.4 Quyết định Q1 (Phần 18): mô hình pháp lý là **hộ kinh doanh** hay **công ty** — ảnh hưởng hóa đơn (máy tính tiền vs HĐĐT thường), thuế, báo cáo.

### 2.3. Bảo vệ dữ liệu cá nhân

**Căn cứ:** Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15 (hiệu lực 01/01/2026) và NĐ 356/2025/NĐ-CP (thay thế NĐ 13/2023).

- Luật trao cho chủ thể dữ liệu các quyền: được biết, đồng ý, truy cập, chỉnh sửa, yêu cầu xóa dữ liệu.
- Mức phạt hành chính có thể tới 3 tỷ đồng với tổ chức.
- Hộ kinh doanh, doanh nghiệp siêu nhỏ/nhỏ/khởi nghiệp có thể được miễn một số nghĩa vụ (ví dụ đánh giá tác động) nếu không xử lý dữ liệu nhạy cảm hoặc kinh doanh dịch vụ xử lý dữ liệu — **cần xác nhận với luật sư**.
- NĐ 356 quy định thời hạn xử lý yêu cầu của chủ thể dữ liệu (ví dụ yêu cầu xóa có thời hạn tính bằng ngày) — hệ thống phải theo dõi được hạn.

**Yêu cầu hệ thống:**
| Mã | Yêu cầu |
|---|---|
| L3.1 | Màn hình đồng ý khi đăng ký app: tách **đồng ý bắt buộc** (xử lý đơn hàng, giao hàng) và **tùy chọn** (marketing, thông báo khuyến mãi, phân tích hành vi). Lưu `customer_consents` có phiên bản chính sách, thời điểm, kênh |
| L3.2 | Khách rút lại đồng ý marketing bất cứ lúc nào trong app |
| L3.3 | Khách xem & tải dữ liệu của mình; yêu cầu xóa tài khoản → **ẩn danh hóa** (giữ hóa đơn cho nghĩa vụ thuế, xóa/che PII) — tái sử dụng luồng account deletion đã có ở dự án trước |
| L3.4 | Bảng `privacy_requests` có hạn xử lý, trạng thái, người xử lý; cảnh báo sắp quá hạn |
| L3.5 | **Xuất danh sách khách hàng có PII** (chỉ Master Admin): bắt buộc xác thực lại (step-up 2FA), nhập lý do, file có watermark người xuất + thời gian, ghi `audit.export_logs` |
| L3.6 | Che PII mặc định ở mọi màn hình nhân viên cửa hàng (chỉ thấy tên + 3 số cuối SĐT; shipper thấy SĐT qua nút gọi, không thấy danh sách) |
| L3.7 | Mã hóa cột nhạy cảm khi lưu (SĐT, địa chỉ chi tiết, ghi chú VIP) bằng `pgcrypto` hoặc mã hóa tầng ứng dụng; tìm kiếm SĐT qua cột hash (`phone_hash`) |
| L3.8 | Dữ liệu nhân viên nghỉ việc: quy trình xóa/ẩn danh sau thời hạn lưu trữ cần thiết |
| L3.9 | Chính sách quyền riêng tư công khai trong app và trên web |

### 2.4. Thanh toán & "ví"

- NĐ 52/2024/NĐ-CP (hiệu lực 01/07/2024) định nghĩa tiền điện tử và quy định ví điện tử, thẻ trả trước là phương tiện lưu trữ tiền điện tử, do ngân hàng hoặc tổ chức trung gian thanh toán được cấp phép cung ứng.
- **Quyết định thiết kế:**
  - Không xây "ví nạp tiền" tự quản.
  - Xây **Credit cửa hàng (store credit)**: chỉ phát sinh từ hoàn tiền đơn/bảo hành/khuyến mãi; không nạp bằng tiền; không rút tiền mặt; có hạn dùng; chỉ trừ vào đơn mua hàng. Hạch toán như **khoản nợ phải trả/khuyến mãi**, báo cáo số dư credit đang lưu hành.
  - Khi hoàn tiền thật bằng tiền: hoàn về tài khoản ngân hàng khách (chuyển khoản thủ công có chứng từ, hoặc qua cổng thanh toán nếu hỗ trợ refund).
  - **Cần luật sư xác nhận** mô hình credit trước khi phát hành.
- Thẻ quà tặng (gift card) bán ra lấy tiền = rủi ro tương tự → để sau, cần tư vấn.

### 2.5. Đo lường — cân điện tử

- Cân dùng để định lượng hàng hóa trong mua bán thuộc **phương tiện đo nhóm 2**, phải kiểm định và chứng chỉ kiểm định (tem, dấu, giấy chứng nhận) còn hạn.
- **Yêu cầu hệ thống:**
  - L5.1 Danh mục thiết bị `devices` lưu: loại (cân quầy/cân in tem/cân nhập kho), số serial, ngày kiểm định, **hạn kiểm định**, ảnh tem.
  - L5.2 Cảnh báo trước 30 ngày khi sắp hết hạn; khi đã hết hạn → POS hiển thị cảnh báo đỏ và Master Admin quyết định khóa hay cho dùng tạm (có log).
  - L5.3 Trọng lượng trên hóa đơn/phiếu cân luôn ghi rõ **khối lượng tịnh**; nếu đóng hộp có bì thì in cả bì đã trừ.

### 2.6. Các nghĩa vụ khác

| Mã | Nội dung | Yêu cầu |
|---|---|---|
| L6.1 | Niêm yết giá | App và POS hiển thị rõ **đơn giá/kg** và **giá tạm tính**; không chỉ hiển thị giá/quả khi thực tế tính theo kg |
| L6.2 | App Store / Google Play | Có chức năng xóa tài khoản trong app; khai báo quyền riêng tư; hàng hóa vật lý được dùng thanh toán ngoài (VietQR, COD) |
| L6.3 | Truy xuất nguồn gốc | Lưu NCC, xuất xứ, ngày nhập, chứng nhận (VietGAP/GlobalGAP, giấy kiểm dịch hàng nhập khẩu) theo lô; hiển thị cho khách ở mức phù hợp |
| L6.4 | Hóa đơn đầu vào | Lưu ảnh/số hóa đơn đầu vào của NCC theo phiếu nhập để kế toán đối chiếu |
| L6.5 | Lưu trữ chứng từ | Không xóa vật lý hóa đơn, phiếu nhập, phiếu hủy; chỉ hủy logic |


---

## Phần 3. Vai trò, phân quyền & bảo mật tài khoản

### 3.1. Nguyên tắc

1. **Deny-by-default:** mọi endpoint phải khai báo permission; không khai báo = cấm.
2. **RBAC + Scope + Field policy:** quyền = (vai trò) × (phạm vi: toàn chuỗi / vùng / danh sách cửa hàng / kho) × (chính sách trường dữ liệu: ẩn / che / hiện).
3. **Tách nhiệm vụ (Segregation of Duties):** người tạo phiếu không tự duyệt phiếu của mình (phiếu hủy, điều chỉnh kiểm kê, hoàn tiền lớn, đổi giá nhập sau khóa kỳ).
4. **Admin Toàn Quyền ≥ Admin Chỉ Xem:** mọi thứ Admin Chỉ Xem thấy, Admin Toàn Quyền đều thấy, cộng thêm khả năng **"Xem như tài khoản X"** (preview đúng những gì một Admin Chỉ Xem cụ thể đang thấy) — đáp ứng yêu cầu "quyền cao hơn hoặc ngang bằng".

### 3.2. Danh sách vai trò

| Mã vai trò | Tên | Ứng dụng | Phạm vi điển hình | Mô tả |
|---|---|---|---|---|
| `OWNER` | Chủ sở hữu | A4, A5 | Toàn hệ thống | Cao nhất. Tạo/khóa tài khoản Master Admin, cấu hình bảo mật, xem toàn bộ audit log. Tối thiểu 1, khuyến nghị 2 (dự phòng mất tài khoản) |
| `MASTER_ADMIN` | Admin Toàn Quyền | A4, A5 | Toàn hệ thống | Toàn quyền vận hành `core`, điều khiển Publish Gate, quản lý tài khoản Admin Chỉ Xem và nhân viên |
| `VIEW_ONLY_ADMIN` | Admin Chỉ Xem | A4, A5 | Toàn chuỗi hoặc giới hạn vùng/cửa hàng | Chỉ đọc vùng `reporting` theo **hồ sơ hiển thị** (Viewer Profile) do Master Admin cấu hình |
| `ACCOUNTANT` | Kế toán | A4 | Toàn hệ thống | Xem giá vốn thật, công nợ, sổ quỹ, hóa đơn; tạo chứng từ điều chỉnh; khóa kỳ (nếu được giao); không sửa danh mục/giá bán |
| `OPS_MANAGER` | Quản lý vận hành | A4, A5 | Vùng/chuỗi | Điều phối đơn, kho, giao vận, duyệt điều chuyển, duyệt hủy trong hạn mức; **không thấy giá nhập thật** (mặc định) |
| `PURCHASER` | Nhân viên thu mua | A4, A3 | Kho tổng | Tạo đơn đặt NCC, nhập giá nhập, nhận hàng; không duyệt thanh toán NCC |
| `WAREHOUSE_MANAGER` | Thủ kho trưởng | A3, A4 | Kho được giao | Nhận hàng, QC, điều chuyển, kiểm kê, duyệt hủy trong hạn mức |
| `WAREHOUSE_STAFF` | Nhân viên kho | A3 | Kho được giao | Quét, cân, chụp ảnh, soạn hàng điều chuyển |
| `STORE_MANAGER` | Cửa hàng trưởng | A2, A5 | Cửa hàng được giao | Mở/đóng cửa hàng, duyệt hủy dòng/hoàn tiền tại quầy trong hạn mức, kiểm kê, sơ chế, xem báo cáo cửa hàng (doanh thu, không thấy giá nhập) |
| `CASHIER` | Thu ngân | A2 | 1 cửa hàng | Bán hàng, nhận thanh toán, mở/đóng ca của mình |
| `PICKER` | Soạn/đóng gói | A2 (tablet) | 1 cửa hàng | Nhận đơn online, nhặt, cân, chụp ảnh, đóng gói, gọi ship |
| `SHIPPER` | Shipper nội bộ | A6 | Cửa hàng | Nhận chuyến, cập nhật trạng thái, chụp ảnh giao, thu COD |
| `CS_AGENT` | Chăm sóc khách hàng | A4 | Toàn chuỗi | Xem đơn, xử lý khiếu nại/bảo hành, cấp credit trong hạn mức; PII bị che một phần |
| `CUSTOMER` | Khách hàng | A1 | Bản thân | Mua hàng, quản lý tài khoản |
| `B2B_BUYER` | Khách doanh nghiệp | A1/web | Công ty mình | Đặt đơn số lượng lớn, xem công nợ của công ty |

> Một nhân viên có thể có nhiều vai trò ở nhiều cửa hàng (ví dụ: `CASHIER` ở CH1 và `PICKER` ở CH2) → bảng `user_role_assignments(user_id, role, scope_type, scope_id)`.

### 3.3. Ma trận quyền theo nhóm dữ liệu (rút gọn)

Ký hiệu: **F** = toàn quyền · **E** = sửa · **C** = tạo · **A** = duyệt · **R** = xem · **R\*** = xem bản đã che/đã phát hành · **—** = không

| Nhóm dữ liệu | OWNER | MASTER | VIEW_ONLY | ACCOUNTANT | OPS_MGR | WH_MGR | STORE_MGR | CASHIER | PICKER |
|---|---|---|---|---|---|---|---|---|---|
| Tài khoản Master/Owner | F | R | — | — | — | — | — | — | — |
| Tài khoản Admin Chỉ Xem & Viewer Profile | F | F | — | — | — | — | — | — | — |
| Tài khoản nhân viên | F | F | — | R | E (vùng) | — | E (cửa hàng, chỉ CASHIER/PICKER) | — | — |
| Danh mục SP, SKU, BOM | F | F | R | R | E | R | R | R | R |
| Giá bán / bảng giá | F | F | R | R | E (nếu được giao) | — | R | R | — |
| **Giá nhập thật, landed cost, chiết khấu NCC** | F | F | R\* (theo profile) | F | — | — | — | — | — |
| Giá vốn công bố/định mức | F | F | R\* | R | R (tùy cấu hình) | — | — | — | — |
| Phiếu nhập, NCC, công nợ NCC | F | F | R\* | F | R | C/R (không giá) | — | — | — |
| Tồn kho theo lô | F | F | R\* | R | R | E | R | R | R |
| Điều chuyển kho | F | F | R\* | R | A | C/A | C (yêu cầu)/nhận | — | — |
| Kiểm kê & điều chỉnh | F | F | R\* | R | A | C/A ≤ hạn mức | C/A ≤ hạn mức | — | — |
| Phiếu hủy hàng | F | F | R\* | R | A | C/A ≤ hạn mức | C/A ≤ hạn mức | C | C |
| Hóa đơn & đơn hàng | F | F | R\* | R | E (điều phối) | — | R (cửa hàng) | C | E (fulfillment) |
| Hủy hóa đơn sau thanh toán / hoàn tiền | F | F | — | A | A ≤ hạn mức | — | A ≤ hạn mức | — | — |
| Log thao tác thu ngân (xóa dòng, mở két) | F | F | R\* (tổng hợp) | R | R | — | R (cửa hàng) | — | — |
| Hồ sơ khách hàng đầy đủ (PII) | F | F | R\* (theo profile) | R (che) | R (che) | — | R (che) | R (che) | R (che) |
| Xuất danh sách khách có PII | F | F (step-up) | — | — | — | — | — | — | — |
| Cấu hình vận chuyển, phí ship | F | F | R | — | E | — | — | — | — |
| Cấu hình cửa hàng, thiết bị | F | F | R | — | E | E (kho) | E (thiết bị CH) | — | — |
| Khuyến mãi, voucher | F | F | R | R | E | — | — | — | — |
| Publish Gate | F | F | — | C (chuẩn bị, nếu được giao) | — | — | — | — | — |
| Báo cáo đã phát hành | F | F | R | R | R | — | — | — | — |
| Audit log | F | R | — | R (tài chính) | — | — | — | — | — |

### 3.4. Hạn mức duyệt (cấu hình được)

| Hành động | CASHIER | STORE_MGR | OPS_MGR | MASTER |
|---|---|---|---|---|
| Xóa dòng hàng trước thanh toán | Được, có log | — | — | — |
| Giảm giá tay trên dòng | ≤ 0% | ≤ 10% hoặc ≤ 50.000đ | ≤ 20% | Không giới hạn |
| Hủy hóa đơn đã thanh toán | — | ≤ 500.000đ, trong ca | ≤ 5.000.000đ | Không giới hạn |
| Hoàn tiền / cấp credit bảo hành | — | ≤ 200.000đ | ≤ 2.000.000đ | Không giới hạn |
| Duyệt phiếu hủy hàng | — | ≤ 1.000.000đ giá vốn/phiếu | ≤ 10.000.000đ | Không giới hạn |
| Điều chỉnh kiểm kê | — | ≤ 2% hoặc ≤ 1.000.000đ | ≤ 5% | Không giới hạn |
| Nhập cân tay khi cân lỗi | — | Được (PIN + lý do) | Được | Được |
| Mở két không bán | — | Được (PIN + lý do) | — | — |

### 3.5. Bảo mật tài khoản

| Mã | Yêu cầu |
|---|---|
| SEC1 | OWNER, MASTER_ADMIN, ACCOUNTANT, VIEW_ONLY_ADMIN: **bắt buộc 2FA** (TOTP qua app Authenticator; dự phòng mã khôi phục) |
| SEC2 | **Step-up authentication** (nhập lại 2FA trong vòng 5 phút) cho: xuất PII, sửa giá nhập đã khóa kỳ, phát hành snapshot, tạo/khóa tài khoản admin, đổi cấu hình bảo mật |
| SEC3 | Nhân viên POS đăng nhập bằng **mã nhân viên + PIN 6 số** trên thiết bị đã đăng ký; thiết bị POS phải được Master/Store Manager **kích hoạt** (device binding) |
| SEC4 | Access token JWT 15 phút + refresh token xoay vòng (rotation) lưu hash trong DB, thu hồi được theo thiết bị |
| SEC5 | Khóa tài khoản tạm thời sau 5 lần sai; cảnh báo đăng nhập từ thiết bị/IP mới cho tài khoản admin |
| SEC6 | Phiên admin tự hết hạn sau 30 phút không thao tác (web) |
| SEC7 | Danh sách phiên đang hoạt động, đăng xuất từ xa |
| SEC8 | Mật khẩu: tối thiểu 10 ký tự, kiểm tra danh sách mật khẩu phổ biến, băm bằng Argon2id |
| SEC9 | Khách hàng: đăng nhập OTP SMS/Zalo ZNS; giới hạn gửi OTP (theo SĐT, IP, thiết bị) để chống spam tốn phí |

### 3.6. Thực thi quyền của Admin Chỉ Xem — 4 lớp (thay cho "3 lớp" bản v1)

| Lớp | Cơ chế | Chi tiết |
|---|---|---|
| L1 — Giao diện | Ẩn nút, ẩn cột | Chỉ là trải nghiệm, **không phải lớp bảo mật** |
| L2 — API | **Module/route riêng** `/viewer/*` + `PermissionGuard` deny-by-default | Admin Chỉ Xem **không được gọi bất kỳ route nào ngoài `/viewer/*` và `/auth/*`**. Các route `/viewer/*` chỉ đọc từ schema `reporting`. Danh sách `POST` được phép: `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/2fa/*`, `/viewer/exports` (yêu cầu tạo file từ snapshot đã phát hành), `/viewer/notifications/read` |
| L3 — Kết nối DB | Connection pool riêng với role `viewer_ro` | `viewer_ro` chỉ có `SELECT` trên schema `reporting`; **không có quyền `USAGE` trên schema `core`** → kể cả bug ở code cũng không đọc được bảng gốc |
| L4 — Row-Level Security | RLS trên bảng `reporting.*` | Mỗi truy vấn đặt `SET LOCAL app.viewer_profile_id = …`; policy RLS lọc theo cửa hàng/vùng được phép trong profile |

Ngoài ra: rate limit riêng cho viewer, mọi lần tải file từ Trung tâm Báo cáo được ghi log.

---

## Phần 4. Kiến trúc kỹ thuật tổng thể

### 4.1. Lựa chọn kiến trúc: Modular Monolith

Với 1 lập trình viên, **không dùng microservices**. Một ứng dụng NestJS chia module rõ ranh giới, một PostgreSQL, một Redis. Có thể tách worker (xử lý hàng đợi) thành process riêng chạy cùng codebase.

```
                   ┌───────────────────────────────────────────────┐
  App Khách (A1) ──┤                                               │
  POS (A2/A3)    ──┤  NestJS API  (REST /v1/*)                     │
  Admin (A4/A5)  ──┤  ├─ module: auth, users, rbac                 │
  Shipper (A6)   ──┤  ├─ module: catalog, pricing, promotions      │
                   │  ├─ module: inventory, purchasing, processing │
                   │  ├─ module: sales (pos), orders, fulfillment  │
                   │  ├─ module: delivery, payments, einvoice      │
                   │  ├─ module: customers, loyalty, care          │
                   │  ├─ module: reporting, publish-gate, viewer   │
                   │  └─ module: audit, notifications, files       │
                   │                                               │
                   │  Realtime Gateway (Socket.IO, rooms)          │
                   └──────────────┬──────────────────┬─────────────┘
                                  │                  │
                         ┌────────▼───────┐   ┌──────▼──────┐
                         │ PostgreSQL     │   │ Redis       │
                         │ core/reporting │   │ cache,      │
                         │ audit/integr.  │   │ pub/sub,    │
                         └────────▲───────┘   │ BullMQ      │
                                  │           └──────▲──────┘
                         ┌────────┴──────────────────┴──────┐
                         │ Worker: outbox relay, projection, │
                         │ einvoice, notifications, exports, │
                         │ ripeness scan, reorder, retries   │
                         └───────────────┬───────────────────┘
                                         │
        ┌──────────────┬─────────────────┼────────────────┬──────────────┐
        │ Cổng TT       │ HĐĐT            │ 3PL giao hàng  │ Bản đồ       │ Lưu file (S3-compatible)
        │ SePay/payOS   │ MISA/Viettel…   │ Ahamove/Grab/  │ Goong/Google │ ảnh cân, ảnh hủy,
        │ (VietQR+hook) │                 │ Lalamove       │ /OSRM        │ file báo cáo
        └───────────────┴─────────────────┴────────────────┴──────────────┘
```

### 4.2. Lựa chọn nền tảng từng ứng dụng

| Ứng dụng | Lựa chọn | Lý do | Phương án thay thế |
|---|---|---|---|
| App Khách | Flutter | Đã có kinh nghiệm build iOS qua Codemagic, FCM/APNs | — |
| POS quầy | **Flutter Windows** | Đọc cổng COM (cân RS232/USB-serial) qua thư viện serial, in ESC/POS qua USB/LAN, SQLite cho offline, màn hình phụ hướng khách (cửa sổ thứ 2) | Next.js web POS (đang có ở dự án trước) + một **"agent" cục bộ** nhỏ chạy nền (Node/Go) để nói chuyện với cân/máy in qua localhost. Tốn thêm 1 thành phần |
| POS tablet (soạn đơn, kiểm kê) | Flutter Android | Dùng camera, quét mã, cân Bluetooth | — |
| Admin Web | Next.js | Bảng dữ liệu lớn, xuất file, nhiều màn hình | — |
| Admin Mobile | Flutter (dùng chung package model/API với App Khách) | Dashboard, duyệt nhanh, push | PWA responsive của Admin Web cho giai đoạn đầu |

> **Mã nguồn chung:** một package Dart `shared_models` (DTO, enum trạng thái, định dạng tiền/cân) dùng chung cho A1/A2/A3/A5/A6; sinh từ OpenAPI của backend để không lệch.

### 4.3. Phân vùng cơ sở dữ liệu

**Một database PostgreSQL**, nhiều schema:

| Schema | Nội dung | Ai ghi | Ai đọc |
|---|---|---|---|
| `core` | Toàn bộ dữ liệu vận hành gốc (tương ứng `ops_core` bản v1) | API (role `app_rw`) | API (role `app_rw`) |
| `reporting` | Bảng chiếu realtime đã lọc + snapshot đã phát hành (tương ứng `exec_reporting`) | Worker projection & Publish Gate (role `projector_rw`) | Viewer API (role `viewer_ro`) và Admin API |
| `audit` | Nhật ký thao tác, đăng nhập, xuất file — **chỉ INSERT** | API (role `audit_writer`, chỉ có quyền INSERT) | OWNER/MASTER qua API |
| `integration` | Outbox, inbox webhook, log gọi API bên thứ ba | API, Worker | Worker |

> Việc gộp DB app và DB POS làm một (đang cân nhắc ở dự án trước) phù hợp với thiết kế này: một nguồn sự thật, realtime qua sự kiện thay cho cron đồng bộ.

### 4.4. Luồng sự kiện: Transactional Outbox

1. Trong cùng transaction ghi nghiệp vụ (ví dụ chốt hóa đơn), ghi thêm 1 dòng vào `integration.outbox_events` (`event_type`, `aggregate_id`, `payload`, `occurred_at`).
2. Worker đọc outbox (theo thứ tự, `FOR UPDATE SKIP LOCKED`), phát vào Redis Pub/Sub + BullMQ, đánh dấu đã gửi.
3. Các consumer: projection (cập nhật `reporting.*`), realtime gateway (đẩy socket), notifications (push/SMS), einvoice, tích hợp 3PL.
4. Consumer **idempotent** theo `event_id` (bảng `integration.processed_events`).

→ Không mất sự kiện khi Redis/Worker chết; không có trạng thái "đã lưu đơn nhưng không báo cửa hàng".

### 4.5. Realtime Gateway

- Socket.IO, xác thực bằng access token khi kết nối.
- Rooms: `store:{id}`, `store:{id}:fulfillment`, `order:{id}` (khách theo dõi đơn), `shipper:{id}`, `admin:ops`, `viewer:{profile_id}`.
- Admin Chỉ Xem **chỉ nhận sự kiện đã qua projection + masking** từ room `viewer:{profile_id}`, không bao giờ join room vận hành.
- Mất kết nối → client gọi REST lấy trạng thái mới nhất (không phụ thuộc socket để đúng dữ liệu).
- Chuông đơn mới tại cửa hàng: lặp lại mỗi 15 giây đến khi có người bấm "Nhận xử lý"; nếu quá **3 phút** chưa nhận → báo cửa hàng trưởng; quá **5 phút** → báo OPS_MANAGER và gợi ý chuyển cửa hàng.

### 4.6. Lưu trữ file

- Ảnh (cân, hủy hàng, giao hàng, bảo hành), file báo cáo → object storage tương thích S3 (Cloudflare R2, MinIO, S3…).
- Upload trực tiếp từ client bằng **presigned URL** ngắn hạn; backend lưu metadata (`files`: id, owner, loại, sha256, kích thước, thời điểm chụp, thiết bị, GPS nếu có).
- Ảnh hủy/ảnh cân: client thêm **watermark** (mã cửa hàng, thời gian, mã nhân viên) trước khi upload; server so `sha256` để phát hiện tải lại ảnh cũ.
- Thời hạn lưu: ảnh cân/giao hàng 180 ngày; ảnh hủy hàng & chứng từ theo thời hạn lưu chứng từ kế toán (cấu hình).

### 4.7. Hạ tầng & môi trường

- 3 môi trường: `dev` (máy local, Docker Compose), `staging`, `production`.
- Nền tảng triển khai: **quyết định Q8** (Phần 18). Yêu cầu tối thiểu: PostgreSQL có backup tự động + PITR, Redis, chạy được 2 process (API + Worker), HTTPS, biến môi trường bí mật.
- CI: lint + test + build; migration chạy tự động có kiểm tra (Prisma Migrate hoặc TypeORM migrations — **không dùng `synchronize: true` ở production**).


---

## Phần 5. Dữ liệu danh mục (Master Data)

### 5.1. Cây sản phẩm 3 tầng

```
Danh mục (Category)        : Quả nhập khẩu > Táo
  └─ Sản phẩm (Product)    : Táo Envy
       ├─ SKU              : Táo Envy NZ size 24 — bán theo kg (catch-weight)
       ├─ SKU              : Táo Envy NZ size 24 — hộp 1 kg cố định
       ├─ SKU              : Táo Envy NZ size 30 — bán theo quả
       └─ SKU (BOM)        : Giỏ quà Phú Quý 1.200.000đ (chứa nhiều SKU)
```

- **Product** chứa thông tin hiển thị chung: tên, mô tả, ảnh, xuất xứ mặc định, mùa vụ, hướng dẫn bảo quản, tag (giòn/mềm/ngọt/chua), nhóm thuế.
- **SKU** chứa thông tin bán & kho: mã SKU, mã PLU 5 số cho cân, barcode, kiểu bán, quy cách, size/grade, trọng lượng chuẩn, bì, giá.

### 5.2. Kiểu bán (`sale_unit_type`) — mở rộng từ 3 kiểu của bản v1

| Kiểu | Ví dụ | Đơn vị kho | Đơn vị tính tiền | Catch-weight? |
|---|---|---|---|---|
| `WEIGHT` | Nho Mẫu Đơn bán theo kg | gram | đ/kg × gram thực | Có |
| `PIECE_BY_WEIGHT` | Dưa lưới 1 quả, Sầu riêng 1 trái | gram + số quả | đ/kg × gram thực | Có (đặt theo quả, tính theo cân) |
| `PIECE_FIXED` | Bơ 034 — 25.000đ/quả | số quả (+ gram tham khảo) | đ/quả | Không |
| `PACK_FIXED` | Hộp dâu 250 g | hộp | đ/hộp | Không (kiểm tra định lượng khi đóng gói) |
| `PACK_VARIABLE` | Khay cắt sẵn dán tem cân | gram | đ/kg × gram trên tem | Có (tem in sẵn) |
| `BUNDLE_BOM` | Giỏ quà, combo | (không tồn riêng, trừ thành phần) | đ/giỏ | Không |
| `MADE_TO_ORDER` | Nước ép, khay gọt theo đơn | (trừ nguyên liệu theo định mức) | đ/ly, đ/khay | Không |
| `SERVICE` | Phí gọt, phí gói quà, phí giao | — | đ/lần | Không |

**Thuộc tính SKU bắt buộc theo kiểu:**

| Trường | Ý nghĩa | Áp dụng |
|---|---|---|
| `std_weight_g` | Trọng lượng chuẩn 1 đơn vị (để tạm tính) | PIECE_BY_WEIGHT, PIECE_FIXED, PACK_FIXED |
| `weight_min_g`, `weight_max_g` | Khoảng cân hợp lệ cho 1 quả (chặn nhặt quả quá nhỏ/to so với size) | PIECE_BY_WEIGHT |
| `tare_g` | Bì mặc định (hộp, khay, túi lưới) | PACK_*, khi cân bán có bao bì |
| `min_order_g`, `step_g` | Đặt tối thiểu, bước đặt (ví dụ 500 g, bước 250 g) | WEIGHT |
| `price_per_kg` hoặc `price_per_unit` | Giá niêm yết gốc | theo kiểu |
| `scale_plu` | Mã PLU 5 số trên cân | WEIGHT, PIECE_BY_WEIGHT, PACK_VARIABLE |
| `shelf_life_days`, `storage_temp_min/max` | Hạn dùng chuẩn, nhiệt độ bảo quản | tất cả hàng tươi |
| `ripeness_profile_id` | Bộ quy tắc độ chín (xem §6.5) | quả chín sau thu hoạch (xoài, bơ, chuối, sầu riêng, đu đủ…) |
| `shrink_norm_pct` | Định mức hao hụt cho phép **theo tuần** hoặc theo chu kỳ hàng | hàng tươi |
| `tax_category_id` | Nhóm thuế | tất cả |
| `is_high_value` | Hàng giá trị cao → kiểm đếm cuối ca, ảnh cân bắt buộc | ví dụ Cherry, Sầu riêng, Nho Mẫu Đơn |
| `allow_substitution` | Cho phép thay SKU tương đương khi hết | tất cả |
| `substitute_skus[]` | Danh sách SKU thay thế + chênh lệch giá cho phép | — |

### 5.3. Tùy chọn trên dòng hàng (Modifiers)

- **Nhóm tùy chọn** gắn với Product/SKU: `RIPENESS` (độ chín), `PREP` (sơ chế), `PACKING` (đóng gói), `NOTE` (ghi chú tự do).
- Mỗi tùy chọn: tên, phụ phí (đ hoặc đ/kg), bắt buộc/không, chọn 1/chọn nhiều, ánh xạ sang giai đoạn độ chín (để picker lọc lô phù hợp) hoặc sang phiếu sơ chế (để trừ nguyên liệu đúng yield).
- Ví dụ Xoài Cát Hòa Lộc: RIPENESS (bắt buộc, chọn 1) = {Ăn ngay hôm nay → STAGE_3 · Để 2–3 ngày → STAGE_2 · Xanh để cúng → STAGE_1}; PREP = {Nguyên quả · Gọt bổ khay lạnh +10.000đ · …}.
- **Lưu ý:** sơ chế làm giảm trọng lượng (bỏ vỏ, hạt) → giá tính theo **trọng lượng trước sơ chế** (cân nguyên quả) + phí dịch vụ; hiển thị rõ cho khách "Giá tính trên trọng lượng nguyên quả trước khi gọt".

### 5.4. Bảng giá (Pricing)

**Thứ tự ưu tiên giá (cao → thấp):**
1. Giá markdown của **lô cụ thể** (đã duyệt, còn hiệu lực)
2. Giá khuyến mãi theo chương trình (thời gian, kênh, cửa hàng)
3. Bảng giá theo **hạng thành viên** (nếu có)
4. Bảng giá theo **kênh** (POS / APP / B2B) và **cửa hàng/vùng**
5. Giá niêm yết gốc của SKU

**Bảng `price_lists`**: `id, name, channel, store_ids[], member_tier, valid_from, valid_to, priority`; **`price_list_items`**: `price_list_id, sku_id, price_per_kg | price_per_unit`.

**Quy tắc làm tròn tiền (bắt buộc thống nhất ở mọi tầng):**
- Thành tiền dòng catch-weight: `line_amount = round_half_up(price_per_kg × weight_g / 1000)` → làm tròn đến **1 đồng**, sau đó (tùy cấu hình) làm tròn đến **100đ**.
- Tổng hóa đơn tiền mặt: có thể làm tròn đến 500đ/1.000đ; phần chênh **ghi thành dòng "Làm tròn"** riêng (không âm thầm trừ).
- Mọi phép tính tiền chạy **ở backend** bằng số nguyên; client chỉ hiển thị (client tự tính để xem trước nhưng backend tính lại và là nguồn đúng).
- Đơn vị cân hiển thị: 3 số lẻ kg (0,845 kg) hoặc gram — thống nhất theo cấu hình.

**Lịch sử giá:** mọi thay đổi giá bán lưu `price_change_logs` (ai, khi nào, cũ → mới, lý do). Đổi giá trên POS chỉ có hiệu lực cho **giao dịch mới**, không đổi giao dịch đang mở.

### 5.5. Nhà cung cấp (Suppliers)

`suppliers`: mã, tên, loại (vườn/HTX/đầu mối/nhà nhập khẩu/đại lý), MST, địa chỉ, người liên hệ, tài khoản ngân hàng, điều khoản thanh toán (ngày công nợ), chứng nhận (VietGAP/GlobalGAP… + hạn), xếp hạng chất lượng (tính từ tỷ lệ trả hàng/hủy), danh sách SKU cung cấp + giá tham khảo + lead time.

### 5.6. Cửa hàng, kho, vị trí, thiết bị

- **`locations`** (dạng cây): Kho tổng → Khu kho lạnh / Khu kho thường / Khu chín (ripening room); Cửa hàng → Kệ trưng bày / Tủ mát / Kho phụ / Quầy sơ chế.
- **`stores`**: mã, tên, địa chỉ, tọa độ, giờ mở cửa theo ngày, ngày nghỉ, trạng thái (OPEN/PAUSED/CLOSED — tận dụng logic "store-closed gating" đã làm), bán kính giao, năng lực đơn/giờ, địa chỉ in hóa đơn, cấu hình HĐĐT, quầy.
- **`registers`** (quầy thu ngân) thuộc cửa hàng; mỗi quầy gắn thiết bị.
- **`devices`**: loại (`SCALE_COUNTER`, `SCALE_LABEL`, `SCALE_RECEIVING`, `PRINTER_RECEIPT`, `PRINTER_LABEL`, `CASH_DRAWER`, `CUSTOMER_DISPLAY`, `BARCODE_SCANNER`, `TABLET`, `POS_PC`), hãng/model, serial, kết nối (COM/USB/LAN IP/Bluetooth), tham số giao thức, **hạn kiểm định** (cân), trạng thái sức khỏe (heartbeat — tận dụng "printer health monitoring" đã làm).

### 5.7. Khách hàng

- `customers`: id, họ tên, SĐT (mã hóa + `phone_hash`), email, ngày sinh (tùy chọn, dùng cho ưu đãi sinh nhật — cần đồng ý), giới tính (tùy chọn), hạng, điểm, credit, nguồn (app/POS/B2B/giới thiệu), cửa hàng ưa thích, trạng thái (active/blocked/deleted-anonymized).
- `customer_addresses`: nhãn (Nhà/Công ty), người nhận, SĐT người nhận, địa chỉ, tọa độ, ghi chú giao (gọi trước, gửi bảo vệ…).
- `customer_preferences`: độ chín ưa thích theo loại quả, không thích (ví dụ "không lấy quả mềm"), dị ứng — **chỉ lưu nếu khách tự nhập**, đánh dấu dữ liệu nhạy cảm nếu là thông tin sức khỏe.
- `customer_notes` (chỉ Master/CS thấy): ghi chú VIP, lưu ý giao hàng — có log.
- Khách tại quầy không có tài khoản: hóa đơn gắn `customer_id = null`; tra cứu/tạo nhanh khách bằng SĐT để tích điểm.
- **Khách B2B**: `companies` (tên, MST, địa chỉ xuất hóa đơn, hạn mức công nợ, kỳ thanh toán), nhiều người dùng thuộc công ty.

### 5.8. Nhân viên

- `staff`: mã nhân viên, họ tên, SĐT, PIN (băm), vai trò + phạm vi, trạng thái, ngày vào/nghỉ.
- `staff_shifts` (lịch làm — tùy chọn bản 1.0), `attendance` (chấm công qua POS — tùy chọn).
- Nhân viên mua hàng: gắn `is_staff_purchase = true`, áp chính sách giá nhân viên; **không được tự thu ngân cho chính mình**.

---

## Phần 6. Kho, lô hàng, giá vốn, hao hụt, chế biến

### 6.1. Nguyên tắc sổ kho

1. **Sổ kho là sổ cái chỉ-thêm (append-only):** bảng `core.stock_movements`; không UPDATE/DELETE. Sai thì ghi bút toán điều chỉnh.
2. **Tồn = tổng phát sinh.** Bảng `core.stock_balances (location_id, batch_id)` là bảng tổng hợp được cập nhật trong cùng transaction (hoặc tính lại được bất cứ lúc nào từ movements).
3. **Hai đơn vị song song:** `qty_g` (gram) và `qty_units` (số quả/hộp/thùng) — với hàng PIECE_* cả hai đều có ý nghĩa; với WEIGHT chỉ gram.
4. **Mọi movement gắn lô** (`batch_id`), vị trí (`location_id`), chứng từ nguồn (`source_type`, `source_id`), người thực hiện, thời điểm, giá vốn đơn vị tại thời điểm xuất (`unit_cost_per_kg` hoặc `unit_cost_per_unit`).
5. **Tồn âm:** cấm ở kho tổng; ở cửa hàng **cho phép tạm âm** khi POS offline hoặc cân lệch (để không chặn bán), nhưng sinh cảnh báo và phải xử lý trong kiểm kê.

### 6.2. Loại phát sinh kho (`movement_type`)

| Mã | Ý nghĩa | Dấu |
|---|---|---|
| `PURCHASE_IN` | Nhận hàng từ NCC | + |
| `PURCHASE_RETURN` | Trả hàng NCC (QC không đạt) | − |
| `TRANSFER_OUT` | Xuất điều chuyển (sang vị trí "đang vận chuyển") | − |
| `TRANSFER_IN` | Nhận điều chuyển | + |
| `TRANSFER_VARIANCE` | Chênh lệch khi nhận điều chuyển | ± |
| `SALE` | Bán (POS hoặc online, khi chốt cân/giao) | − |
| `SALE_RETURN` | Khách trả hàng còn bán được (hiếm với hàng tươi) | + |
| `BOM_CONSUME` | Trừ thành phần khi bán giỏ quà/combo | − |
| `PROCESS_CONSUME` | Trừ nguyên liệu khi sơ chế | − |
| `PROCESS_OUTPUT` | Cộng thành phẩm sơ chế | + |
| `PROCESS_WASTE` | Phần bỏ đi khi sơ chế (vỏ, hạt) — theo yield | − |
| `SAMPLING` | Xuất ăn thử | − |
| `SPOILAGE` | Hủy hàng hỏng/dập (có ảnh, có duyệt) | − |
| `INTERNAL_USE` | Dùng nội bộ (trang trí, biếu) | − |
| `STOCKTAKE_ADJ` | Điều chỉnh kiểm kê (gồm hao hụt bay hơi) | ± |
| `REGRADE_OUT` / `REGRADE_IN` | Chuyển hạng (ví dụ Loại 1 → Loại 2 / hàng chế biến) | − / + |

> **Giữ hàng (reservation) không phải movement** — xem §8.4.

### 6.3. Quy trình mua hàng (Procure-to-Pay)

```
[Đề xuất đặt hàng] → [Đơn đặt NCC (PO)] → [NCC xác nhận] → [Nhận hàng + QC] → [Tạo lô] →
[Phân bổ chi phí nhập] → [Công nợ NCC] → [Thanh toán NCC] → [Chiết khấu/thưởng cuối kỳ]
```

**6.3.1. Đơn đặt hàng NCC (`purchase_orders`)**
- Trạng thái: `DRAFT → SENT → CONFIRMED → PARTIALLY_RECEIVED → RECEIVED → CLOSED` / `CANCELLED`.
- Dòng: SKU, số lượng đặt (kg hoặc thùng/quả), giá dự kiến, ngày giao dự kiến, kho nhận.
- Hàng chợ đầu mối mua tại chỗ: cho phép **nhập không cần PO** (PO tạo tự động khi nhận) — phổ biến trong ngành.

**6.3.2. Nhận hàng + QC (`goods_receipts`) — trên App Kho**

Mỗi dòng nhận:
| Bước | Dữ liệu ghi nhận |
|---|---|
| Cân | Số thùng/sọt, **tổng cả bì (gross_g)**, bì mỗi thùng (theo loại thùng cấu hình hoặc cân mẫu), **tịnh (net_g) = gross − số thùng × bì** |
| Đếm (nếu hàng quả) | Số quả, số quả/thùng; kiểm tra size bằng cân mẫu N quả → trọng lượng TB/quả |
| QC | Nhiệt độ lúc nhận (hàng lạnh), độ chín (STAGE), Brix mẫu (khúc xạ kế) — tối thiểu 3 mẫu, lưu từng giá trị + TB; tỷ lệ dập/hỏng; ảnh thùng hàng |
| Kết quả QC | Đạt toàn bộ / Đạt một phần (số lượng loại ra → `PURCHASE_RETURN` hoặc nhận hạng thấp hơn với giá khác) / Không đạt (trả toàn bộ) |
| Giá | Giá nhập theo hóa đơn NCC (đ/kg hoặc đ/thùng), số hóa đơn đầu vào, ảnh hóa đơn |
| Hạn | Ngày thu hoạch/ngày đóng gói, hạn dùng dự kiến = ngày nhận + `shelf_life_days` (sửa được) |
| Chứng từ | Giấy kiểm dịch, C/O, chứng nhận (hàng nhập khẩu) |

Kết quả: mỗi dòng đạt tạo **1 lô** (`inventory_batches`) với mã lô `B{yyMMdd}-{seq}` và in **tem lô** (QR chứa batch_id) dán lên thùng.

**6.3.3. Phân bổ chi phí nhập (Landed cost)**
- Chi phí phát sinh theo chuyến: cước xe lạnh, bốc xếp, phí cảng/kiểm dịch, phí khác.
- Phân bổ vào các lô của cùng phiếu nhận theo: **trọng lượng tịnh** (mặc định) hoặc **giá trị**, hoặc chỉ định tay.
- Chi phí đến sau khi đã nhận hàng (hóa đơn cước về muộn): vẫn phân bổ được; phần lô đã bán → ghi vào giá vốn kỳ hiện tại (`COST_ADJUSTMENT`), phần còn tồn → tăng giá vốn tồn.
- Kết quả: `batch.raw_unit_cost_per_kg` (giá hóa đơn) và `batch.landed_unit_cost_per_kg` (đã phân bổ).

**6.3.4. Công nợ & thanh toán NCC**
- `supplier_invoices`, `supplier_payments`, số dư công nợ theo NCC, tuổi nợ, nhắc hạn thanh toán.
- Thanh toán cần **2 bước** (người lập ≠ người duyệt) khi vượt hạn mức.

**6.3.5. Chiết khấu/thưởng NCC cuối kỳ (Rebate)**
- Ghi nhận khi có chứng từ (thỏa thuận/hóa đơn điều chỉnh).
- Hạch toán: **giảm giá vốn của kỳ nhận** (không quay lại sửa giá lô đã bán). Phần tương ứng hàng còn tồn có thể giảm giá vốn tồn (tùy chính sách kế toán — quyết định Q6).
- Hiển thị trong báo cáo lãi gộp như một dòng riêng "Chiết khấu NCC ghi nhận trong kỳ".

### 6.4. Trả hàng NCC

- Từ phiếu nhận (QC không đạt) hoặc phát hiện sau (trong thời hạn NCC chấp nhận).
- Bắt buộc ảnh, số lượng, lý do; trạng thái `REQUESTED → APPROVED_BY_SUPPLIER → SHIPPED_BACK → CREDITED`.
- Sinh giảm công nợ NCC khi được chấp nhận.

### 6.5. Lô hàng, FEFO & độ chín

**6.5.1. Thuộc tính lô (`inventory_batches`)**
`batch_id, sku_id, supplier_id, receipt_line_id, origin_country, origin_region, harvest_date, received_at, expiry_date, ripeness_stage, ripeness_checked_at, brix_avg, size_grade, avg_piece_weight_g, raw_unit_cost_per_kg, landed_unit_cost_per_kg, published_unit_cost_per_kg (nullable), status (ACTIVE/QUARANTINE/DEPLETED/WRITTEN_OFF), certifications[], notes`.

> Lô được tạo ở kho tổng; khi điều chuyển xuống cửa hàng **giữ nguyên batch_id** (truy xuất xuyên suốt), tồn được tách theo `location_id`.

**6.5.2. Hồ sơ độ chín (`ripeness_profiles`)**
- Áp cho từng loại quả: danh sách giai đoạn dùng được (không phải quả nào cũng có 5 giai đoạn — táo, nho, cam hầu như không "chín thêm"; xoài, bơ, chuối, sầu riêng, đu đủ, kiwi thì có).
- Mỗi giai đoạn: số ngày ước tính ở nhiệt độ thường / ở kho lạnh, giá trị hiển thị cho khách, mức markdown gợi ý.

| Giai đoạn | Mã | Ý nghĩa | Hành động hệ thống |
|---|---|---|---|
| 1 | `S1_UNRIPE` | Xanh/cứng | Bán cho khách chọn "để vài ngày"/"cúng"; ưu tiên lưu kho |
| 2 | `S2_READY` | Chín tới | Bán giá niêm yết |
| 3 | `S3_PEAK` | Chín đậm, ngon nhất | Ưu tiên phân bổ cho đơn "ăn ngay hôm nay"; gợi ý đẩy lên banner "Ăn ngon hôm nay" |
| 4 | `S4_MARKDOWN` | Cận hạn | Kích hoạt **đề xuất** markdown (cần duyệt nếu vượt hạn mức — §6.9) hoặc chuyển sơ chế/ép |
| 5 | `S5_SPOILED` | Hỏng | Chỉ được tạo phiếu hủy; chặn bán |

**6.5.3. Kiểm tra độ chín hằng ngày (QC Task)**
- Mỗi sáng worker sinh **danh sách lô cần kiểm tra** cho từng cửa hàng/kho (lô có profile độ chín, lô gần hạn, lô đến ngày dự kiến chuyển giai đoạn).
- Nhân viên mở POS tablet → từng lô: xác nhận giai đoạn (giữ/chuyển), chụp ảnh nếu chuyển S4/S5, ghi tỷ lệ % lô ở mỗi giai đoạn nếu lô không đồng đều → hệ thống có thể **tách lô** (split batch) thành 2 lô con cùng giá vốn.
- Lô không được kiểm tra quá 48 giờ → cảnh báo cửa hàng trưởng.

**6.5.4. FEFO khi xuất**
- Khi bán/soạn đơn: hệ thống **gợi ý** lô theo thứ tự (1) phù hợp tùy chọn độ chín khách chọn, (2) hạn sớm nhất, (3) nhập sớm nhất.
- Bán tại quầy theo kg: thu ngân không chọn lô → hệ thống **tự phân bổ FEFO** trong các lô đang ở vị trí bán của cửa hàng; nếu cân bằng tem lô (QR) thì dùng đúng lô đó.
- Soạn đơn online: picker **quét QR tem lô** hoặc chọn lô trong danh sách gợi ý; nếu lấy lô khác gợi ý → ghi nhận (để phân tích), không chặn.

### 6.6. Giá vốn (Costing)

**Phương pháp: giá vốn đích danh theo lô (specific identification)** — mỗi lô có giá/kg riêng, xuất từ lô nào lấy giá lô đó.

| Khái niệm | Công thức |
|---|---|
| Giá vốn hàng bán (COGS) dòng | `weight_g × landed_unit_cost_per_kg / 1000` (hoặc `units × cost_per_unit`) theo lô đã xuất |
| Giá vốn giỏ quà | Tổng giá vốn các thành phần thực tế đã trừ + bao bì |
| Hao hụt trong định mức | Giá vốn phần hao hụt kiểm kê ≤ `shrink_norm_pct` → **chi phí hao hụt định mức** (báo cáo riêng, coi là chi phí bình thường) |
| Hao hụt ngoài định mức | Phần vượt → **tổn thất bất thường**, bắt buộc giải trình (cửa hàng trưởng), có thể quy trách nhiệm |
| Hủy hàng | Giá vốn phần hủy → **chi phí hủy hàng** (theo lý do: dập do vận chuyển / quá hạn / lỗi NCC (đòi được) / khác) |
| Ăn thử | Giá vốn → **chi phí marketing** |
| **Giá vốn hiệu dụng** (báo cáo quản trị) | `(COGS + hao hụt + hủy + ăn thử − rebate) / doanh thu thuần` |

> Không dùng bình quân gia quyền vì giá nhập hoa quả biến động mạnh theo chuyến; giá đích danh cho biết chính xác lô nào lời/lỗ.

### 6.7. Hao hụt tự nhiên & tồn khả dụng (sửa lỗi S3)

**Không tự trừ kho theo % hằng ngày.** Thay vào đó:

1. **ATP (tồn khả dụng nhận đơn online):**
   `ATP_g = Σ(on_hand_g của lô bán được ở cửa hàng) × (1 − safety_pct_sku) − reserved_g`
   - `safety_pct_sku` mặc định = `shrink_norm_pct` × số ngày từ lần kiểm kê gần nhất / 7, giới hạn trên (ví dụ 10%).
   - Với hàng PIECE_*: ATP theo **số quả**, trừ hao ở mức quả (ví dụ dự phòng 1 quả/lô).
   - App Khách chỉ hiển thị "Còn hàng / Sắp hết / Hết", không hiện số tồn thật.
2. **Kiểm kê định kỳ** (§6.11) ghi nhận số thực → phần chênh âm tự phân loại:
   - Trong định mức → `STOCKTAKE_ADJ` loại `NATURAL_SHRINK`, tự duyệt.
   - Vượt định mức → cần giải trình + duyệt theo hạn mức §3.4.
3. **Định mức hao hụt** cấu hình theo SKU (ví dụ mức tham khảo: nho, cherry, dâu cao; táo, cam thấp) và **tự hiệu chỉnh gợi ý** từ dữ liệu kiểm kê 8 tuần gần nhất (hiển thị cho Master Admin quyết định, không tự đổi).

### 6.8. Điều chuyển kho

```
[Yêu cầu bổ sung (cửa hàng tạo hoặc hệ thống đề xuất)] → [Kho tổng duyệt & soạn] →
[Xuất: TRANSFER_OUT → vị trí IN_TRANSIT] → [Xe lạnh vận chuyển] →
[Cửa hàng nhận: cân lại, đếm lại, ảnh] → [TRANSFER_IN + TRANSFER_VARIANCE nếu lệch]
```
- Phiếu điều chuyển: `DRAFT → APPROVED → PICKING → IN_TRANSIT → RECEIVED → CLOSED` / `CANCELLED`.
- Chênh lệch khi nhận > ngưỡng (ví dụ 1% hoặc 200 g) → bắt buộc ảnh + lý do; cả 2 bên thấy; OPS_MANAGER xử lý.
- Ghi nhiệt độ lúc xuất/nhận với hàng lạnh.
- Giá vốn đi theo lô, **không cộng thêm** chi phí vận chuyển nội bộ vào lô (mặc định) — chi phí xe nội bộ hạch toán chi phí vận hành; tùy chọn phân bổ nếu chủ muốn (Q6).

### 6.9. Markdown (giảm giá cận hạn) có kiểm soát (sửa lỗi S5)

**Rule engine `markdown_rules`:**
| Trường | Ví dụ |
|---|---|
| Điều kiện | Lô ở `S4_MARKDOWN`, hoặc còn ≤ N ngày đến hạn, hoặc tồn > X ngày bán |
| Mức giảm đề xuất | 15% / 25% / 35% theo bậc |
| Giá sàn | Không thấp hơn `landed_cost × (1 − max_loss_pct)`; hoặc tối thiểu bằng giá trị thu hồi nếu chuyển ép nước |
| Kênh áp dụng | POS (tem giảm giá), App (mục "Giá tốt hôm nay"), cả hai |
| Thời hạn | Đến hết ngày / đến khi hết lô |
| Duyệt | ≤ 20%: cửa hàng trưởng; > 20%: OPS/Master; dưới giá vốn: chỉ Master |

**Luồng:** worker đề xuất mỗi sáng → cửa hàng trưởng duyệt trên tablet (1 chạm/lô) → in **tem giảm giá** (mã vạch mới hoặc tem phụ) → App cập nhật giá cho lô đó → khi bán, hệ thống chỉ áp giá markdown nếu xuất **đúng lô** đó.

**Chống lạm dụng:** nhân viên không được mua hàng markdown trong ca làm; báo cáo tỷ lệ markdown theo cửa hàng/nhân viên duyệt.

**So sánh phương án xử lý lô cận hạn** — hệ thống hiển thị cho cửa hàng trưởng:
| Phương án | Giá trị thu hồi ước tính |
|---|---|
| Markdown 25% bán nguyên quả | `remain_g × giá × 0.75 × tỷ lệ bán được ước tính` |
| Chuyển khay cắt sẵn | `remain_g × yield × giá khay/kg` − chi phí khay/nhân công |
| Chuyển ép nước | `remain_g × yield_juice × giá/ml` |
| Hủy | 0 |

### 6.10. Đề xuất đặt hàng / bổ sung (Reorder)

- Hằng ngày (tối) tính cho mỗi cặp (cửa hàng, SKU):
  `đề xuất_g = dự báo_bán/ngày × (lead_time_ngày + số_ngày_phủ) − on_hand_g − đang_về_g`
  - `dự báo_bán/ngày` = trung bình động có trọng số 14 ngày, nhân hệ số ngày trong tuần, hệ số sự kiện (Tết, rằm, mùng 1 — **lịch âm** rất quan trọng với hoa quả cúng).
  - Giới hạn bởi hạn dùng: `số_ngày_phủ ≤ shelf_life_days − ngày_an_toàn`.
- Tổng hợp cửa hàng → đề xuất điều chuyển từ kho tổng; tổng hợp kho tổng → đề xuất PO NCC.
- Người dùng sửa/duyệt; hệ thống ghi lại đề xuất vs thực đặt để cải thiện.

### 6.11. Kiểm kê (Stocktake)

| Loại | Khi nào | Phạm vi |
|---|---|---|
| Kiểm nhanh cuối ca | Mỗi ca | Danh sách hàng giá trị cao (`is_high_value`) — mặc định 10 mã |
| Kiểm chu kỳ | Hằng ngày | Hệ thống chọn 15–20% SKU xoay vòng sao cho mỗi SKU được kiểm ≥ 2 lần/tuần |
| Kiểm toàn bộ | Cuối tuần/tháng | Toàn cửa hàng/kho |

- **Đếm mù:** màn hình kiểm không hiển thị số tồn hệ thống.
- Cân theo lô (quét QR tem lô) hoặc theo SKU (hệ thống phân bổ chênh lệch về các lô theo FEFO ngược — lô cũ nhất chịu hao trước).
- Trong lúc kiểm, bán hàng vẫn diễn ra: kiểm kê lưu **thời điểm chốt số** từng dòng; các phát sinh sau thời điểm đó không bị tính vào chênh lệch.
- Kết quả: phiếu kiểm kê → chênh lệch → phân loại (§6.7) → duyệt → `STOCKTAKE_ADJ`.

### 6.12. Sơ chế & chế biến (Processing)

**`processing_recipes`**: thành phẩm (SKU khay/ly), nguyên liệu (SKU + lượng chuẩn), **yield chuẩn** (%), bao bì (khay, màng, nhãn), thời gian, hạn dùng thành phẩm (thường tính bằng giờ: 12–24h, bảo quản lạnh).

**Phiếu sơ chế (`processing_orders`)**:
1. Chọn công thức, số lượng thành phẩm dự kiến.
2. **Cân nguyên liệu thực tế** (chọn lô, FEFO gợi ý lô S3/S4) → `PROCESS_CONSUME`.
3. Cân/đếm thành phẩm thực tế → `PROCESS_OUTPUT` (mỗi khay có thể dán tem cân `PACK_VARIABLE`).
4. Phần bỏ đi = nguyên liệu − thành phẩm − phần hao → `PROCESS_WASTE`.
5. Yield thực tế so với chuẩn; lệch > ngưỡng → cảnh báo.
6. **Giá vốn thành phẩm** = giá vốn nguyên liệu + bao bì (+ nhân công nếu cấu hình) / số thành phẩm.
7. Thành phẩm tạo **lô mới** (lô con), lưu `parent_batch_ids[]` để truy xuất.

**Sơ chế theo đơn** (khách chọn "gọt sẵn" trên app): không cần phiếu riêng, picker thao tác trong luồng soạn đơn; hệ thống ghi dòng `PREP` + trọng lượng trước gọt.

### 6.13. Giỏ quà & combo (BOM)

**`bom_templates`**: SKU giỏ, danh sách thành phần (SKU hoặc **nhóm thay thế**), số lượng/khối lượng chuẩn, bao bì & phụ kiện (giỏ mây, nơ, màng co, thiệp), **ngân sách giá vốn mục tiêu** và **dung sai** (ví dụ ±5%).

**Khi bán giỏ có sẵn trên kệ (đã đóng sẵn):**
- Giỏ được đóng trước bằng **phiếu lắp ráp** (giống phiếu sơ chế): trừ thành phần → cộng 1 giỏ (lô giỏ) có giá vốn thực.
- Bán giỏ → trừ 1 giỏ (không trừ lại thành phần).

**Khi bán giỏ làm theo đơn:**
- Nhân viên chọn thành phần thực tế; hệ thống tính giá vốn thực; nếu lệch ngân sách quá dung sai → cảnh báo, cần cửa hàng trưởng xác nhận.
- **Thay thế thành phần**: chỉ chọn trong nhóm thay thế đã định nghĩa (Táo Envy size 24 ↔ Táo Dazzle size 24…), hoặc tự do nếu có quyền; ghi lại thay thế.

**Giỏ quà tùy chỉnh theo ngân sách (App Khách):** xem §9.5.


---

## Phần 7. Phần mềm bán hàng tại cửa hàng (POS)

### 7.1. Mục tiêu hiệu năng

| Chỉ số | Mục tiêu |
|---|---|
| Thời gian thêm 1 dòng hàng cân (đặt lên cân → bấm phím SP) | ≤ 1,5 giây |
| Thời gian quét 1 tem cân | ≤ 0,5 giây |
| Thanh toán tiền mặt cho giỏ 5 món | ≤ 20 giây tổng giao dịch |
| VietQR: từ lúc khách chuyển đến lúc POS báo thành công | thường 3–10 giây (phụ thuộc ngân hàng & cổng) — hiển thị trạng thái chờ rõ ràng |
| Mở POS khi mất mạng | Bán được ngay, không chờ |

### 7.2. Vòng đời ca & ngày

```
[Mở cửa hàng] → [Mở ca: nhân viên + quầy + tiền đầu ca (đếm theo mệnh giá)] →
[Bán hàng / nhận đơn / thu chi] → [Đóng ca: đếm mù tiền mặt + kiểm nhanh hàng giá trị cao] →
[Báo cáo ca (X-report)] → [Bàn giao] → … → [Đóng ngày: Z-report, chốt doanh thu ngày] → [Đóng cửa hàng]
```

| Mã | Yêu cầu |
|---|---|
| P1 | Không bán được khi chưa mở ca. Mỗi quầy chỉ có 1 ca đang mở |
| P2 | Tiền đầu ca nhập theo **mệnh giá** (500.000 × n, 200.000 × n…) để giảm sai |
| P3 | **Đóng ca đếm mù**: nhập số đếm trước; sau khi xác nhận mới hiện số lý thuyết và chênh lệch. Không cho nhập lại sau khi đã xem |
| P4 | Chênh lệch tiền mặt > ngưỡng (ví dụ 20.000đ) → bắt buộc ghi lý do; cửa hàng trưởng xác nhận |
| P5 | X-report (giữa ca, xem được nhiều lần) và Z-report (chốt, 1 lần, bất biến) gồm: doanh thu theo phương thức TT, số hóa đơn, số dòng xóa, số hóa đơn hủy, giảm giá tay, hoàn tiền, thu/chi ngoài bán hàng, mở két không bán, chênh lệch |
| P6 | Đổi ca giữa chừng: đóng ca người cũ → mở ca người mới (không dùng chung ca) |

### 7.3. Luồng bán hàng tại quầy

```
1. (Tùy chọn) Nhập SĐT khách → tra hạng, điểm, voucher khả dụng
2. Thêm hàng:
   a. Hàng cân: đặt lên cân → chọn SP (phím tắt/ tìm / quét PLU) → dòng tự lấy số cân ổn định
   b. Tem cân in sẵn: quét mã EAN-13 nhúng trọng lượng → tách PLU + gram
   c. Hàng mã vạch thường / hàng theo quả: quét / chọn + số lượng
   d. Giỏ quà, combo: chọn → (nếu làm theo đơn) chọn thành phần
3. Áp khuyến mãi tự động (theo rule) + voucher khách (nếu có)
4. Chọn phương thức thanh toán (có thể chia nhiều phương thức)
5. Chốt: ghi hóa đơn (transaction) → trừ kho → outbox → in phiếu → mở két (nếu tiền mặt) → yêu cầu HĐĐT
```

**Quy tắc đọc cân:**
- Chỉ nhận giá trị khi cân báo **ổn định** (stable flag) và > 0.
- Nếu SKU có bì mặc định và thu ngân chọn "có bao bì" → trừ bì; hoặc cân đã **tare** sẵn (nút trên cân) → không trừ thêm (cấu hình theo quầy để không trừ 2 lần).
- Cảnh báo khi trọng lượng ngoài khoảng `weight_min_g..weight_max_g` × số quả (dấu hiệu chọn nhầm SP).
- Mỗi dòng cân lưu `scale_device_id`, `raw_reading`, `stable_at`.

### 7.4. Cân lỗi & nhập cân tay (sửa lỗi S16)

- Mất kết nối cân → POS hiển thị đỏ "Cân mất kết nối"; nút **"Nhập cân tay"** yêu cầu PIN cửa hàng trưởng + lý do (danh sách chọn) + ảnh màn hình cân (tùy chọn).
- Dòng nhập tay đánh dấu `weight_source = MANUAL`; báo cáo riêng số dòng/giá trị nhập tay theo thu ngân/ca → Master Admin theo dõi bất thường.

### 7.5. Mã vạch cân (EAN-13 nhúng trọng lượng/giá)

- **Định dạng cấu hình được** theo từng cân in tem (vì mỗi hãng cân có thể cài khác):

| Mẫu | Cấu trúc 13 ký tự | Ý nghĩa |
|---|---|---|
| W1 (mặc định, như bản v1) | `2F PPPPP WWWWW C` với F=0 | 2 số đầu `20`, 5 số PLU, 5 số trọng lượng (gram), 1 số kiểm |
| W2 | `2F PPPPP $$$$$ C` | 5 số **giá tiền** (đồng hoặc nghìn đồng) thay cho trọng lượng |
| W3 | `2F PPPP WWWWWW C` | PLU 4 số, trọng lượng 6 số |

- Bộ giải mã: kiểm tra độ dài, tiền tố 20–29, **checksum EAN-13** (Phụ lục B), tra PLU → SKU, tính tiền **theo đơn giá hiện hành trên POS** (W1) hoặc theo giá trên tem (W2 — phải đối chiếu đơn giá để phát hiện tem cũ/giá sai).
- Tem cân có thể bị in lại cho hàng cũ → khuyến nghị cấu hình cân in thêm **ngày đóng gói** trên tem (đọc bằng mắt) và POS cảnh báo nếu cùng một mã tem được quét 2 lần trong ngày.

### 7.6. Thanh toán tại quầy

| Phương thức | Chi tiết |
|---|---|
| Tiền mặt | Nhập số khách đưa → tính tiền thối; gợi ý mệnh giá; mở két (ESC/POS kick) |
| **VietQR động** | Backend tạo yêu cầu thanh toán qua cổng (SePay/payOS…) với **mã thanh toán duy nhất** + số tiền chính xác → hiển thị QR trên **màn hình phụ hướng khách** và in trên phiếu tạm tính → chờ webhook → POS báo thành công (âm báo) |
| Thẻ ngân hàng (POS ngân hàng rời) | Thu ngân nhập mã chuẩn chi/4 số cuối để đối soát; tích hợp máy POS ngân hàng để sau |
| Credit cửa hàng / điểm | Trừ theo quy tắc §9.6 |
| Voucher giấy/điện tử | Quét mã |
| Chia nhiều phương thức | Ví dụ 200.000 credit + phần còn lại VietQR |

**VietQR — xử lý ngoại lệ:**
| Tình huống | Xử lý |
|---|---|
| Khách chuyển **thiếu** tiền | Đơn ở trạng thái `PARTIALLY_PAID`; POS hiển thị số còn thiếu, cho thanh toán phần còn lại bằng phương thức khác |
| Khách chuyển **thừa** | Ghi nhận thừa → hoàn credit hoặc trả tiền mặt (có phiếu chi) |
| Chuyển **sai nội dung** (không có mã thanh toán) | Giao dịch vào hàng "chưa khớp"; thu ngân/kế toán **khớp tay** với hóa đơn (tìm theo số tiền + thời gian) — có log |
| Webhook đến muộn sau khi khách đã đi | Hóa đơn vẫn tự cập nhật; nếu thu ngân đã chuyển phương thức khác → giao dịch thành "thừa", xử lý hoàn |
| Mất mạng | Không xác minh được VietQR → POS đề nghị phương thức khác; nếu thu ngân xác nhận "khách đã chuyển" bằng mắt → đánh dấu `PENDING_VERIFICATION` (cần cửa hàng trưởng), đối soát khi có mạng |
| Webhook giả mạo | Xác thực chữ ký/API key + đối chiếu qua API tra cứu giao dịch của cổng trước khi chốt (§13.4) |

### 7.7. Hủy, sửa, trả hàng

| Thao tác | Điều kiện | Log |
|---|---|---|
| Xóa dòng chưa thanh toán | Thu ngân tự làm | Ghi `void_line` (SP, cân, giá, thời điểm) — **đặc biệt chú ý dòng đã cân rồi xóa** |
| Hủy cả giỏ chưa thanh toán | Thu ngân tự làm | Ghi `void_cart` |
| Hủy hóa đơn đã thanh toán | Theo hạn mức §3.4, trong ngày; sau ngày → chứng từ trả hàng | Ghi + HĐĐT hủy/điều chỉnh |
| Trả hàng/hoàn tiền | Có hóa đơn gốc; chọn dòng & số lượng/cân trả; hàng tươi trả lại thường **không nhập lại kho bán** → ghi `SPOILAGE` hoặc `REGRADE` | Ghi + HĐĐT điều chỉnh |
| Mở két không bán | PIN cửa hàng trưởng + lý do | Ghi |
| Treo hóa đơn (hold) | Khách quay lại chọn thêm | Hóa đơn treo tự hủy sau N giờ, có log |

### 7.8. In ấn

**Máy in hóa đơn nhiệt 80 mm (KiotViet KV804 hoặc bất kỳ máy ESC/POS):**
- Kết nối USB (driver/raw) hoặc LAN (TCP 9100).
- **Kiểm tra thực tế trên đúng model**: font tiếng Việt (in raster ảnh nếu máy không có code page tiếng Việt đầy đủ), lệnh QR native `GS ( k` (nếu không hỗ trợ → in QR dạng ảnh raster `GS v 0`), cắt giấy, mở két.
- Bố cục phiếu:
```
[Logo]  TÊN CỬA HÀNG — địa chỉ — hotline
PHIẾU TẠM TÍNH / HÓA ĐƠN BÁN HÀNG     Số: CH01-251117-0042
Ngày giờ · Thu ngân · Quầy · Khách (che SĐT)
------------------------------------------------
Nho Mẫu Đơn (chín vừa)
   0,845 kg × 320.000đ/kg            270.400
Dưa lưới Hoàng Kim (1 quả)
   1,920 kg × 95.000đ/kg             182.400
Giỏ quà Phú Quý                    1.200.000
   (Cherry 0,5kg; Táo Envy ×3; ...)
------------------------------------------------
Tạm tính                           1.652.800
Giảm hạng Vàng (3%)                  -49.584
Làm tròn                                -216
TỔNG THANH TOÁN                    1.603.000
Tiền mặt / VietQR / Credit ...
------------------------------------------------
[QR VietQR — chỉ trên phiếu tạm tính]
[QR tra cứu HĐĐT — trên hóa đơn]
Điểm tích lũy: +1.603 · Tổng điểm: 12.450
Bảo hành tươi ngon 24h — xem điều kiện trong app
```
- **Máy in tem** (cân in tem hoặc máy in tem riêng 40×30 mm): tem lô kho (QR batch), tem khay sơ chế (tên, cân, giá, giờ làm, hạn dùng theo giờ), tem markdown, tem dán túi giao hàng (mã đơn, khung giờ, tên người nhận rút gọn, QR đơn).

### 7.9. Màn hình phụ hướng khách

- Hiển thị dòng hàng vừa thêm (tên, **số cân, đơn giá/kg, thành tiền**) — tăng minh bạch, giảm tranh cãi cân.
- Hiển thị QR thanh toán, số tiền, trạng thái "Đã nhận tiền".
- Lúc rảnh: banner khuyến mãi, hàng "Ăn ngon hôm nay".

### 7.10. Thu chi & sổ quỹ cửa hàng

- Phiếu thu ngoài bán hàng (thu nợ B2B, thu COD shipper nộp lại), phiếu chi (mua đá lạnh, túi, chi lặt vặt) — có danh mục, ảnh chứng từ, duyệt theo hạn mức.
- Nộp tiền về công ty/ngân hàng: phiếu nộp, người nhận xác nhận.
- Số dư quỹ tiền mặt theo cửa hàng theo thời gian thực.

### 7.11. Chế độ offline

| Chức năng | Offline được? | Ghi chú |
|---|---|---|
| Bán hàng tiền mặt | Có | Lưu SQLite, đánh số hóa đơn offline riêng (`CH01-R2-OFF-000123`) |
| Đọc cân, in phiếu, mở két | Có | Thiết bị cục bộ |
| Tra giá, danh mục | Có | Đồng bộ trước về máy; giá có hiệu lực theo thời điểm |
| Áp khuyến mãi | Có, với rule đã tải | Rule phụ thuộc giới hạn toàn chuỗi (ví dụ "100 suất đầu tiên") → **tắt khi offline** |
| Tra khách/điểm | Chỉ đọc bản cache | Trừ điểm/credit **không cho** khi offline (tránh tiêu 2 lần) |
| VietQR | Không xác minh được | Xem §7.6 |
| Nhận đơn online | Không | Cửa hàng tự động chuyển `PAUSED` cho kênh online nếu POS mất kết nối > 2 phút |
| HĐĐT | Xếp hàng gửi sau | Theo quy định thời hạn gửi dữ liệu — cảnh báo nếu offline lâu |

**Đồng bộ khi có mạng lại:**
- Mỗi giao dịch có `client_txn_id` (UUID v7) → backend **idempotent** (gửi lại không tạo trùng).
- Thứ tự: mở ca → hóa đơn → thu chi → đóng ca.
- Tồn kho có thể âm sau đồng bộ → cảnh báo, không chặn.
- Xung đột giá (giá đổi trong lúc offline): **giữ giá đã bán** cho khách, ghi chênh lệch vào báo cáo.
- Giới hạn offline tối đa (ví dụ 24 giờ) → quá hạn POS buộc phải đồng bộ mới bán tiếp (để đảm bảo HĐĐT).

### 7.12. Phần cứng & tích hợp cục bộ

| Thiết bị | Giao tiếp | Ghi chú triển khai |
|---|---|---|
| Cân quầy | RS232 (qua USB-Serial) hoặc USB HID; giao thức theo hãng (chuỗi ASCII liên tục hoặc hỏi–đáp) | Viết **adapter theo hãng** (driver interface `ScaleAdapter { connect, readStable(), tare() }`); cấu hình baudrate, parity, định dạng chuỗi; có màn hình **"Kiểm tra cân"** hiển thị raw data |
| Cân in tem | Mạng LAN/RS232; nạp PLU từ phần mềm của hãng hoặc qua giao thức | Bản 1.0: **xuất file PLU** (CSV theo mẫu hãng) để nạp; đồng bộ tự động để sau |
| Máy in nhiệt | USB / LAN 9100 | ESC/POS; hàng đợi in, in lại, báo lỗi hết giấy/mở nắp |
| Két tiền | RJ11 qua máy in | Lệnh kick `ESC p` |
| Máy quét mã vạch | USB HID (giả lập bàn phím) | Bắt luồng phím nhanh kết thúc bằng Enter |
| Màn hình phụ | HDMI thứ 2 | Cửa sổ Flutter thứ 2 |
| Webcam/ tablet camera | USB/ tích hợp | Chụp ảnh cân, ảnh đóng gói |

Heartbeat thiết bị → `devices.last_seen_at`, trạng thái gửi về admin.

---

## Phần 8. Đơn online, Catch-Weight, fulfillment & giao vận

### 8.1. Loại đơn

| Loại | Mô tả |
|---|---|
| `DELIVERY_ASAP` | Giao nhanh trong khung 60–120 phút |
| `DELIVERY_SCHEDULED` | Giao theo khung giờ khách chọn (hôm nay/ngày mai…) |
| `PICKUP` | Khách đặt trước, đến cửa hàng lấy |
| `GIFT` | Giỏ quà, người nhận khác người đặt, có thiệp, có duyệt ảnh |
| `B2B` | Đơn doanh nghiệp (§8.11) |
| `PREORDER` | Đặt trước theo mùa/sự kiện (§8.12) |

### 8.2. Máy trạng thái đơn hàng

```
                 ┌──────────────► CANCELLED (khách/cửa hàng/hệ thống, có lý do)
                 │
 PLACED ──► ACCEPTED ──► PICKING ──► WEIGHED ──┬──► AWAITING_CUSTOMER_CONFIRM ──┐
   │  (thanh toán trước:                       │      (chênh lệch vượt ngưỡng,   │
   │   PENDING_PAYMENT → PLACED)               │       thay thế hàng, hết hàng)  │
   │                                           ▼                                 ▼
   │                                  AWAITING_FINAL_PAYMENT ◄───────── (khách đồng ý)
   │                                     (chế độ trả sau cân)
   │                                           │
   │                                           ▼
   │                                        PACKED ──► READY_FOR_PICKUP (đơn PICKUP) ──► PICKED_UP ─┐
   │                                           │                                                    │
   │                                           ▼                                                    │
   │                                  ASSIGNING_SHIPPER ──► SHIPPER_ASSIGNED ──► DELIVERING ──► DELIVERED
   │                                                                                │               │
   │                                                                                ▼               ▼
   │                                                                      DELIVERY_FAILED    COMPLETED
   │                                                                     (giao lại/trả về)  (hết hạn bảo hành 24h)
   ▼
 REJECTED (cửa hàng từ chối → hệ thống phân lại cửa hàng khác)
```

| Trạng thái | Ai chuyển | Điều kiện / tác động |
|---|---|---|
| `PENDING_PAYMENT` | Hệ thống | Đơn trả trước, chờ webhook; hết hạn 15 phút → `CANCELLED`, nhả hàng giữ |
| `PLACED` | Hệ thống | Đã giữ hàng (reservation), đã phân cửa hàng, chuông báo |
| `ACCEPTED` | Picker/STORE_MGR | Bấm "Nhận xử lý"; ghi thời gian phản hồi |
| `REJECTED` | Picker/STORE_MGR | Lý do (hết hàng, quá tải) → phân lại |
| `PICKING` | Picker | Bắt đầu nhặt |
| `WEIGHED` | Picker | Đã cân hết dòng, có ảnh; hệ thống tính `actual_total` |
| `AWAITING_CUSTOMER_CONFIRM` | Hệ thống | Khi chênh lệch vượt ngưỡng hoặc có thay thế/thiếu hàng — gửi push; hết thời gian chờ (ví dụ 10 phút) → áp **lựa chọn mặc định khách đã chọn lúc đặt** |
| `AWAITING_FINAL_PAYMENT` | Hệ thống | Chế độ "trả sau khi cân": chờ khách quét VietQR số tiền thực |
| `PACKED` | Picker | In tem túi, chụp ảnh đóng gói |
| `ASSIGNING_SHIPPER` / `SHIPPER_ASSIGNED` | Hệ thống/STORE_MGR | Shipper nội bộ hoặc 3PL |
| `DELIVERING` | Shipper/3PL webhook | Theo dõi vị trí |
| `DELIVERED` | Shipper/3PL | Ảnh giao hàng, thu COD (nếu có) → **xuất HĐĐT**, trừ kho (nếu chưa), cộng điểm |
| `DELIVERY_FAILED` | Shipper/3PL | Lý do; lựa chọn giao lại/hủy & nhập lại kho (hàng còn tốt) hoặc hủy hàng |
| `COMPLETED` | Hệ thống | Sau 24h không có khiếu nại bảo hành |
| `CANCELLED` | Khách (trước `PICKING`), cửa hàng/CS (lý do), hệ thống | Nhả hàng giữ, hoàn tiền (nếu đã trả) |

> **Khi nào trừ kho đơn online?** Tại `PACKED` (hàng đã rời kệ). Nếu `DELIVERY_FAILED` và hàng còn tốt → nhập lại (`SALE_RETURN`). Giữ hàng (reservation) được nhả khi trừ kho thật.

### 8.3. Phân bổ đơn về cửa hàng

**Bước 1 — lọc ứng viên:** cửa hàng `OPEN` cho kênh online, trong giờ hoạt động, địa chỉ giao nằm trong vùng phục vụ, POS đang online, chưa vượt năng lực khung giờ.

**Bước 2 — kiểm tra đủ hàng:** ATP của cửa hàng đủ cho **tất cả** dòng (kể cả yêu cầu độ chín — cần có lô ở giai đoạn phù hợp).

**Bước 3 — chấm điểm:**
`score = w1 × (1 − khoảng_cách_đường/max) + w2 × (1 − tải_hiện_tại/năng_lực) + w3 × (đủ hàng 100% ? 1 : 0) + w4 × (là cửa hàng ưa thích của khách ? 1 : 0)`

**Bước 4 — không có cửa hàng nào đủ hàng:**
- Gợi ý khách: (a) giao từ cửa hàng xa hơn (phí cao hơn), (b) bỏ món thiếu, (c) chuyển sang giao theo lịch (để điều chuyển kịp), (d) **tách đơn** (để sau — phức tạp).

**Khoảng cách:** dùng **khoảng cách đường đi** từ API bản đồ (Goong/Google/OSRM tự host) thay vì đường chim bay (Haversine) — ở TP.HCM, Haversine thường thấp hơn nhiều so với quãng đường thực (sông, cầu, đường một chiều) dẫn đến tính phí ship thấp. Haversine chỉ dùng **lọc sơ bộ**, cache kết quả theo cặp (cửa hàng, ô lưới địa chỉ).

### 8.4. Giữ hàng (Reservation)

- `inventory_reservations(order_line_id, store_id, sku_id, reserved_g, reserved_units, expires_at, status)`.
- Giữ theo **trọng lượng tạm tính × hệ số dư** (ví dụ 1,1) để tránh thiếu khi cân thực.
- Hết hạn tự động nếu đơn không chuyển trạng thái (ví dụ đơn chờ thanh toán 15 phút).
- ATP trừ phần đã giữ.

### 8.5. Catch-Weight: tạm tính, chốt cân, thanh toán

**8.5.1. Tạm tính lúc đặt**
- Dòng PIECE_BY_WEIGHT: `est_weight_g = qty × std_weight_g`; `est_amount = round(price_per_kg × est_weight_g / 1000)`.
- Dòng WEIGHT: khách chọn khối lượng (ví dụ 1 kg) → `est_weight_g = 1000`.
- App hiển thị rõ: **"Giá tạm tính. Số tiền cuối cùng theo cân thực tế, chênh lệch thường trong khoảng ±X%."**

**8.5.2. Chốt cân lúc soạn**
- Picker cân từng dòng → `actual_weight_g`, ảnh hàng trên cân (thấy rõ số cân), `actual_amount`.
- `variance_pct = (actual_weight_g − est_weight_g) / est_weight_g`.

**8.5.3. Ba chế độ thanh toán — cấu hình theo SKU/giá trị đơn:**

| Chế độ | Khi nào | Luồng |
|---|---|---|
| **M1. Trả trước theo tạm tính, điều chỉnh sau** | Mặc định cho đơn thường | Khách trả `est_total`. Sau cân: nếu thiếu (hàng nhẹ hơn) → hoàn phần chênh dưới dạng **credit** (hoặc về tài khoản nếu khách chọn); nếu thừa (hàng nặng hơn) và trong ngưỡng dung sai → **cửa hàng chịu** (không thu thêm); vượt ngưỡng → `AWAITING_CUSTOMER_CONFIRM`: khách chọn trả thêm (VietQR) / đổi quả nhỏ hơn / bỏ bớt |
| **M2. Trả sau khi cân** | Hàng giá trị cao (sầu riêng, cherry, nho Mẫu Đơn), đơn lớn | Đơn ở `AWAITING_FINAL_PAYMENT` sau cân → push kèm ảnh cân + số tiền chính xác + **VietQR đúng số tiền** → khách trả → `PACKED` |
| **M3. COD** | Khách chọn | Thu đúng `actual_total` khi giao; phiếu in trên túi ghi số tiền thực |

**Tham số dung sai (`catch_weight_policies`):**
| Tham số | Ví dụ mặc định |
|---|---|
| `absorb_over_pct` — cửa hàng chịu khi nặng hơn tối đa | 3% (và ≤ 20.000đ/đơn) |
| `refund_under` — luôn hoàn khi nhẹ hơn | Có (minh bạch) |
| `confirm_threshold_pct` | > 5% hoặc > 50.000đ |
| `confirm_timeout_min` | 10 phút |
| `default_action_on_timeout` | Theo lựa chọn khách lúc đặt: "Cứ giao, tôi trả thêm" / "Chỉ giao trong ngân sách" / "Gọi cho tôi" |

> Bản v1 đề xuất "hấp thụ vào quỹ khuyến mãi" — v2 giữ ý này qua `absorb_over_pct`, và **ghi nhận phần cửa hàng chịu thành chi phí khuyến mãi riêng** (`catch_weight_absorb_amount`) để Master Admin thấy mỗi tháng mất bao nhiêu.

**8.5.4. Hóa đơn:** luôn theo `actual_*` (§2.1 L1.6).

### 8.6. Thay thế hàng & hết hàng

- Lúc đặt, mỗi dòng khách chọn: **"Cho phép thay thế tương đương"** / **"Gọi tôi trước"** / **"Bỏ món nếu hết"**.
- Picker khi hết: hệ thống gợi ý SKU trong `substitute_skus` → nếu khách cho phép và chênh giá ≤ ngưỡng → thay ngay, thông báo khách; ngược lại → `AWAITING_CUSTOMER_CONFIRM`.
- Ghi `order_line_substitutions` (SKU gốc, SKU thay, lý do, khách đồng ý lúc nào).

### 8.7. Màn hình soạn đơn (Pick – Weigh – Snap – Pack)

1. Danh sách đơn theo thứ tự ưu tiên: khung giờ giao gần nhất, đơn ASAP, đơn VIP.
2. Mở đơn → danh sách dòng, mỗi dòng: SP, số lượng/khối lượng, **tùy chọn độ chín/sơ chế, ghi chú khách** (nổi bật), lô gợi ý + vị trí (kệ/tủ).
3. Từng dòng: quét lô → cân → ảnh → xác nhận. Gộp nhiều quả 1 dòng vào 1 lần cân được.
4. Sơ chế theo đơn (nếu có): đánh dấu đã gọt, ghi trọng lượng trước gọt.
5. Ảnh tổng giỏ hàng trước khi đóng.
6. Đóng gói: chọn bao bì (túi giữ nhiệt, đá gel), in tem túi.
7. Gọi ship: shipper nội bộ / 3PL.
- Đo **thời gian từng bước** để tối ưu (báo cáo năng suất picker).

### 8.8. Khung giờ giao & năng lực

- `delivery_slots(store_id, date, start, end, capacity_orders, booked)`; khung mặc định 2 giờ.
- Hết chỗ → khung ẩn trên app.
- Cut-off: đặt trước X phút so với đầu khung.
- Ngày lễ (Tết, rằm) cấu hình năng lực riêng.

### 8.9. Giao vận

**8.9.1. Phí giao (`shipping_fee_rules`)**
- Theo khoảng cách đường đi: bậc thang (0–3 km, 3–5 km, …) hoặc `base + per_km`.
- Phụ phí: giờ cao điểm, mưa (bật tay), hàng cồng kềnh/giỏ quà lớn, giao hỏa tốc.
- Miễn phí ship theo giá trị đơn/hạng thành viên/voucher.
- Lưu **phí thu của khách** và **chi phí thực trả 3PL/shipper** riêng → báo cáo lãi/lỗ vận chuyển.

**8.9.2. Shipper nội bộ**
- Nhận chuyến trên app shipper (hoặc cửa hàng phân công), gộp nhiều đơn cùng tuyến.
- Trạng thái: nhận hàng → đang giao → đã giao (ảnh + chữ ký/OTP người nhận với đơn giá trị cao) / thất bại (lý do).
- Gửi vị trí mỗi 15–30 giây khi đang giao → khách xem trên bản đồ.
- Thu COD → **công nợ COD của shipper**; cuối ca nộp tiền cho cửa hàng (phiếu thu) → đối soát.

**8.9.3. Đối tác 3PL (Ahamove / GrabExpress / Lalamove…)**
- Cần đăng ký tài khoản đối tác/doanh nghiệp để có API; mỗi bên có cơ chế báo giá, tạo đơn, webhook trạng thái, hủy khác nhau → viết **adapter chung** `CourierAdapter { quote(), create(), cancel(), track(), parseWebhook() }`.
- Lưu mã vận đơn 3PL, phí báo giá, phí thực tế, trạng thái thô từ 3PL, ánh xạ sang trạng thái nội bộ.
- Đối soát cước định kỳ với hóa đơn 3PL.
- Fallback: 3PL không tìm được tài xế sau N phút → báo cửa hàng, thử đối tác khác hoặc shipper nội bộ.

**8.9.4. Chuỗi lạnh:** đóng gói với túi giữ nhiệt + đá gel cho hàng yêu cầu lạnh (cấu hình theo SKU); thời gian giao tối đa với hàng lạnh/khay cắt (ví dụ ≤ 90 phút). Không cam kết "giao lạnh" theo nghĩa xe lạnh nếu thực tế là xe máy + túi giữ nhiệt — ghi đúng trên app để tránh khiếu nại.

### 8.10. Đối soát thanh toán online

- Hằng ngày: đối chiếu giao dịch nhận được từ cổng/ngân hàng với đơn hàng: khớp / thiếu / thừa / không xác định.
- Hoàn tiền: theo phương thức (credit tự động; chuyển khoản thủ công có chứng từ).
- Báo cáo **"Tiền đang treo"**: đã nhận tiền nhưng đơn chưa giao, đã hoàn nhưng chưa xác nhận…

### 8.11. Đơn doanh nghiệp (B2B) & giỏ quà số lượng lớn

```
[Yêu cầu báo giá] → [Báo giá (PDF, có hiệu lực)] → [Khách duyệt] → [Đặt cọc %] →
[Sản xuất giỏ (phiếu lắp ráp hàng loạt)] → [Giao nhiều địa chỉ / 1 địa chỉ] →
[Xuất HĐĐT có thông tin công ty] → [Công nợ phần còn lại] → [Thu nợ]
```
- Danh sách người nhận nhập bằng Excel (tên, SĐT, địa chỉ, thiệp riêng).
- Hạn mức công nợ; quá hạn → chặn đơn mới.
- Giá B2B theo bảng giá riêng hoặc theo báo giá.

### 8.12. Đặt trước theo mùa (Pre-order)

- Chương trình: thời gian mở đặt, ngày giao, danh sách SKU (giỏ Tết, mâm ngũ quả, hộp quà Trung thu), **giới hạn số lượng**, đặt cọc.
- Gom nhu cầu → đề xuất mua hàng/điều chuyển (§6.10).
- Giao theo đợt, khung giờ năng lực riêng.

### 8.13. Bảo hành "Tươi ngon 24h" (Freshness Guarantee)

**Luồng:**
1. Khách vào đơn đã giao (trong 24h kể từ `DELIVERED` hoặc từ giờ mua tại quầy nếu có tài khoản) → "Yêu cầu bảo hành".
2. Chọn dòng hàng, lý do (sượng, thối ruột, dập, không đúng độ chín, thiếu cân), **ảnh/video chụp trực tiếp** (không chọn từ thư viện), mô tả.
3. Hệ thống tạo **ticket** (`care_tickets`).
4. Tự duyệt nếu: giá trị ≤ ngưỡng (ví dụ 100.000đ) **và** khách chưa vượt N yêu cầu/30 ngày **và** tỷ lệ khiếu nại/đơn của khách < X%. Ngược lại → CS_AGENT xem xét.
5. Bồi hoàn: credit, hoàn tiền, hoặc **giao bù** trong chuyến kế tiếp (tạo đơn 0đ liên kết ticket, trừ kho bình thường).
6. Ticket gắn lô → thống kê **lô/NCC bị khiếu nại** → phản hồi chất lượng NCC, trả hàng NCC nếu lỗi hàng loạt.


---

## Phần 9. App Khách Hàng

### 9.1. Danh sách màn hình

| # | Màn hình | Nội dung chính |
|---|---|---|
| C01 | Khởi động / Force update | Kiểm tra phiên bản tối thiểu (tái sử dụng luồng force update đã có), trạng thái hệ thống |
| C02 | Đăng nhập / Đăng ký | SĐT + OTP; màn hình đồng ý điều khoản & chính sách (tách mục bắt buộc/tùy chọn — §2.3) |
| C03 | Chọn địa chỉ / cửa hàng | Định vị → xác định cửa hàng phục vụ; nếu ngoài vùng → chỉ cho "Đến lấy" hoặc giao theo lịch |
| C04 | Trang chủ | Banner, "Ăn ngon hôm nay" (lô S3), "Giá tốt hôm nay" (markdown), "Hàng mới về", giỏ quà theo dịp, mua lại đơn cũ |
| C05 | Danh mục & tìm kiếm | Lọc: xuất xứ (nhập khẩu bay/biển, nội địa VietGAP/GlobalGAP), giá, độ ngọt (Brix), giòn/mềm, size, dịp (cúng, biếu, ăn kiêng…) |
| C06 | Chi tiết sản phẩm | Ảnh, đơn giá/kg + giá tạm tính theo quả, xuất xứ, **thông tin lô hiện bán** (ngày về, Brix TB, độ chín), hướng dẫn bảo quản/chọn, tùy chọn độ chín & sơ chế, đánh giá |
| C07 | Giỏ hàng | Dòng hàng + tùy chọn, ghi chú từng dòng, lựa chọn khi hết hàng (§8.6), cảnh báo "giá tạm tính" |
| C08 | Thanh toán (checkout) | Loại đơn (ASAP/hẹn giờ/đến lấy/quà tặng), khung giờ, địa chỉ, phí ship, voucher, điểm/credit, phương thức (VietQR trả trước / trả sau khi cân / COD), lựa chọn khi chênh cân lớn |
| C09 | Thanh toán VietQR | QR, số tiền, nội dung, nút "Mở app ngân hàng", đếm ngược, tự chuyển trạng thái khi nhận tiền |
| C10 | Theo dõi đơn | Timeline trạng thái; **phiếu cân thực tế** (ảnh từng món trên cân, cân, tiền); bản đồ shipper; liên hệ cửa hàng |
| C11 | Xác nhận chênh lệch / thay thế | Hiển thị ảnh, số cân, số tiền mới; nút Đồng ý trả thêm / Đổi / Bỏ món; đếm ngược |
| C12 | Trình tạo giỏ quà | §9.5 |
| C13 | Duyệt ảnh giỏ quà | Ảnh giỏ hoàn thiện → Duyệt / Yêu cầu sửa (ghi chú) |
| C14 | Lịch sử đơn | Đơn đã mua, hóa đơn điện tử (link tra cứu), mua lại |
| C15 | Bảo hành 24h | §8.13 |
| C16 | Thành viên | Hạng, điểm, lịch sử điểm, quyền lợi, điều kiện lên hạng |
| C17 | Ví voucher & credit | Voucher khả dụng, credit còn lại + hạn |
| C18 | Giới thiệu bạn bè | Mã giới thiệu, thưởng (tái sử dụng hệ thống referral chống gian lận đã có) |
| C19 | Thông báo | Trạng thái đơn, khuyến mãi (chỉ nếu đồng ý marketing) |
| C20 | Tài khoản | Hồ sơ, địa chỉ, sở thích độ chín, quyền riêng tư (rút đồng ý, tải dữ liệu, **xóa tài khoản**) |
| C21 | Đánh giá | Đánh giá đơn/sản phẩm sau khi giao (sao + ảnh), CS phản hồi |
| C22 | Trạng thái cửa hàng đóng | Gating khi cửa hàng tạm nghỉ (đã có) — cho phép đặt hẹn giờ |

### 9.2. Hiển thị giá & catch-weight cho khách

- Sản phẩm PIECE_BY_WEIGHT: **"Dưa lưới Hoàng Kim · 95.000đ/kg · ~1,8 kg/quả · Tạm tính ~171.000đ/quả"**.
- Giỏ hàng có dòng catch-weight → banner: "Đơn có hàng cân thực tế. Bạn sẽ nhận ảnh cân và số tiền chính xác trước khi giao."
- Sau cân: hiển thị **bảng đối chiếu** tạm tính vs thực tế từng dòng; tổng chênh lệch; cách xử lý (cửa hàng chịu / hoàn credit / cần trả thêm).

### 9.3. Tìm kiếm

- Tìm không dấu ("xoai cat" → Xoài Cát), từ đồng nghĩa (thanh long = dragon fruit; "nho mẫu đơn" = "shine muscat"), sai chính tả nhẹ.
- PostgreSQL: `unaccent` + `pg_trgm` đủ cho bản 1.0.

### 9.4. Thông tin lô cho khách (minh bạch nhưng không lộ dữ liệu nhạy cảm)

| Hiển thị | Không hiển thị |
|---|---|
| Xuất xứ, ngày hàng về, Brix trung bình, độ chín hiện tại, chứng nhận | Tên NCC (tùy cấu hình), giá nhập, tồn kho chính xác |

### 9.5. Trình tạo giỏ quà theo ngân sách

1. Chọn dịp (Tết, 8/3, 20/10, sinh nhật, thăm bệnh, khai trương, cúng) → gợi ý mẫu.
2. Chọn kiểu giỏ/hộp (giỏ mây, hộp gỗ, hộp giấy) — có giá bao bì.
3. Chọn ngân sách (800.000đ / 1.500.000đ / 3.000.000đ / tự nhập) → hệ thống **tự đề xuất thành phần** theo mẫu, trong ngân sách, chỉ dùng hàng còn ATP ở cửa hàng giao; khách thêm/bớt.
4. Nội dung thiệp, ruy băng (giới hạn ký tự, lọc từ cấm).
5. Người nhận (tên, SĐT, địa chỉ, thời gian), ẩn giá trên phiếu giao.
6. Tùy chọn "Duyệt ảnh trước khi giao" → cửa hàng chụp ảnh giỏ hoàn thiện → khách duyệt trong N phút (quá hạn → giao luôn nếu khách chọn "tự động duyệt").
7. Thanh toán (giỏ quà mặc định trả trước; giá cố định — không catch-weight với khách, chênh lệch thành phần do cửa hàng chịu trong dung sai ngân sách giá vốn §6.13).

### 9.6. Tích điểm, hạng thành viên, credit

**Điểm (`loyalty_points`) — KHÔNG làm ở bản đầu (D11), giữ thiết kế để bổ sung sau:**
| Quy tắc | Ví dụ cấu hình |
|---|---|
| Tích | 1 điểm / 1.000đ doanh thu thực thu (sau giảm giá, không tính phí ship) |
| Ghi nhận | Khi đơn `COMPLETED` (sau bảo hành 24h) — tránh tích rồi hoàn |
| Đổi | 1 điểm = 1đ khi trừ vào đơn; tối đa 50% giá trị đơn |
| Hạn | Điểm hết hạn sau 12 tháng kể từ ngày tích (FIFO) |
| Hoàn đơn | Thu hồi điểm đã tích từ đơn đó; nếu đã dùng → trừ vào điểm hiện có (có thể âm, chặn đổi khi âm) |

**Hạng (`member_tiers`):** Đồng / Bạc / Vàng / Kim cương theo chi tiêu 12 tháng lăn; quyền lợi: % giảm, miễn ship, ưu tiên khung giờ, quà sinh nhật; xét hạng hằng tháng.

**Credit cửa hàng:** §2.4 — sổ cái riêng `store_credit_ledger` (cấp, dùng, hết hạn, thu hồi), số dư = tổng ledger.

> **Hạch toán:** số dư điểm và credit đang lưu hành là **nghĩa vụ** của cửa hàng → báo cáo riêng cho Master Admin/kế toán.

### 9.7. Khuyến mãi & voucher (`promotions`)

| Loại | Ví dụ |
|---|---|
| Giảm % / số tiền trên đơn | Giảm 10% đơn từ 500.000đ |
| Giảm theo SKU/danh mục | Nho -20% thứ 4 |
| Mua X tặng Y | Mua 2 kg cam tặng 0,5 kg |
| Combo giá cố định | Táo + lê 199.000đ |
| Miễn/giảm phí ship | Free ship đơn từ 300.000đ |
| Voucher mã | Mã cá nhân / mã chung, giới hạn lượt toàn chương trình, lượt/khách, kênh, cửa hàng, hạng, thời gian, khách mới |
| Giờ vàng | 19h–21h giảm hàng S3/S4 |

- Thứ tự áp & quy tắc cộng dồn (stackable / exclusive) cấu hình rõ.
- Ngân sách chương trình (tổng tiền giảm tối đa) → tự dừng khi chạm.
- Chống lạm dụng: 1 thiết bị/1 SĐT/1 địa chỉ cho voucher khách mới (tái sử dụng logic chống gian lận referral).
- Báo cáo hiệu quả: số đơn, doanh thu, tổng giảm, lãi gộp sau giảm.

### 9.8. Thông báo đẩy

| Sự kiện | Kênh |
|---|---|
| Đơn được nhận, đang soạn, đã cân (kèm ảnh + số tiền), cần xác nhận chênh lệch, đang giao, đã giao | Push (FCM/APNs), dự phòng SMS/ZNS cho bước cần hành động (xác nhận/thanh toán) |
| Hoàn tiền/credit | Push |
| Khuyến mãi | Push — **chỉ khi có đồng ý marketing**; giới hạn tần suất |

---

## Phần 10. Hệ thống Admin 2 tầng & Cổng phát hành

### 10.1. Mô hình 3 lớp dữ liệu cho Admin Chỉ Xem

Bản v1 gộp chung "ẩn dữ liệu" và "đổi số liệu" vào một khái niệm "Publish". v2 tách rõ **3 lớp**:

| Lớp | Tên | Nội dung | Độ trễ | Cách kiểm soát |
|---|---|---|---|---|
| **R1** | **Live Operational Mirror** (bản chiếu vận hành trực tiếp) | Trạng thái cửa hàng, đơn hàng, giao vận, doanh thu bán ra (chưa chốt), số đơn, sản lượng, tồn kho theo số lượng | p95 ≤ 3 giây | **Visibility Policy**: chọn trường nào hiển thị/che/ẩn — không đổi giá trị |
| **R2** | **Published Snapshots** (báo cáo đã phát hành) | Báo cáo kỳ đã khóa: doanh thu thuần, giá vốn, lãi gộp, xuất–nhập–tồn có giá trị, hao hụt, P&L, vận chuyển | Theo kỳ, khi Master bấm phát hành hoặc rule tự động | **Publish workflow**: chuẩn bị → xem trước song song → phát hành → bất biến, có phiên bản |
| **R3** | **Management Adjustments** (điều chỉnh quản trị) | Giá vốn định mức thay cho giá thật, phân bổ chi phí quản trị, gộp/tách chỉ tiêu | Đi kèm R2 | **Bắt buộc gắn nhãn** "Định mức/Quản trị", hiển thị dòng chênh lệch (nếu profile cho xem) hoặc ít nhất nhãn cơ sở số liệu |

### 10.2. Hồ sơ hiển thị (Viewer Profile)

Mỗi tài khoản Admin Chỉ Xem gắn **1 Viewer Profile** (nhiều tài khoản dùng chung 1 profile được). Profile do Master Admin tạo:

| Nhóm cấu hình | Lựa chọn |
|---|---|
| Phạm vi | Toàn chuỗi / danh sách vùng / danh sách cửa hàng / kho |
| Module được xem | Dashboard live, đơn hàng, giao vận, tồn kho, doanh thu, P&L, NCC, khách hàng (thống kê), nhân sự (thống kê), báo cáo tải về |
| Khách hàng | `HIDDEN` (chỉ số liệu tổng hợp) · `MASKED` (tên viết tắt + `098***4321`) · `FULL` (cần Master xác nhận step-up, log) |
| Giá vốn / giá nhập | `NONE` (không thấy giá vốn, không thấy lãi gộp) · `PUBLISHED` (chỉ thấy số trong snapshot đã phát hành, có nhãn cơ sở) · `ACTUAL` (thấy giá thật — tương đương quyền kế toán xem) |
| Nhà cung cấp | Ẩn tên NCC / hiện tên / hiện cả điều khoản |
| Hóa đơn | Chỉ hóa đơn đã chốt · gồm cả hóa đơn hủy (số lượng, giá trị — không chi tiết người hủy) |
| Hoạt động thu ngân | Ẩn · tổng hợp theo cửa hàng (số dòng xóa, chênh lệch két) · chi tiết theo nhân viên |
| Xuất file | Không · chỉ file snapshot đã phát hành · được tạo file từ dữ liệu R1 trong phạm vi |
| Thời gian | Xem từ ngày X (ví dụ nhà đầu tư mới chỉ xem từ ngày tham gia) |

> Master Admin có nút **"Xem như [tên viewer]"** để kiểm tra đúng những gì viewer đang thấy (chỉ đọc, có log).

### 10.3. Lớp R1 — Live Mirror (projection realtime)

- Worker nhận sự kiện từ outbox → cập nhật bảng `reporting.live_*` đã **loại bỏ trường nhạy cảm ngay từ cấu trúc bảng** (bảng không có cột giá nhập, không có cột SĐT đầy đủ).
- Với trường "che theo profile" (ví dụ SĐT): bảng `reporting` lưu sẵn 2 dạng `customer_display_masked`, `customer_ref_id`; profile `FULL` mới được gọi API tra chi tiết qua module Master có kiểm soát (không lưu PII đầy đủ ở `reporting`).
- Doanh thu R1 luôn hiển thị nhãn **"Số liệu tạm tính — chưa khóa sổ"**.
- Bảng chính:
  - `reporting.live_store_status` (trạng thái cửa hàng, ca đang mở, số đơn chờ, tải)
  - `reporting.live_orders` (đơn: mã, cửa hàng, kênh, trạng thái, thời điểm từng bước, tổng tiền, tổng cân, khách đã che, shipper/3PL, thời gian giao)
  - `reporting.live_sales_hourly` (doanh thu theo giờ × cửa hàng × kênh)
  - `reporting.live_stock_levels` (tồn theo cửa hàng × SKU: số lượng, số lô, lô sắp hết hạn — **không có giá trị tiền**)
  - `reporting.live_deliveries` (vận đơn, vị trí shipper gần nhất, trễ hẹn)

### 10.4. Lớp R2/R3 — Phát hành báo cáo (Publish Workflow)

**10.4.1. Nguyên tắc liêm chính số liệu (bắt buộc)**
1. **Ẩn thì được, sửa ngầm thì không.** Master Admin luôn được quyền **không cho xem** một chỉ tiêu. Nhưng mọi con số được hiển thị phải hoặc là **số thực tế**, hoặc mang **nhãn cơ sở** rõ ràng (ví dụ "Giá vốn định mức nội bộ").
2. Mọi snapshot **bất biến**; muốn sửa phải phát hành **phiên bản mới** kèm lý do, viewer thấy "v2 thay thế v1 lúc…, lý do: …".
3. Mỗi snapshot lưu **checksum** dữ liệu và người phát hành.
4. Nếu viewer là **cổ đông, nhà đầu tư, đối tác góp vốn**: khuyến nghị dùng cơ sở số liệu **thực tế** cho báo cáo tài chính kỳ; số định mức chỉ dùng cho báo cáo quản trị nội bộ có nhãn. (Đây là khuyến nghị để bảo vệ chính chủ hệ thống khỏi tranh chấp — nên hỏi ý kiến kế toán/luật sư.)

**10.4.2. Các bước**
```
① Chọn loại báo cáo + kỳ + phạm vi (cửa hàng/vùng) + viewer profile đích
② Hệ thống kiểm tra điều kiện: kỳ đã khóa sổ? (khuyến nghị bắt buộc với báo cáo tài chính)
   Còn phiếu chưa duyệt (hủy, kiểm kê, chi phí nhập chưa phân bổ)? → cảnh báo, liệt kê
③ Chọn cơ sở giá vốn: THỰC TẾ (landed) | ĐỊNH MỨC (published_unit_cost theo bảng giá vốn công bố)
   Chọn quy tắc trình bày: gộp hủy+hao hụt, ẩn chiết khấu NCC, gộp kênh...
④ Xem trước song song (Side-by-side): Cột A = số thực tế · Cột B = số viewer sẽ thấy · Cột C = chênh lệch
   Tô màu các dòng có chênh lệch; Master phải tick "Tôi đã kiểm tra" cho từng nhóm có chênh lệch
⑤ Ghi chú phát hành (hiển thị cho viewer) + step-up 2FA
⑥ Phát hành: ghi snapshot header + fact rows (bất biến) + sinh file PDF/Excel + thông báo viewer
⑦ (Nếu cần) Thu hồi: đánh dấu REVOKED + lý do (viewer vẫn thấy dấu vết "đã thu hồi"), hoặc phát hành phiên bản mới
```

**10.4.3. Chế độ tự động (Auto-Rule Sync)**
- Rule: "Mỗi ngày 23:30 phát hành báo cáo doanh thu ngày cho profile X, cơ sở THỰC TẾ, không có giá vốn" → chạy tự động, không cần xem trước.
- Rule có giá vốn/định mức → **không cho tự động hoàn toàn**: hệ thống chuẩn bị bản nháp, gửi Master duyệt 1 chạm trên app mobile.
- Mọi lần chạy rule ghi log; lỗi → báo Master.

**10.4.4. Bảng giá vốn công bố (Published Cost Matrix)**
- `published_cost_matrix(sku_id, period, published_cost_per_kg, basis_note, created_by)` — giá vốn định mức theo SKU theo kỳ.
- Gợi ý tự động: giá vốn thực tế bình quân kỳ trước × (1 + định mức hao hụt + định mức vận chuyển).
- Thay đổi bảng sau khi đã có snapshot dùng nó → phải phát hành lại phiên bản mới (không tự cập nhật snapshot cũ).

### 10.5. Cấu trúc snapshot (sửa lỗi S15)

```
reporting.snapshots
  snapshot_id, report_type, period_start, period_end, scope (stores[]), viewer_profile_ids[],
  cost_basis (ACTUAL|STANDARD|NONE), presentation_rules_jsonb, version, supersedes_snapshot_id,
  status (PUBLISHED|REVOKED|SUPERSEDED), published_by, published_at, release_note,
  data_checksum, summary_jsonb, files[] (pdf, xlsx)

reporting.snapshot_sales_facts        (snapshot_id, date, store_id, channel, category_id, sku_id,
                                       qty_units, weight_g, gross_amount, discount_amount, net_amount,
                                       cogs_amount, gross_profit, cost_basis_label)
reporting.snapshot_inventory_facts    (snapshot_id, store_id, sku_id, opening_g, in_g, out_g, shrink_g,
                                       spoilage_g, closing_g, closing_value, cost_basis_label)
reporting.snapshot_shrink_facts       (snapshot_id, store_id, sku_id, type, weight_g, value)
reporting.snapshot_delivery_facts     (snapshot_id, store_id, date, orders, on_time, avg_minutes,
                                       fee_collected, cost_paid)
reporting.snapshot_pnl_lines          (snapshot_id, line_code, line_label, amount, basis_label, sort)
reporting.snapshot_purchase_facts     (snapshot_id, supplier_display, sku_id, weight_g, value, basis_label)
```
→ Viewer lọc/drill-down/biểu đồ trên các bảng fact; tất cả **không UPDATE/DELETE** (trigger chặn).

### 10.6. Khóa sổ kỳ (Period Close)

1. Kế toán/Master chọn kỳ (ngày/tuần/tháng) → checklist: ca đã đóng hết, HĐĐT không còn PENDING, kiểm kê cuối kỳ đã duyệt, phiếu hủy đã duyệt, chi phí nhập đã phân bổ, đối soát thanh toán xong.
2. Khóa → mọi chứng từ trong kỳ **chỉ đọc**; phát sinh sau phải ghi vào kỳ mở kế tiếp dưới dạng điều chỉnh.
3. Mở khóa lại: chỉ OWNER/MASTER + step-up + lý do; tự động đánh dấu các snapshot của kỳ đó "cần phát hành lại".

### 10.7. Chức năng Admin Toàn Quyền (Master Admin) — theo module

| Module | Chức năng |
|---|---|
| **Tổng quan** | Dashboard thực (giá vốn thật, lãi gộp thật), cảnh báo (HĐĐT lỗi, cân hết hạn kiểm định, tồn âm, chênh két, lô sắp hết hạn, đơn trễ, tỷ lệ hủy tăng) |
| **Đơn hàng & hóa đơn** | Tìm mọi đơn/hóa đơn (kể cả nháp, treo, hủy), chi tiết dòng, log từng thao tác, can thiệp trạng thái (có log), hoàn tiền, xuất lại HĐĐT |
| **Kiểm toán POS** | Log xóa dòng sau cân, mở két, nhập cân tay, giảm giá tay, hủy hóa đơn — lọc theo nhân viên/ca; chênh lệch két theo ca |
| **Khách hàng & CRM** | Hồ sơ đầy đủ, lịch sử mua, khiếu nại, ghi chú VIP, phân nhóm (RFM), công nợ B2B, xuất danh sách (step-up), xử lý yêu cầu quyền riêng tư |
| **Sản phẩm & giá** | Danh mục, SKU, BOM, công thức sơ chế, bảng giá, lịch sử giá, markdown rules |
| **Mua hàng & NCC** | PO, phiếu nhận, trả NCC, landed cost, công nợ, thanh toán, rebate, đánh giá NCC |
| **Kho** | Tồn theo lô/vị trí, điều chuyển, kiểm kê, duyệt hủy, hao hụt, đề xuất đặt hàng |
| **Giá vốn** | Giá vốn thật theo lô, landed cost, bảng giá vốn công bố |
| **Cửa hàng & thiết bị** | Bật/tắt cửa hàng, giờ hoạt động, vùng giao, năng lực, thiết bị, hạn kiểm định cân |
| **Vận chuyển** | Rule phí ship, shipper nội bộ, tài khoản 3PL, đối soát cước, sự cố giao |
| **Khuyến mãi & thành viên** | Chương trình, voucher, hạng, điểm, credit, ngân sách |
| **Tài chính** | Sổ quỹ, đối soát thanh toán, tiền treo, khóa kỳ, xuất dữ liệu kế toán, sổ doanh thu kê khai |
| **Nhân sự & phân quyền** | Tài khoản, vai trò, phạm vi, hạn mức, thiết bị POS, phiên đăng nhập |
| **Publish Gate** | Viewer profiles, chuẩn bị/xem trước/phát hành/thu hồi snapshot, rule tự động, "xem như viewer" |
| **Báo cáo** | Mọi báo cáo thô (Excel/CSV/PDF) |
| **Cấu hình hệ thống** | Thuế, HĐĐT, cổng thanh toán, OTP, thông báo, chính sách catch-weight, bảo hành, điểm |
| **Audit** | Nhật ký toàn hệ thống (chỉ OWNER thấy log của Master) |

### 10.8. Chức năng Admin Chỉ Xem — theo module

| Module | Chức năng |
|---|---|
| **Live 360°** | Bản đồ cửa hàng (mở/đóng/tạm dừng, tải), đơn chờ soạn, đơn đang giao trên bản đồ, đơn trễ, ca đang mở |
| **Doanh thu trực tiếp** | Theo giờ/ngày/cửa hàng/kênh (POS · App · Quà/B2B), so với cùng kỳ — nhãn "tạm tính" |
| **Đơn hàng** | Danh sách & chi tiết (theo profile: khách che/ẩn), trọng lượng xuất, trạng thái thanh toán, timeline — **không có nút thao tác** |
| **Giao vận** | Trạng thái, thời gian giao TB, tỷ lệ đúng hẹn, chi phí vận chuyển / doanh thu (nếu profile cho) |
| **Tồn kho** | Tồn theo cửa hàng (số lượng), lô sắp hết hạn, cảnh báo |
| **Báo cáo đã phát hành** | Danh sách snapshot theo kỳ, xem trực tuyến (biểu đồ, bảng, drill-down), tải PDF/Excel, lịch sử phiên bản, ghi chú phát hành |
| **Thông báo** | Báo cáo mới phát hành, cảnh báo vận hành lớn (cấu hình được) |

### 10.9. App Admin Mobile

- Master: dashboard, duyệt nhanh (hủy hàng, markdown dưới giá vốn, điều chỉnh kiểm kê, hoàn tiền lớn, snapshot tự động chờ duyệt), cảnh báo đẩy, bật/tắt cửa hàng.
- Viewer: Live 360°, doanh thu, báo cáo đã phát hành.
- Duyệt trên mobile dùng **biometric + PIN** làm step-up.

---

## Phần 11. Báo cáo & định nghĩa KPI

> Mọi KPI phải có **định nghĩa duy nhất** dùng chung cho POS, Admin và Snapshot.

### 11.1. Doanh thu & lợi nhuận

| KPI | Công thức |
|---|---|
| Doanh thu gộp (Gross Sales) | Σ (đơn giá niêm yết × khối lượng/số lượng thực) các dòng hàng hóa |
| Giảm trừ | Khuyến mãi + giảm giá tay + giảm hạng + markdown (phần giảm so với niêm yết) + điểm/credit sử dụng (tùy chính sách — Q7) |
| **Doanh thu thuần** | Doanh thu gộp − giảm trừ − hàng trả lại (không gồm phí ship) |
| Doanh thu dịch vụ | Phí ship thu khách + phí sơ chế + phí gói quà |
| COGS | Theo §6.6 |
| **Lãi gộp** | Doanh thu thuần − COGS |
| Biên lãi gộp % | Lãi gộp / Doanh thu thuần |
| Chi phí hao hụt & hủy | Theo §6.6, tách định mức / ngoài định mức / hủy theo lý do |
| Lãi gộp sau hao hụt | Lãi gộp − hao hụt − hủy − ăn thử + rebate |
| Lãi/lỗ vận chuyển | Phí ship thu − chi phí shipper/3PL − bao bì giữ nhiệt |
| Chi phí catch-weight hấp thụ | Σ phần cửa hàng chịu khi hàng nặng hơn |

### 11.2. Vận hành bán hàng

| KPI | Công thức |
|---|---|
| Số hóa đơn, AOV (giá trị đơn TB) | Doanh thu thuần / số hóa đơn |
| Số dòng/hóa đơn | — |
| Tỷ trọng kênh | Doanh thu thuần theo kênh / tổng |
| Doanh thu/m² kệ, /giờ mở cửa | (khi có dữ liệu diện tích) |
| Tỷ lệ xóa dòng sau cân | Số dòng xóa đã có số cân / tổng dòng cân — theo thu ngân |
| Chênh lệch két | Σ |chênh lệch| theo ca/thu ngân |
| Tỷ lệ nhập cân tay | Dòng MANUAL / dòng cân |

### 11.3. Hàng hóa & kho

| KPI | Công thức |
|---|---|
| Hao hụt % | Khối lượng hao hụt kiểm kê / (tồn đầu + nhập) — theo SKU, cửa hàng |
| Tỷ lệ hủy % | Giá trị hủy / giá vốn hàng xuất |
| Sell-through % | Khối lượng bán / khối lượng nhận (theo lô) |
| Số ngày tồn (DOH) | Tồn hiện tại / bán TB ngày |
| Tỷ lệ thu hồi lô (Recovery) | Doanh thu thu được từ lô / (giá bán niêm yết × khối lượng nhận) — đo hiệu quả markdown & chế biến |
| Tỷ lệ markdown | Giá trị giảm markdown / doanh thu gộp |
| Yield sơ chế thực vs chuẩn | — |
| Tỷ lệ hết hàng (stockout) | Số lần SKU ATP = 0 trong giờ bán / tổng giờ |
| Chất lượng NCC | % QC loại khi nhận, % khiếu nại khách theo lô của NCC, Brix TB vs cam kết |

### 11.4. Online & giao vận

| KPI | Công thức |
|---|---|
| Thời gian nhận đơn | `ACCEPTED − PLACED` |
| Thời gian soạn | `PACKED − ACCEPTED` |
| Thời gian giao | `DELIVERED − SHIPPER_ASSIGNED` |
| Tỷ lệ đúng hẹn | Đơn giao trong khung/ cam kết / tổng đơn giao |
| Tỷ lệ từ chối/hủy theo lý do | — |
| Chênh lệch cân TB | Σ |actual − est| / Σ est (theo SKU — dùng để chỉnh `std_weight_g`) |
| Tỷ lệ đơn cần khách xác nhận | — |
| Tỷ lệ khiếu nại bảo hành, giá trị bồi hoàn | Theo SKU, lô, NCC, cửa hàng |

### 11.5. Khách hàng

| KPI | Công thức |
|---|---|
| Khách mới, khách quay lại | Theo kỳ |
| Tỷ lệ mua lại 30/60/90 ngày | Cohort |
| Tần suất mua, CLV ước tính | — |
| Phân nhóm RFM | Recency / Frequency / Monetary |
| Số dư điểm & credit đang lưu hành | Nghĩa vụ |

### 11.6. Báo cáo bắt buộc theo kỳ

| Báo cáo | Kỳ | Người nhận mặc định |
|---|---|---|
| Z-report cửa hàng | Ngày | STORE_MGR, MASTER |
| Doanh thu ngày toàn chuỗi | Ngày | MASTER, Viewer (auto, không giá vốn) |
| Xuất–Nhập–Tồn (khối lượng + giá trị) | Tuần/Tháng | MASTER, ACCOUNTANT; Viewer qua snapshot |
| Hao hụt & hủy | Tuần | MASTER, OPS; Viewer qua snapshot |
| P&L quản trị | Tháng | MASTER; Viewer qua snapshot |
| Sổ doanh thu kê khai thuế | Tháng/Quý | ACCOUNTANT |
| Công nợ NCC & B2B | Tuần | ACCOUNTANT |
| Kiểm toán POS (bất thường) | Tuần | MASTER |
| Hiệu quả khuyến mãi | Theo chương trình | MASTER |


---

## Phần 12. Thiết kế cơ sở dữ liệu

### 12.1. Quy ước

| Quy ước | Chi tiết |
|---|---|
| Khóa chính | `UUID v7` (sắp theo thời gian, sinh được ở client offline) |
| Mã hiển thị | Mã ngắn dễ đọc riêng: `SO-CH01-251117-0042`, `B251117-003`, `PO-2511-015` |
| Tiền | `BIGINT` đơn vị đồng — hậu tố `_amount` hoặc `_price` |
| Đơn giá theo kg | `BIGINT` đồng/kg — hậu tố `_per_kg` |
| Khối lượng | `INTEGER` gram — hậu tố `_g` |
| Số lượng đếm | `INTEGER` — hậu tố `_units` |
| Tỷ lệ | `NUMERIC(7,4)` (0.0350 = 3,5%) |
| Thời gian | `TIMESTAMPTZ` (UTC lưu, hiển thị Asia/Ho_Chi_Minh); ngày kinh doanh `business_date DATE` tính theo giờ VN |
| Trạng thái | `TEXT` + `CHECK` (hoặc enum Postgres) — đồng bộ enum với `shared_models` |
| Xóa | Không xóa vật lý chứng từ; danh mục dùng `archived_at` |
| Kiểm soát đồng thời | Cột `version INTEGER` (optimistic lock) trên bảng hay bị sửa đồng thời (đơn, tồn) |
| Audit | `created_at, created_by, updated_at, updated_by` trên mọi bảng `core` |

### 12.2. Danh sách bảng — schema `core`

**Danh mục & cấu hình**
```
categories(id, parent_id, name, slug, sort, archived_at)
products(id, category_id, name, slug, description, origin_default, season_months int[], storage_guide,
         tags text[], tax_category_id, ripeness_profile_id, images jsonb, archived_at)
skus(id, product_id, sku_code UNIQUE, name, sale_unit_type, size_grade, origin,
     std_weight_g, weight_min_g, weight_max_g, tare_g, min_order_g, step_g,
     list_price_per_kg, list_price_per_unit, scale_plu CHAR(5) UNIQUE NULL, barcode,
     shelf_life_days, storage_temp_min, storage_temp_max, shrink_norm_pct,
     is_high_value, allow_substitution, catch_weight_policy_id, payment_mode_default,
     cold_chain_required, archived_at)
sku_substitutes(sku_id, substitute_sku_id, max_price_diff_pct, priority)
modifier_groups(id, name, type, required, multi_select)
modifier_options(id, group_id, name, surcharge_amount, surcharge_per_kg, ripeness_stage, processing_recipe_id)
product_modifier_groups(product_id, group_id)
ripeness_profiles(id, name)  ·  ripeness_stages(profile_id, stage, label_customer, est_days_ambient, est_days_cold, markdown_pct_suggest)
tax_categories(id, code, name, rates jsonb, valid_from)
bom_templates(id, sku_id, packaging jsonb, cost_budget_amount, cost_tolerance_pct)
bom_items(id, bom_id, component_sku_id, substitute_group_id, qty_units, weight_g)
processing_recipes(id, output_sku_id, std_yield_pct, packaging jsonb, output_shelf_hours)
processing_recipe_inputs(recipe_id, input_sku_id, std_weight_g)
price_lists(id, name, channel, store_ids uuid[], member_tier, priority, valid_from, valid_to)
price_list_items(price_list_id, sku_id, price_per_kg, price_per_unit)
price_change_logs(id, sku_id, price_list_id, old, new, reason, changed_by, changed_at)
catch_weight_policies(id, absorb_over_pct, absorb_over_max_amount, confirm_threshold_pct,
                      confirm_threshold_amount, confirm_timeout_min)
```

**Tổ chức, thiết bị, người dùng**
```
regions(id, name)
stores(id, region_id, code, name, address, lat, lng, phone, opening_hours jsonb, status,
       online_status, delivery_radius_m, capacity_per_hour, invoice_address, einvoice_config jsonb)
locations(id, store_id NULL, warehouse_id NULL, parent_id, type, name, temp_controlled)
warehouses(id, code, name, address)
registers(id, store_id, code, name)
devices(id, store_id, register_id, type, brand, model, serial, connection jsonb,
        calibration_cert_no, calibration_expires_at, cert_photo_file_id, last_seen_at, status)
users(id, type (STAFF|CUSTOMER|B2B), phone_enc, phone_hash, email, password_hash, pin_hash,
      totp_secret_enc, status, last_login_at)
staff_profiles(user_id, staff_code, full_name, hired_at, left_at)
user_role_assignments(id, user_id, role, scope_type (GLOBAL|REGION|STORE|WAREHOUSE), scope_id, granted_by, granted_at)
approval_limits(role, action, max_amount, max_pct)
pos_devices_registered(id, store_id, register_id, device_fingerprint, activated_by, activated_at, revoked_at)
sessions(id, user_id, device_id, refresh_token_hash, ip, user_agent, created_at, expires_at, revoked_at)
viewer_profiles(id, name, scope jsonb, modules text[], customer_visibility, cost_visibility,
                supplier_visibility, cashier_activity_visibility, export_mode, visible_from_date)
viewer_profile_assignments(user_id, viewer_profile_id)
```

**Khách hàng**
```
customers(id, user_id, full_name, phone_enc, phone_hash, email, birthday, tier_id, points_balance,
          credit_balance, source, preferred_store_id, referral_code, referred_by, status, anonymized_at)
customer_addresses(id, customer_id, label, receiver_name, receiver_phone_enc, address_enc, lat, lng, note)
customer_preferences(customer_id, product_id, ripeness_pref, dislikes, notes)
customer_notes(id, customer_id, note_enc, created_by)
customer_consents(id, customer_id, purpose, granted, policy_version, channel, at)
privacy_requests(id, customer_id, type (ACCESS|CORRECT|DELETE|WITHDRAW), status, due_at, handled_by, handled_at)
companies(id, name, tax_code, invoice_address, credit_limit_amount, payment_terms_days, status)
company_members(company_id, user_id, role)
member_tiers(id, code, name, min_spend_12m, benefits jsonb)
loyalty_ledger(id, customer_id, type (EARN|REDEEM|EXPIRE|REVERSE|ADJUST), points, order_id, expires_at, at)
store_credit_ledger(id, customer_id, type (ISSUE|USE|EXPIRE|REVOKE), amount, reason, ref_type, ref_id, expires_at, at)
```

**Mua hàng & kho**
```
suppliers(id, code, name, type, tax_code, address, contact jsonb, bank jsonb, payment_terms_days,
          certifications jsonb, rating)
supplier_skus(supplier_id, sku_id, ref_price_per_kg, lead_time_days)
purchase_orders(id, code, supplier_id, warehouse_id, status, expected_at, note)
purchase_order_lines(id, po_id, sku_id, qty_g, qty_units, expected_price_per_kg, expected_price_per_unit)
goods_receipts(id, code, po_id NULL, supplier_id, location_id, received_at, received_by,
               supplier_invoice_no, invoice_file_id, temp_c, status)
goods_receipt_lines(id, receipt_id, sku_id, containers, container_tare_g, gross_g, net_g, units,
                    sample_avg_piece_g, brix_samples numeric[], ripeness_stage, damaged_g,
                    accepted_g, accepted_units, rejected_g, reject_reason,
                    invoice_price_per_kg, invoice_price_per_unit, photos uuid[], batch_id)
landed_cost_entries(id, receipt_id, type, amount, allocation_method, invoice_ref)
landed_cost_allocations(entry_id, batch_id, amount)
supplier_returns(id, supplier_id, receipt_id, status, lines jsonb, photos uuid[], credit_amount)
supplier_invoices(id, supplier_id, invoice_no, amount, due_at, status)
supplier_payments(id, supplier_id, amount, paid_at, method, ref, created_by, approved_by)
supplier_rebates(id, supplier_id, period, amount, doc_ref, recognized_period)
inventory_batches(id, code, sku_id, supplier_id, receipt_line_id, parent_batch_ids uuid[],
                  origin_country, origin_region, harvest_date, received_at, expiry_date,
                  ripeness_stage, ripeness_checked_at, brix_avg, size_grade, avg_piece_weight_g,
                  raw_unit_cost_per_kg, landed_unit_cost_per_kg, raw_unit_cost_per_unit,
                  landed_unit_cost_per_unit, status, certifications jsonb)
stock_movements(id, business_date, location_id, batch_id, sku_id, movement_type, qty_g, qty_units,
                unit_cost_per_kg, unit_cost_per_unit, cost_amount, source_type, source_id,
                reason_code, created_by, created_at)         -- APPEND ONLY (trigger chặn UPDATE/DELETE)
stock_balances(location_id, batch_id, sku_id, on_hand_g, on_hand_units, updated_at, version)
inventory_reservations(id, order_line_id, store_id, sku_id, batch_id NULL, reserved_g, reserved_units, expires_at, status)
transfer_orders(id, code, from_location_id, to_location_id, status, requested_by, approved_by,
                shipped_at, received_at, temp_out_c, temp_in_c)
transfer_lines(id, transfer_id, batch_id, sku_id, sent_g, sent_units, received_g, received_units,
               variance_reason, photos uuid[])
stocktakes(id, code, location_id, type (SHIFT|CYCLE|FULL), status, started_at, closed_at, approved_by)
stocktake_lines(id, stocktake_id, sku_id, batch_id NULL, counted_g, counted_units, counted_at,
                system_g_at_count, system_units_at_count, variance_g, variance_class
                (NATURAL_SHRINK|ABNORMAL|GAIN), explanation)
shrinkage_logs(id, location_id, batch_id, type (SAMPLING|SPOILAGE|INTERNAL_USE|PROCESS_WASTE),
               reason_code, loss_g, loss_units, cost_amount, photo_file_ids uuid[], created_by,
               approved_by, approved_at, status)
ripeness_checks(id, batch_id, location_id, from_stage, to_stage, split_to_batch_id, photo_file_id, checked_by, at)
markdown_rules(id, name, conditions jsonb, steps jsonb, floor_rule jsonb, channels text[], approval_matrix jsonb)
markdowns(id, batch_id, location_id, pct, price_per_kg, price_per_unit, valid_from, valid_to,
          status (PROPOSED|APPROVED|ACTIVE|EXPIRED|REJECTED), proposed_by, approved_by)
processing_orders(id, code, recipe_id, location_id, status, planned_output, actual_output_units,
                  actual_output_g, actual_yield_pct, cost_amount, output_batch_id, created_by)
processing_order_inputs(id, processing_order_id, batch_id, sku_id, weight_g, units)
replenishment_suggestions(id, business_date, location_id, sku_id, suggested_g, suggested_units,
                          basis jsonb, accepted_g, status)
```

**Bán hàng, đơn hàng, thanh toán**
```
shifts(id, store_id, register_id, cashier_id, opened_at, opening_cash jsonb, closed_at,
       counted_cash jsonb, counted_total, expected_total, variance_amount, variance_reason, status)
cash_movements(id, shift_id, store_id, type (IN|OUT|DEPOSIT|NO_SALE_OPEN), category, amount, note,
               file_id, created_by, approved_by)
orders(id, code, channel (POS|APP|B2B|PHONE), order_type, store_id, register_id, shift_id,
       customer_id, company_id, status, client_txn_id UNIQUE, is_offline,
       est_subtotal, actual_subtotal, discount_amount, shipping_fee_amount, service_fee_amount,
       rounding_amount, total_amount, paid_amount, refunded_amount, cw_absorbed_amount,
       payment_mode (PREPAID_EST|PAY_AFTER_WEIGH|COD|POS_IMMEDIATE),
       delivery_slot_id, delivery_address_snapshot_enc, gift_info jsonb, notes,
       placed_at, accepted_at, packed_at, delivered_at, completed_at, cancelled_at, cancel_reason,
       version)
order_lines(id, order_id, sku_id, sku_snapshot jsonb, qty_units, est_weight_g, actual_weight_g,
            weight_source (SCALE|LABEL|MANUAL|NONE), scale_device_id, scale_photo_file_id,
            unit_price_per_kg, unit_price_per_unit, markdown_id, est_amount, actual_amount,
            discount_amount, modifiers jsonb, prep_note, substitution_pref, batch_allocations jsonb,
            cogs_amount, status (ACTIVE|VOIDED|SUBSTITUTED|OUT_OF_STOCK), voided_by, voided_at, void_reason)
order_line_substitutions(id, order_line_id, from_sku_id, to_sku_id, reason, customer_decision, decided_at)
order_events(id, order_id, from_status, to_status, actor_id, actor_role, reason, at)   -- timeline
order_photos(id, order_id, type (BASKET|PACKED|DELIVERED|GIFT_PREVIEW), file_id, at)
gift_previews(id, order_id, file_id, status (PENDING|APPROVED|CHANGES_REQUESTED|AUTO_APPROVED), customer_note, at)
payments(id, order_id, method, amount, status (PENDING|SUCCEEDED|FAILED|EXPIRED|REFUNDED|PARTIAL),
         provider, provider_ref, payment_code, qr_payload, expires_at, paid_at, raw jsonb)
refunds(id, order_id, payment_id, amount, method (CREDIT|BANK_TRANSFER|CASH|PROVIDER),
        reason, status, created_by, approved_by)
unmatched_bank_txns(id, provider, provider_txn_id, amount, content, txn_at, matched_order_id, matched_by)
einvoices(id, order_id, provider, series, number, lookup_code, status, request jsonb, response jsonb,
          attempts, last_error, issued_at, replaced_by_id)
promotions(id, code, type, rules jsonb, stackable, budget_amount, used_amount, valid_from, valid_to, status)
promotion_usages(id, promotion_id, order_id, customer_id, discount_amount)
vouchers(id, promotion_id, code UNIQUE, customer_id NULL, max_uses, used_count, expires_at)
```

**Giao vận & CSKH**
```
delivery_zones(id, store_id, polygon geography, fee_rule_id)
shipping_fee_rules(id, name, tiers jsonb, surcharges jsonb, free_rules jsonb)
delivery_slots(id, store_id, date, start_time, end_time, capacity, booked)
shipments(id, order_id, carrier (INTERNAL|AHAMOVE|GRAB|LALAMOVE|...), carrier_order_id,
          shipper_id, status, raw_status, quoted_fee_amount, actual_fee_amount, cod_amount,
          pod_photo_file_id, pod_otp_verified, distance_m, eta, assigned_at, picked_at, delivered_at,
          failed_reason)
shipment_tracks(shipment_id, lat, lng, at)          -- partition theo tháng
shipper_cod_ledger(id, shipper_id, shipment_id, type (COLLECT|REMIT|ADJUST), amount, at)
care_tickets(id, order_id, customer_id, type, lines jsonb, evidence_file_ids uuid[], status,
             auto_approved, resolution (CREDIT|REFUND|RESEND|REJECT), amount, handled_by, batch_ids uuid[])
reviews(id, order_id, customer_id, sku_id, rating, comment, photos uuid[], reply, status)
notifications(id, user_id, type, title, body, data jsonb, channel, sent_at, read_at)
files(id, owner_type, owner_id, kind, storage_key, sha256, bytes, captured_at, device_id, gps, created_by)
period_closes(id, period_type, period_start, period_end, status, checklist jsonb, closed_by, closed_at, reopened_by, reopen_reason)
```

### 12.3. Schema `reporting`, `audit`, `integration`

```
-- reporting (viewer_ro: SELECT; projector_rw: INSERT/UPDATE live_*, INSERT snapshot_*)
live_store_status, live_orders, live_sales_hourly, live_stock_levels, live_deliveries
snapshots, snapshot_sales_facts, snapshot_inventory_facts, snapshot_shrink_facts,
snapshot_delivery_facts, snapshot_pnl_lines, snapshot_purchase_facts, snapshot_files
published_cost_matrix   (đọc bởi publish engine; viewer không đọc trực tiếp)
viewer_profile_scope    (bản sao phạm vi profile để RLS dùng)

-- audit (audit_writer: INSERT only)
audit_logs(id, at, actor_id, actor_role, ip, device_id, action, resource_type, resource_id,
           before jsonb, after jsonb, reason, request_id)
login_logs(id, at, user_id, result, ip, device, method)
export_logs(id, at, user_id, export_type, filters jsonb, row_count, file_id, reason, watermark)
viewer_access_logs(id, at, user_id, viewer_profile_id, resource, snapshot_id)

-- integration
outbox_events(id, event_type, aggregate_type, aggregate_id, payload jsonb, occurred_at, published_at, attempts)
processed_events(consumer, event_id, processed_at)
webhook_inbox(id, provider, external_id UNIQUE(provider, external_id), headers jsonb, body jsonb,
              signature_ok, received_at, processed_at, result)
external_calls(id, provider, endpoint, request jsonb, response jsonb, status, latency_ms, at)
```

### 12.4. Ràng buộc & chỉ mục quan trọng

```sql
-- Sổ kho chỉ thêm
CREATE TRIGGER trg_stock_movements_immutable BEFORE UPDATE OR DELETE ON core.stock_movements
  FOR EACH ROW EXECUTE FUNCTION core.raise_immutable();

-- Snapshot bất biến
CREATE TRIGGER trg_snapshot_facts_immutable BEFORE UPDATE OR DELETE ON reporting.snapshot_sales_facts
  FOR EACH ROW EXECUTE FUNCTION core.raise_immutable();
-- (lặp lại cho các bảng snapshot_*; bảng snapshots chỉ cho UPDATE cột status qua function riêng)

-- Idempotency POS offline
CREATE UNIQUE INDEX ux_orders_client_txn ON core.orders(client_txn_id) WHERE client_txn_id IS NOT NULL;

-- Webhook không xử lý trùng
CREATE UNIQUE INDEX ux_webhook_provider_ext ON integration.webhook_inbox(provider, external_id);

-- Tìm FEFO nhanh
CREATE INDEX ix_balances_fefo ON core.stock_balances(location_id, sku_id) INCLUDE (on_hand_g, on_hand_units);
CREATE INDEX ix_batches_expiry ON core.inventory_batches(sku_id, status, expiry_date);

-- Đơn theo cửa hàng & trạng thái (màn hình soạn đơn)
CREATE INDEX ix_orders_store_status ON core.orders(store_id, status, placed_at);

-- Không cho tồn âm ở kho tổng
-- (kiểm tra trong service + CHECK ở stock_balances với location thuộc warehouse: dùng trigger)

-- Phân vùng theo tháng: stock_movements, order_events, shipment_tracks, audit_logs, outbox_events
```

**Quyền DB:**
```sql
CREATE ROLE app_rw LOGIN;        GRANT USAGE ON SCHEMA core, integration TO app_rw; -- + quyền bảng
CREATE ROLE audit_writer LOGIN;  GRANT USAGE ON SCHEMA audit TO audit_writer; GRANT INSERT ON ALL TABLES IN SCHEMA audit TO audit_writer;
CREATE ROLE projector_rw LOGIN;  GRANT USAGE ON SCHEMA reporting TO projector_rw; GRANT SELECT ON core.<cần thiết> TO projector_rw;
CREATE ROLE viewer_ro LOGIN;     GRANT USAGE ON SCHEMA reporting TO viewer_ro; GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO viewer_ro;
REVOKE ALL ON SCHEMA core FROM viewer_ro;
REVOKE SELECT ON reporting.published_cost_matrix FROM viewer_ro;
ALTER TABLE reporting.live_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_viewer_scope ON reporting.live_orders FOR SELECT TO viewer_ro
  USING (store_id = ANY (reporting.allowed_stores(current_setting('app.viewer_profile_id')::uuid)));
```

---

## Phần 13. API, sự kiện realtime & tích hợp

### 13.1. Quy ước API

- REST JSON, tiền tố phiên bản `/v1`. Nhóm route theo đối tượng gọi: `/v1/app/*` (khách), `/v1/pos/*` (cửa hàng), `/v1/admin/*` (Master & nhân sự văn phòng), `/v1/viewer/*` (Admin Chỉ Xem), `/v1/shipper/*`, `/v1/webhooks/*`.
- Mọi request ghi: `X-Request-Id`, `X-Device-Id`; thao tác ghi từ POS/App gửi `Idempotency-Key`.
- Lỗi chuẩn: `{ code, message, details, request_id }`; mã lỗi nghiệp vụ có danh mục (`STOCK_INSUFFICIENT`, `SHIFT_NOT_OPEN`, `APPROVAL_REQUIRED`, `PERIOD_LOCKED`…).
- Phân trang cursor; lọc/sắp xếp chuẩn.
- OpenAPI sinh tự động → sinh client Dart/TS.
- Mỗi route khai báo `@RequirePermission('orders:read', scope)`; guard kiểm tra vai trò + phạm vi + hạn mức.

### 13.2. Endpoint chính (rút gọn)

| Nhóm | Endpoint |
|---|---|
| Auth | `POST /auth/otp/request`, `POST /auth/otp/verify`, `POST /auth/login` (staff), `POST /auth/pin` (POS), `POST /auth/2fa/verify`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/step-up` |
| App – danh mục | `GET /app/stores/resolve?lat&lng`, `GET /app/catalog`, `GET /app/products/:id` (kèm ATP trạng thái, lô hiển thị), `GET /app/search` |
| App – giỏ & đơn | `POST /app/cart/quote` (tính giá tạm, ship, khuyến mãi), `POST /app/orders`, `GET /app/orders/:id`, `POST /app/orders/:id/confirm-variance`, `POST /app/orders/:id/cancel`, `POST /app/orders/:id/gift-preview/decision` |
| App – thanh toán | `POST /app/orders/:id/payments` (tạo VietQR), `GET /app/payments/:id` |
| App – tài khoản | `/app/me`, `/app/addresses`, `/app/loyalty`, `/app/credits`, `/app/vouchers`, `/app/privacy/requests`, `DELETE /app/me` |
| App – bảo hành | `POST /app/care-tickets`, `GET /app/care-tickets/:id` |
| POS – ca | `POST /pos/shifts/open`, `POST /pos/shifts/:id/close`, `GET /pos/shifts/:id/x-report`, `POST /pos/cash-movements` |
| POS – bán | `POST /pos/sales` (chốt hóa đơn, idempotent), `POST /pos/sales/:id/void`, `POST /pos/sales/:id/refund`, `POST /pos/barcode/parse` (cũng chạy được offline phía client) |
| POS – đồng bộ | `GET /pos/sync/catalog?since=`, `POST /pos/sync/upload` (lô giao dịch offline) |
| POS – fulfillment | `GET /pos/fulfillment/queue`, `POST /pos/orders/:id/accept|reject|start-pick`, `POST /pos/orders/:id/lines/:lineId/weigh`, `POST /pos/orders/:id/substitute`, `POST /pos/orders/:id/pack`, `POST /pos/orders/:id/dispatch` |
| POS – kho cửa hàng | `GET /pos/ripeness-tasks`, `POST /pos/ripeness-checks`, `POST /pos/shrinkage`, `POST /pos/processing-orders`, `POST /pos/stocktakes`, `POST /pos/transfers/:id/receive`, `GET /pos/markdowns/proposals`, `POST /pos/markdowns/:id/approve` |
| Kho | `POST /admin/purchase-orders`, `POST /admin/goods-receipts`, `POST /admin/landed-costs`, `POST /admin/transfers`, … |
| Admin | CRUD theo module §10.7; `POST /admin/approvals/:id/approve|reject`; `POST /admin/exports` (step-up) |
| Publish | `POST /admin/publish/drafts`, `GET /admin/publish/drafts/:id/preview`, `POST /admin/publish/drafts/:id/publish` (step-up), `POST /admin/snapshots/:id/revoke`, `CRUD /admin/viewer-profiles`, `GET /admin/viewer-profiles/:id/impersonate-view` |
| Viewer | `GET /viewer/live/*`, `GET /viewer/snapshots`, `GET /viewer/snapshots/:id/*`, `POST /viewer/exports`, `GET /viewer/files/:id` |
| Shipper | `GET /shipper/jobs`, `POST /shipper/jobs/:id/pickup|deliver|fail`, `POST /shipper/location` |
| Webhooks | `POST /webhooks/payments/:provider`, `POST /webhooks/couriers/:provider`, `POST /webhooks/einvoice/:provider` |

### 13.3. Danh mục sự kiện (outbox → consumers)

| Sự kiện | Phát khi | Consumer |
|---|---|---|
| `order.placed` | Đơn tạo (đã giữ hàng) | Realtime cửa hàng (chuông), projection, notification khách |
| `order.status_changed` | Mọi chuyển trạng thái | Projection, realtime khách/cửa hàng/viewer, notification |
| `order.weighed` | Chốt cân xong | Notification khách (ảnh + số tiền), payment (tạo QR nếu M2) |
| `order.variance_confirmation_required` | Vượt ngưỡng | Notification khách, timer timeout |
| `payment.succeeded` / `payment.failed` / `payment.mismatch` | Webhook đã xác minh | Order service, realtime, đối soát |
| `sale.completed` | Hóa đơn POS chốt | Projection, einvoice, loyalty (pending) |
| `einvoice.failed` | Phát hành lỗi | Cảnh báo Master |
| `stock.movement_recorded` | Mỗi movement | Projection tồn, ATP cache, cảnh báo tồn thấp |
| `stock.negative_detected` | Tồn âm | Cảnh báo |
| `batch.stage_changed` | Đổi giai đoạn độ chín | Markdown engine, app (Ăn ngon hôm nay) |
| `markdown.activated` | Duyệt markdown | Giá app, in tem |
| `shrinkage.approved` | Duyệt hủy | Projection |
| `shift.closed` | Đóng ca | Báo cáo ca, cảnh báo chênh lệch |
| `shipment.status_changed` / `shipment.location` | Shipper/3PL | Realtime khách & viewer |
| `device.offline` / `device.calibration_expiring` | Heartbeat/lịch | Cảnh báo |
| `snapshot.published` / `snapshot.revoked` | Publish Gate | Notification viewer |
| `period.closed` / `period.reopened` | Khóa sổ | Publish engine |

### 13.4. Tích hợp thanh toán VietQR (qua cổng trung gian)

**Lựa chọn cổng:** SePay, payOS (của Casso)… — các cổng này kết nối tài khoản ngân hàng và gửi webhook khi có tiền vào. SePay có **VA (tài khoản ảo) theo đơn hàng**: mỗi đơn một VA riêng với số tiền khớp chính xác, giúp khớp tự động chắc chắn hơn so với khớp theo nội dung chuyển khoản. Quyết định Q4.

**Luồng:**
1. Backend tạo `payments` (`PENDING`, `payment_code` duy nhất dạng `MF{shortid}`, `amount`, `expires_at`).
2. Gọi cổng tạo QR (hoặc tự sinh payload VietQR theo chuẩn EMVCo nếu dùng khớp theo nội dung) → trả `qr_payload`.
3. Khách quét, chuyển khoản.
4. Cổng gọi `POST /webhooks/payments/{provider}`:
   - Ghi `webhook_inbox` (unique theo mã giao dịch của cổng) → **trùng thì bỏ qua**.
   - Xác thực chữ ký/API key; kiểm tra timestamp để **chống replay** (Casso khuyến nghị hệ thống xử lý webhook phải chống tấn công replay).
   - (Tùy chọn, khuyến nghị với số tiền lớn) gọi API tra cứu giao dịch của cổng để xác nhận lại.
   - Khớp `payment_code`/VA → so số tiền → `SUCCEEDED` / `PARTIAL` / thừa → phát `payment.*`.
   - Trả 200 nhanh; xử lý nặng đưa vào queue.
5. Không khớp được → `unmatched_bank_txns` → màn hình khớp tay cho kế toán.
6. Job đối soát hằng ngày gọi API lịch sử giao dịch của cổng để bắt giao dịch webhook bị lỡ (Casso tự tắt cấu hình webhook nếu bị tạm dừng 7 ngày không xử lý — cần giám sát webhook sống).

### 13.5. Tích hợp hóa đơn điện tử

- Adapter `EInvoiceProvider { issue(order), cancel(), replace(), adjust(), getStatus() }`.
- Gửi bất đồng bộ qua queue; retry backoff; giám sát hàng đợi.
- Lưu nguyên request/response để đối chứng.

### 13.6. Tích hợp bản đồ & 3PL

- `MapProvider { geocode(), reverseGeocode(), routeDistance(origin, dest) }` — cache kết quả.
- `CourierAdapter` như §8.9.3.

### 13.7. OTP & tin nhắn

- `OtpProvider` (SMS brandname / Zalo ZNS) — giới hạn tần suất, mã 6 số, hết hạn 3–5 phút, tối đa 5 lần nhập sai.
- Ghi chi phí gửi để theo dõi.

---

## Phần 14. Kiểm soát gian lận & nhật ký kiểm toán

### 14.1. Kịch bản gian lận thường gặp & kiểm soát

| # | Kịch bản | Kiểm soát |
|---|---|---|
| F1 | Thu ngân cân, thu tiền mặt, rồi **xóa dòng** sau khi khách đi | Log dòng đã cân bị xóa; báo cáo tỷ lệ theo thu ngân; camera quầy đối chiếu thời gian (ghi timestamp chính xác) |
| F2 | Thu ngân **chọn sai SP rẻ hơn** cho người quen | Cảnh báo trọng lượng ngoài khoảng chuẩn; màn hình phụ hướng khách; báo cáo cơ cấu SP theo thu ngân bất thường |
| F3 | Nhập cân tay thấp hơn thực | Nhập tay cần PIN quản lý + lý do; báo cáo |
| F4 | Đánh dấu hàng tốt thành "hỏng" để mang về | Ảnh chụp trực tiếp có watermark + hash; duyệt bởi người khác; thống kê hủy theo nhân viên/ca; đối chiếu với hồ sơ lô (lô mới về mà hủy nhiều → cảnh báo) |
| F5 | Đánh dấu "cận hạn" rồi tự mua giá rẻ | Cấm mua hàng markdown trong ca; người đề xuất ≠ người duyệt; báo cáo |
| F6 | Mở két lấy tiền | Mở két không bán cần PIN + lý do; đếm mù cuối ca |
| F7 | Shipper giữ tiền COD | Sổ công nợ COD theo shipper; chặn nhận chuyến mới khi nợ vượt hạn mức |
| F8 | Khách lạm dụng bảo hành 24h | Giới hạn tần suất/giá trị, ảnh chụp trực tiếp, lịch sử khiếu nại, duyệt tay khi vượt ngưỡng |
| F9 | Lạm dụng voucher khách mới, referral | Giới hạn theo thiết bị/SĐT/địa chỉ (tái sử dụng logic chống gian lận referral đã có) |
| F10 | Nhân viên kho khai khống trọng lượng nhận/giá nhập | Người nhận ≠ người nhập giá; đối chiếu hóa đơn NCC; so giá với lịch sử ± ngưỡng → cảnh báo |
| F11 | Chênh lệch điều chuyển "biến mất" | Hai bên cân, ảnh, trạng thái in-transit có thời hạn |
| F12 | Webhook thanh toán giả | Xác thực chữ ký, chống replay, tra cứu lại |
| F13 | Admin tự sửa số rồi xóa dấu vết | Audit log chỉ-thêm ở schema riêng; chỉ OWNER xem log của Master; xuất định kỳ ra lưu trữ ngoài (bản sao chỉ đọc) |

### 14.2. Nhật ký kiểm toán

- Ghi mọi thao tác ghi (create/update/void/approve) trên `core` với `before/after`.
- Ghi mọi lần xem dữ liệu nhạy cảm: hồ sơ khách đầy đủ, giá nhập, xuất file, "xem như viewer".
- Lưu tối thiểu theo thời hạn lưu chứng từ (cấu hình), không xóa qua ứng dụng.
- Màn hình tra cứu: lọc theo người, thời gian, loại tài nguyên, mã chứng từ.

---

## Phần 15. Yêu cầu phi chức năng

### 15.1. Hiệu năng & dung lượng (mục tiêu ban đầu)

| Chỉ số | Mục tiêu |
|---|---|
| API p95 (đọc) | ≤ 300 ms |
| API p95 (chốt hóa đơn POS) | ≤ 500 ms |
| Realtime p95 | ≤ 3 s |
| Quy mô thiết kế | 20 cửa hàng, 5.000 hóa đơn/ngày, 1.000 đơn online/ngày, 200.000 khách |
| Dashboard viewer | Đọc từ bảng tổng hợp sẵn, không query trực tiếp bảng giao dịch lớn |

### 15.2. Sẵn sàng & phục hồi

- POS bán được khi mất mạng (§7.11).
- Mục tiêu uptime backend 99,5%/tháng (hạ tầng phổ thông).
- **RPO ≤ 5 phút** (PITR/WAL archiving), **RTO ≤ 4 giờ**.
- Sao lưu hằng ngày lưu ở **nhà cung cấp/khu vực khác** với DB chính; **diễn tập khôi phục mỗi quý** (kinh nghiệm: dịch vụ hết hạn trial có thể ngừng hoạt động bất ngờ — sao lưu độc lập là bắt buộc).
- Ảnh/file: bucket có versioning.

### 15.3. Bảo mật

- HTTPS mọi nơi; HSTS cho web.
- Bí mật (khóa API cổng thanh toán, HĐĐT, khóa mã hóa) trong biến môi trường/secret manager — không commit.
- Mã hóa PII (§2.3 L3.7); khóa mã hóa xoay vòng được.
- Rate limit theo IP/user/thiết bị; chống brute-force OTP/PIN.
- Kiểm tra phụ thuộc (npm audit/Dependabot); cập nhật bản vá.
- Upload file: kiểm tra MIME, giới hạn kích thước, tạo URL tải có hạn.
- Ứng dụng di động: không lưu token dạng plain (Keychain/Keystore), cấu hình SSL đúng.

### 15.4. Quan sát hệ thống (Observability)

- Log có cấu trúc (JSON) kèm `request_id`.
- Error tracking (Sentry hoặc tương đương) cho backend + Flutter + Next.js.
- Metrics: độ dài hàng đợi outbox/einvoice/webhook, tỷ lệ lỗi tích hợp, số POS offline, độ trễ projection.
- Cảnh báo (Telegram/Zalo/email) cho: HĐĐT PENDING quá hạn, webhook thanh toán ngừng, POS offline > 10 phút giờ bán hàng, DB gần đầy, lỗi 5xx tăng.

### 15.5. Kiểm thử

- Unit test bắt buộc cho: tính tiền catch-weight & làm tròn, giải mã barcode, phân bổ FEFO, giá vốn, khuyến mãi, máy trạng thái đơn, quyền & hạn mức.
- Integration test: luồng đơn đầy đủ với cổng thanh toán giả lập (sandbox), webhook trùng/đến muộn/sai số tiền.
- Test thiết bị thật: từng model cân, máy in, két (danh sách thiết bị được hỗ trợ chính thức).
- Test offline POS: rút mạng giữa giao dịch, đồng bộ lại, kiểm tra không trùng.

### 15.6. Khả năng sử dụng

- POS: nút lớn cho màn cảm ứng, phím tắt bàn phím, chế độ tương phản cao, hoạt động tốt trên màn 15".
- Tất cả giao diện tiếng Việt; số tiền định dạng `1.250.000đ`, cân `0,845 kg`.
- App khách: hoạt động tốt trên máy Android tầm thấp; ảnh nén (WebP), cache.

---

## Phần 16. Lộ trình triển khai

> Ước tính cho **1 lập trình viên fullstack**, làm toàn thời gian, đã có kinh nghiệm stack. Mỗi giai đoạn kết thúc bằng một bản **dùng được thật** để vận hành thử, thay vì làm hết rồi mới chạy.

| Giai đoạn | Thời lượng | Phạm vi | Kết quả vận hành được |
|---|---|---|---|
| **G0. Nền móng** | 2–3 tuần | Repo, CI, Docker, schema `core` cơ bản, auth (staff/khách/PIN/2FA), RBAC + scope, audit log, outbox, file upload, shared_models, khung Admin Web | Đăng nhập, quản lý người dùng & vai trò |
| **G1. Danh mục + Kho cơ bản** | 3–4 tuần | Sản phẩm/SKU/kiểu bán, bảng giá, NCC, phiếu nhận hàng có cân/bì/QC, lô, sổ kho, điều chuyển, kiểm kê đơn giản, phiếu hủy có ảnh | Kho tổng nhập hàng & chuyển xuống cửa hàng trên hệ thống |
| **G2. POS tại quầy** | 5–6 tuần | Ca, bán hàng, đọc cân (1–2 model đang dùng), barcode cân, in phiếu ESC/POS, két, màn hình phụ, VietQR + webhook, tiền mặt, hủy/trả, offline cơ bản, HĐĐT máy tính tiền, Z-report | **Cửa hàng bán hàng thật bằng hệ thống mới** (mốc quan trọng nhất) |
| **G3. App Khách + Fulfillment** | 6–8 tuần | Catalog, tùy chọn độ chín/sơ chế, giỏ, checkout, tạm tính, phân bổ cửa hàng, giữ hàng, màn soạn đơn (cân + ảnh), xác nhận chênh lệch, 3 chế độ thanh toán, shipper nội bộ, theo dõi đơn, push, xóa tài khoản, đồng ý dữ liệu, hạng thành viên + voucher (không điểm — D11) | Nhận đơn online thật |
| **G4. Admin 2 tầng + Báo cáo** | 4–5 tuần | Dashboard Master, kiểm toán POS, viewer profiles, schema `reporting` + projection R1, khóa kỳ, Publish Gate (R2/R3), snapshot + PDF/Excel, Admin Chỉ Xem web, KPI chính | Lãnh đạo/đối tác dùng Admin Chỉ Xem |
| **G5. Nghiệp vụ nâng cao** | 4–6 tuần | Độ chín QC task + markdown engine, sơ chế & yield, BOM giỏ quà + trình tạo giỏ quà, landed cost, công nợ NCC, rebate, đề xuất đặt hàng, khuyến mãi đầy đủ, bảo hành 24h, 3PL adapter, khung giờ | Tối ưu hao hụt & biên lãi |
| **G6. Mở rộng** | liên tục | B2B, pre-order mùa, Admin Mobile, app shipper riêng, tích hợp kế toán, đồng bộ PLU tự động với cân, dự báo tốt hơn | — |

**Tổng đến hết G5: khoảng 24–32 tuần (6–8 tháng).** Có thể rút ngắn bằng cách dùng nhà cung cấp có sẵn cho HĐĐT/thanh toán/OTP và giới hạn số model thiết bị hỗ trợ ban đầu.

**Rủi ro lịch cần lưu ý:** tích hợp phần cứng (mỗi hãng cân một kiểu), duyệt app trên App Store, đăng ký tài khoản đối tác cổng thanh toán/3PL/HĐĐT (thủ tục mất vài ngày đến vài tuần — **làm song song ngay từ G0**), mùa cao điểm (Tết) không nên chuyển đổi hệ thống.

---

## Phần 17. Kịch bản kiểm thử nghiệm thu

| # | Kịch bản | Kết quả mong đợi |
|---|---|---|
| T01 | Bán 0,845 kg nho giá 320.000đ/kg tại quầy | Thành tiền 270.400đ; trừ 845 g từ lô FEFO; HĐĐT phát hành; phiếu in đúng |
| T02 | Quét tem `2000123008455` (PLU 00123, 845 g, checksum đúng) | Nhận đúng SKU, 845 g; tem checksum sai → báo lỗi |
| T03 | Rút cáp cân giữa ca | POS báo mất kết nối; nhập tay chỉ được khi có PIN quản lý; dòng đánh dấu MANUAL |
| T04 | Rút mạng, bán 10 hóa đơn tiền mặt, cắm lại | 10 hóa đơn đồng bộ, không trùng khi gửi lại 2 lần; HĐĐT phát hành bù |
| T05 | VietQR: khách chuyển thiếu 10.000đ | Đơn PARTIALLY_PAID, POS yêu cầu thu thêm |
| T06 | Webhook thanh toán gửi trùng 3 lần | Chỉ ghi nhận 1 lần |
| T07 | Đơn app dưa lưới tạm tính 1,80 kg, cân thực 1,92 kg (+6,7%) với ngưỡng xác nhận 5% | Đơn vào AWAITING_CUSTOMER_CONFIRM; khách thấy ảnh + số tiền 182.400đ; đồng ý → trả thêm 11.400đ qua VietQR |
| T08 | Như T07 nhưng cân thực 1,85 kg (+2,8%) với `absorb_over_pct` 3% | Không hỏi khách; cửa hàng chịu 4.750đ, ghi `cw_absorbed_amount` |
| T09 | Cân thực nhẹ hơn tạm tính 15.000đ (đơn trả trước) | Hoàn 15.000đ credit, thông báo khách |
| T10 | Hết Táo Envy size 24 khi soạn, khách chọn "cho phép thay thế" | Hệ thống gợi ý SKU thay thế trong danh sách; ghi substitution; thông báo khách |
| T11 | Đóng ca: đếm mù 5.230.000đ, lý thuyết 5.250.000đ | Hiển thị chênh −20.000đ sau khi xác nhận; không cho nhập lại; yêu cầu lý do nếu vượt ngưỡng |
| T12 | Thu ngân xóa dòng đã cân sau khi in phiếu tạm tính | Log void có số cân; xuất hiện trong báo cáo kiểm toán POS |
| T13 | Nhân viên tạo phiếu hủy 2.000.000đ giá vốn, cửa hàng trưởng hạn mức 1.000.000đ | Phiếu chờ OPS/Master duyệt |
| T14 | Tài khoản Admin Chỉ Xem gọi `GET /v1/admin/orders` | 403 |
| T15 | Admin Chỉ Xem profile `cost_visibility = NONE` mở báo cáo doanh thu | Không có cột giá vốn/lãi gộp ở cả API lẫn file tải |
| T16 | Kết nối DB bằng role `viewer_ro` chạy `SELECT * FROM core.orders` | Lỗi permission denied |
| T17 | Master phát hành snapshot tháng với cơ sở ĐỊNH MỨC | Viewer thấy nhãn "Giá vốn định mức", phiên bản v1; phát hành lại → v2 thay thế v1, v1 vẫn xem được với dấu "đã thay thế" |
| T18 | Sửa chứng từ trong kỳ đã khóa | Bị chặn `PERIOD_LOCKED` |
| T19 | Kiểm kê cuối tuần: nho hao 2,1% với định mức 3% | Tự phân loại NATURAL_SHRINK, tự duyệt |
| T20 | Kiểm kê: cherry hao 9% với định mức 3% | ABNORMAL, cần giải trình + duyệt |
| T21 | Lô xoài chuyển S4, rule đề xuất giảm 25%, giá sàn ở mức giảm 20% | Đề xuất bị giới hạn 20% hoặc cần Master duyệt |
| T22 | Khách yêu cầu xóa tài khoản | PII ẩn danh hóa; hóa đơn giữ lại với thông tin đã che; đăng nhập lại bằng SĐT cũ tạo tài khoản mới |
| T23 | Master xuất danh sách khách | Bắt buộc step-up 2FA + lý do; file có watermark; có dòng trong export_logs |
| T24 | Cân hết hạn kiểm định | POS cảnh báo đỏ; Master nhận cảnh báo trước 30 ngày |
| T25 | Sinh 5 hóa đơn cùng `client_txn_id` từ 2 quầy (lỗi client) | Chỉ 1 hóa đơn được tạo |
| T26 | Phân bổ đơn khi cửa hàng gần nhất thiếu 1 món | Chọn cửa hàng khác đủ hàng nếu trong vùng, hoặc đưa lựa chọn cho khách |
| T27 | Giỏ quà ngân sách 1.500.000đ, thay thành phần làm giá vốn vượt dung sai | Cảnh báo, cần cửa hàng trưởng xác nhận |
| T28 | Phiếu sơ chế 5 kg dưa hấu → 12 khay, yield thực 60% vs chuẩn 68% | Cảnh báo yield thấp; giá vốn khay tính đúng |

---

## Phần 18. Các quyết định cần chốt

16 quyết định đã chốt ngày 17/11/2026 — xem **§0.4**. Các điểm còn mở:

| # | Câu hỏi | Ai quyết | Hạn nên chốt |
|---|---|---|---|
| O1 | Loại HĐĐT cho bán lẻ của công ty (có mã / khởi tạo từ máy tính tiền), ký hiệu theo cửa hàng | Kế toán | Trước G2 |
| O2 | Tỷ lệ thuế từng nhóm hàng | Kế toán | Trước G2 |
| O3 | Hạch toán credit cửa hàng & rebate NCC | Kế toán | Trước G3 |
| O4 | Model cân quầy, cân in tem, máy in, két | Chủ dự án | Trước G2 (mua mẫu để test) |
| O5 | Đối tác 3PL đầu tiên | Chủ dự án | Trước G3 |
| O6 | Ngân hàng nhận tiền hỗ trợ VA của SePay | Chủ dự án | G0 (thủ tục song song) |
| O7 | Mẫu phiếu in, logo, tên thương hiệu | Chủ dự án | Trước G2 |
| O8 | Mô hình credit cửa hàng có cần luật sư rà soát | Luật sư | Trước G3 |

---

## Phụ lục

### Phụ lục A. Công thức tính tiền

```text
// Dòng catch-weight
line_amount = round_half_up(price_per_kg * weight_g / 1000)              // đồng
// Làm tròn hiển thị (tùy cấu hình) đến 100đ:
line_amount_100 = round_half_up(line_amount / 100) * 100

// Ví dụ: 95.000 × 1.920 / 1000 = 182.400 ; 320.000 × 845 / 1000 = 270.400

// Chênh lệch catch-weight (đơn trả trước)
diff = actual_subtotal - est_subtotal
if diff <= 0: refund_credit = -diff
elif diff <= min(est_subtotal * absorb_over_pct, absorb_over_max_amount): absorbed = diff
elif variance_pct > confirm_threshold_pct or diff > confirm_threshold_amount: require_confirmation
else: collect_extra = diff   // theo chính sách
```

### Phụ lục B. Giải mã EAN-13 mã cân

```text
Ví dụ mẫu W1: 2 0 | 0 0 1 2 3 | 0 0 8 4 5 | C
  prefix  = "20"           (20–29: lưu hành nội bộ)
  plu     = "00123"
  weight  = 00845 gram = 0,845 kg

Checksum EAN-13 (12 số đầu d1..d12, tính từ trái):
  S = (d1 + d3 + d5 + d7 + d9 + d11) * 1 + (d2 + d4 + d6 + d8 + d10 + d12) * 3
  C = (10 - (S mod 10)) mod 10

Với 200012300845: lẻ = 2+0+1+3+0+4 = 10 ; chẵn = 0+0+2+0+8+5 = 15 → S = 10 + 45 = 55 → C = 5
→ Mã đầy đủ: 2000123008455
```

### Phụ lục C. Lệnh ESC/POS thường dùng

| Mục đích | Lệnh (hex) |
|---|---|
| Khởi tạo | `1B 40` |
| Căn giữa / trái | `1B 61 01` / `1B 61 00` |
| Chữ đậm bật/tắt | `1B 45 01` / `1B 45 00` |
| Cỡ chữ gấp đôi | `1D 21 11` |
| In ảnh raster | `1D 76 30 00 xL xH yL yH [data]` |
| QR native (model 2) | chuỗi `1D 28 6B …` (chọn model, kích thước module, mức sửa lỗi, nạp dữ liệu, in) |
| Cắt giấy | `1D 56 42 00` |
| Mở két (chân 2) | `1B 70 00 19 FA` |

> Kiểm tra trên máy thật: hỗ trợ QR native, code page tiếng Việt, tốc độ in ảnh. Nếu font tiếng Việt lỗi → render toàn bộ phiếu thành ảnh (chậm hơn nhưng chắc chắn).

### Phụ lục D. Mẫu nội dung chuyển khoản / mã thanh toán

```text
payment_code: MF + 8 ký tự base32 không nhầm lẫn (bỏ 0/O, 1/I/L) → ví dụ MF7KQ2XH9
Nội dung CK : "MF7KQ2XH9"   (ngắn, không dấu, không ký tự đặc biệt — một số ngân hàng cắt/đổi nội dung)
Hiệu lực    : 15 phút (đơn app), 5 phút (POS) — gia hạn được
```

### Phụ lục E. Danh mục mã lý do (khởi tạo)

| Nhóm | Mã |
|---|---|
| Hủy hàng | `DAMAGED_TRANSPORT`, `OVERRIPE`, `ROTTEN`, `PEST`, `EXPIRED`, `SUPPLIER_DEFECT`, `CUSTOMER_RETURN`, `OTHER` |
| Xóa dòng POS | `CUSTOMER_CHANGED_MIND`, `WRONG_ITEM`, `WRONG_WEIGHT`, `PRICE_DISPUTE`, `OTHER` |
| Hủy đơn | `CUSTOMER_REQUEST`, `OUT_OF_STOCK`, `PAYMENT_TIMEOUT`, `STORE_OVERLOAD`, `ADDRESS_INVALID`, `FRAUD_SUSPECT` |
| Giao thất bại | `NO_ANSWER`, `WRONG_ADDRESS`, `CUSTOMER_REFUSED`, `DAMAGED_IN_TRANSIT`, `WEATHER` |
| Chênh lệch kiểm kê | `NATURAL_SHRINK`, `MISCOUNT_PREVIOUS`, `UNRECORDED_SPOILAGE`, `UNRECORDED_SAMPLING`, `THEFT_SUSPECTED`, `UNKNOWN` |
| Nhập cân tay | `SCALE_DISCONNECTED`, `SCALE_ERROR`, `ITEM_TOO_LARGE`, `OTHER` |

### Phụ lục F. Nguồn tham khảo pháp lý & kỹ thuật

- NĐ 70/2025/NĐ-CP — HĐĐT khởi tạo từ máy tính tiền với hộ kinh doanh doanh thu từ 1 tỷ: https://thuvienphapluat.vn/ma-so-thue/bai-viet/nhung-rui-ro-khi-khong-dang-ky-su-dung-hoa-don-tu-may-tinh-tien-929016-203985.html · https://www.meinvoice.vn/?p=33441
- Thời điểm lập HĐĐT máy tính tiền (Sapo hỏi–đáp NĐ 70): https://www.sapo.vn/blog/giai-dap-chi-tiet-nd70-2025-nd-cp-phan-2
- Nhiều địa điểm kinh doanh ghi địa chỉ từng điểm: https://thuvienphapluat.vn/hoi-dap-phap-luat/ho-kinh-doanh-co-doanh-thu-1-ty-dong-tro-len-phai-ap-dung-hoa-don-dien-tu-dung-khong-138082541.html
- Bỏ thuế khoán từ 01/01/2026 (NQ 198/2025/QH15): https://www.meinvoice.vn/tin-tuc/33465/xoa-bo-thue-khoan-ho-kinh-doanh/ · https://www.misaeshop.vn/?p=30699
- Luật BVDLCN 91/2025/QH15: https://vneconomy.vn/nhung-diem-moi-trong-luat-bao-ve-du-lieu-ca-nhan-tu-112026.htm · https://thitruongtaichinhtiente.vn/print/75881.html
- NĐ 356/2025/NĐ-CP (EY): https://www.ey.com/content/dam/ey-unified-site/ey-com/vi-vn/technical/tax/documents/ey-vietnam-legal-alert-march-2026-decree-no356-2025-nd-cp-providing-detailed-guidance-for-implementation-of-personal-data-protection-law-viet.pdf
- Miễn trừ cho hộ kinh doanh/doanh nghiệp nhỏ (GV Lawyers): https://gvlawyers.com.vn/wp-content/uploads/2025/09/VN_Legal-alert-_Law-on-PDP-2025.pdf
- NĐ 52/2024/NĐ-CP — ví điện tử, tiền điện tử: https://vnba.org.vn/vi/vi-dien-tu-duoc-cung-ung-tien-dien-tu-14817.htm · https://znews.vn/chinh-phu-bo-sung-quy-dinh-ve-tien-dien-tu-post1476723.html
- Kiểm định phương tiện đo nhóm 2 (cân): https://tanhoa.vinhlong.gov.vn/Portals/1268/30_3_26_CV%20tuyen%20truyen%20ve%20kiem%20dinh%20Can%20thong%20dung_signed_signed.pdf · https://thuvienphapluat.vn/van-ban/Linh-vuc-khac/Thong-tu-04-2026-TT-BKHCN-sua-doi-van-ban-linh-vuc-tieu-chuan-do-luong-chat-luong-696515.aspx?tab=4
- SePay VA theo đơn hàng: https://docs.sepay.vn/api-va-theo-don-hang.html · Tạo trang QR + webhook: https://developer.sepay.vn/vi/sepay-webhooks/tao-qr-va-form-thanh-toan
- Casso/payOS webhook (chống replay, tự tắt sau 7 ngày): https://developer.casso.vn/webhook/thiet-lap-webhook-thu-cong

> Các thông tin pháp lý trên được tổng hợp đến 17/11/2026 và có thể thay đổi — cần kế toán/luật sư xác nhận trước khi vận hành.

---
*Hết tài liệu — Đặc tả hệ thống v2.0*
