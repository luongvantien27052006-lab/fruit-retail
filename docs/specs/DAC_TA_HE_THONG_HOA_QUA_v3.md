# ĐẶC TẢ HỆ THỐNG v3.0 — CHUỖI BÁN LẺ HOA QUẢ

> **Phiên bản:** 3.2 — 17/11/2026 · Bản chốt để bắt đầu code, đã đối chiếu KiotViet & Odoo (§21) (v2.1 giữ lại làm tài liệu tham khảo)
> **Stack:** NestJS · PostgreSQL · Redis · Next.js (Admin Web) · Flutter (App người dùng, POS Windows, tablet Android)
> **Ngoài phạm vi phần mềm:** mọi việc về thuế, hóa đơn, kê khai, giấy tờ pháp lý — công ty tự thực hiện. Hệ thống chỉ cung cấp số liệu xuất ra Excel khi cần.

---

## MỤC LỤC

1. [Phạm vi & các quyết định đã chốt](#1-phạm-vi--các-quyết-định-đã-chốt)
2. [Vai trò & phân quyền](#2-vai-trò--phân-quyền)
3. [Kiến trúc kỹ thuật](#3-kiến-trúc-kỹ-thuật)
4. [Dữ liệu danh mục](#4-dữ-liệu-danh-mục)
5. [Kho, lô hàng, giá nhập, hao hụt](#5-kho-lô-hàng-giá-nhập-hao-hụt)
6. [POS tại quầy](#6-pos-tại-quầy)
7. [App người dùng: thông báo & mặt hàng đẩy](#7-app-người-dùng-thông-báo--mặt-hàng-đẩy)
8. [Đơn app trong vùng giao & giao hàng](#8-đơn-app-trong-vùng-giao--giao-hàng)
9. [Đơn bán sỉ / khách doanh nghiệp](#9-đơn-bán-sỉ--khách-doanh-nghiệp)
10. [Trang quản lý: Master Admin & Admin Chỉ Xem](#10-trang-quản-lý-master-admin--admin-chỉ-xem)
11. [Báo cáo & KPI](#11-báo-cáo--kpi)
12. [Cơ sở dữ liệu](#12-cơ-sở-dữ-liệu)
13. [API, sự kiện, tích hợp](#13-api-sự-kiện-tích-hợp)
14. [Kiểm soát gian lận & nhật ký](#14-kiểm-soát-gian-lận--nhật-ký)
15. [Yêu cầu phi chức năng](#15-yêu-cầu-phi-chức-năng)
16. [Lộ trình triển khai](#16-lộ-trình-triển-khai)
17. [Kịch bản nghiệm thu](#17-kịch-bản-nghiệm-thu)
18. [Kết quả xử lý các việc còn mở](#18-kết-quả-xử-lý-các-việc-còn-mở)
19. [Khởi động dự án](#19-khởi-động-dự-án)
20. [Phụ lục](#20-phụ-lục)
21. [Bổ sung từ đối chiếu KiotViet & Odoo](#21-bổ-sung-từ-đối-chiếu-kiotviet--odoo-v32)

---

## 1. Phạm vi & các quyết định đã chốt

### 1.1. Hệ thống gồm 4 ứng dụng + 1 backend

| Mã | Ứng dụng | Người dùng | Nền tảng | Vai trò chính |
|---|---|---|---|---|
| A1 | **App người dùng** | Khách hàng | Flutter iOS/Android | Nhận thông báo; xem **mặt hàng được đẩy**; đặt mua & giao tận nơi **chỉ trong vùng đã chọn** |
| A2 | **POS cửa hàng** | Thu ngân, cửa hàng trưởng, nhân viên soạn đơn | Flutter Windows (quầy) + Flutter Android (tablet) | Bán tại quầy có cân; soạn đơn app; nhận hàng, kiểm kê, hủy hàng tại cửa hàng; **đồng bộ doanh thu về trang quản lý** |
| A3 | **App kho** (module của A2 trên tablet) | Nhân viên kho tổng | Flutter Android | Nhập hàng NCC (cân, bì, QC), tạo lô, điều chuyển xuống cửa hàng |
| A4 | **Trang quản lý** | Master Admin, Admin Chỉ Xem | Next.js (web) — responsive dùng được trên điện thoại | Master: báo cáo doanh thu, giá nhập/xuất, lên đơn bán sỉ, cấu hình, đẩy hàng & thông báo, phát hành báo cáo. Viewer: chỉ xem |
| A5 | **App shipper** (module nhỏ) | Shipper nội bộ | Flutter Android | Nhận chuyến, cập nhật trạng thái, ảnh giao hàng, thu COD |
| B1 | **Backend** | — | NestJS + PostgreSQL + Redis trên VPS | Một nguồn dữ liệu duy nhất cho tất cả |

### 1.2. Những gì ĐÃ BỎ so với v2.1

| Đã bỏ | Lý do |
|---|---|
| Toàn bộ phần thuế, hóa đơn điện tử (MISA), kê khai, nhóm thuế, sổ doanh thu kê khai, khóa kỳ theo thuế | Công ty tự làm |
| Mục pháp lý chi tiết (luật dữ liệu cá nhân, ví điện tử, kiểm định cân…) | Giữ lại **chỉ yêu cầu kỹ thuật tối thiểu** ở §7.8 và §4.6 |
| App khách dạng siêu thị online (danh mục đầy đủ, tìm kiếm, giỏ quà tự thiết kế, đánh giá) | App chỉ để thông báo + bán **mặt hàng được đẩy** |
| Điểm thưởng, hạng thành viên, engine khuyến mãi nhiều tầng, referral | Không cần cho mô hình mới |
| Vai trò kế toán, CSKH, thu mua, quản lý vận hành riêng | Gộp vào Master Admin |
| Admin Mobile riêng (Flutter) | Trang quản lý web responsive là đủ |
| Đề xuất đặt hàng tự động, dự báo | Để sau |

### 1.3. Hoãn lại — làm sau (đã có chỗ trong thiết kế)

| Mã | Nội dung | Ghi chú |
|---|---|---|
| H1 | **"Đăng ký điểm bán"** trên app | Đã có **định nghĩa đề xuất** ở §7.6 (khách đăng ký cửa hàng quen); chờ bạn xác nhận |
| H2 | Điểm thưởng / thành viên | Có thể thêm sau mà không đổi cấu trúc đơn hàng |
| H3 | Giỏ quà theo ngân sách trên app | — |
| H4 | Đồng bộ PLU tự động sang cân in tem | Bản đầu: xuất file PLU nạp thủ công |
| H5 | Đăng ký điểm bán (bản đề xuất ở §7.6) | Làm ở G6 nếu bạn đồng ý định nghĩa đề xuất |

### 1.4. Bảng quyết định (từ 2 vòng hỏi đáp)

| # | Chủ đề | Lựa chọn |
|---|---|---|
| D1 | Pháp nhân | Công ty (không ảnh hưởng phần mềm vì thuế nằm ngoài phạm vi) |
| D2 | Quy mô 12 tháng | 2–5 cửa hàng + 1 kho tổng |
| D3 | POS quầy | Flutter Windows; tablet Android cho soạn đơn/kiểm kê/kho |
| D4 | Hạ tầng | VPS tự quản + Docker, backup ra nơi khác |
| D5 | Xác nhận thanh toán | SePay — VA (tài khoản ảo) theo từng đơn |
| D7 | Giao hàng | Shipper nội bộ + 1 đối tác 3PL |
| D8 | Cân | Cân quầy nối POS + cân in tem (mã EAN-13 nhúng trọng lượng) |
| D9 | Tính tiền hàng cân | **Luôn tính đúng theo số cân thực** × giá niêm yết/kg (kể cả số lẻ như 1,21 kg), đến từng đồng. **Không có ngưỡng dung sai, không cửa hàng chịu, không hỏi khách** (đổi ngày 17/11/2026) |
| D10 | Thanh toán đơn app | **Trả sau khi cân** (VietQR đúng số tiền thực) · **COD**. Bỏ "trả trước theo tạm tính" vì mọi đơn hàng cân đều sẽ lệch tiền và phải hoàn/thu thêm |
| D11 | Điểm thưởng | Không làm |
| D12 | Khiếu nại đơn app | Tự duyệt ≤100.000đ, tối đa 2 lần/30 ngày/khách; vượt → Master xử lý |
| D13 | Admin Chỉ Xem | Cổ đông/nhà đầu tư + Ban giám đốc |
| D14 | Giá vốn với viewer | Chỉ thấy số trong báo cáo đã phát hành |
| D15 | Dữ liệu khách với viewer | Che một phần |
| D17 | App người dùng | Thông báo + mặt hàng đẩy; đặt mua & giao **chỉ trong vùng giao được chọn** |
| D18 | Đơn Master tạo | Đơn bán sỉ / khách doanh nghiệp |
| D19 | Giữ lại | POS, kho/lô/hao hụt, giao hàng/shipper, duyệt & phát hành báo cáo |
| D20 | POS ↔ trang quản lý | POS nối thẳng vào trang quản lý, báo cáo doanh thu hằng ngày tự động |

### 1.5. Thuật ngữ

| Thuật ngữ | Nghĩa |
|---|---|
| **SKU** | Đơn vị bán cụ thể: "Nho Mẫu Đơn — bán theo kg" |
| **Lô (Batch)** | Một lần nhận hàng của 1 SKU; có giá nhập, hạn, độ chín riêng |
| **Hàng cân** | Hàng niêm yết giá theo kg, tiền = giá/kg × số cân thực. Khi đặt qua app chỉ có **giá tham khảo**, tiền thật có sau khi cân |
| **Gross / Tare / Net** | Cả bì / Bì / Tịnh |
| **FEFO** | Hết hạn trước xuất trước |
| **Mặt hàng đẩy (Push Deal)** | Mặt hàng Master chọn đưa lên app trong 1 khoảng thời gian, cho 1 hoặc nhiều vùng giao, có gửi thông báo |
| **Vùng giao (Delivery Zone)** | Khu vực vẽ trên bản đồ (đa giác) do Master chọn, gắn với 1 cửa hàng phục vụ |
| **Giá xuất** | Giá bán ra (lẻ tại quầy, giá đẩy trên app, giá sỉ) |
| **Giá nhập** | Giá mua từ NCC (giá hóa đơn) và giá nhập đã cộng chi phí (landed) |
| **Snapshot** | Bản báo cáo đã được Master phát hành cho Admin Chỉ Xem, không sửa được |
| **Z-report** | Báo cáo chốt ca/chốt ngày của cửa hàng |

---

## 2. Vai trò & phân quyền

### 2.1. Danh sách vai trò

| Vai trò | Ứng dụng | Phạm vi | Quyền chính |
|---|---|---|---|
| `MASTER_ADMIN` | A4 | Toàn hệ thống | Toàn quyền: báo cáo, giá nhập/xuất, đơn sỉ, danh mục, cửa hàng, nhân viên, vùng giao, mặt hàng đẩy & thông báo, duyệt hủy/kiểm kê lớn, phát hành báo cáo, quản lý tài khoản viewer. **Tối thiểu 2 tài khoản Master** (dự phòng mất quyền truy cập) |
| `VIEW_ONLY_ADMIN` | A4 | Theo hồ sơ hiển thị | Chỉ xem. Hai hồ sơ mặc định: `SHAREHOLDER` và `EXECUTIVE` (§10.3) |
| `STORE_MANAGER` | A2 | Cửa hàng được giao | Mở/đóng cửa hàng & ca, duyệt hủy dòng/hoàn tiền/hủy hàng trong hạn mức, kiểm kê, nhận điều chuyển, xem báo cáo doanh thu **cửa hàng mình** (không thấy giá nhập) |
| `CASHIER` | A2 | 1 cửa hàng | Bán hàng, thu tiền, mở/đóng ca của mình |
| `PICKER` | A2 tablet | 1 cửa hàng | Soạn đơn app & đơn sỉ: nhặt, cân, chụp ảnh, đóng gói, gọi ship |
| `WAREHOUSE_STAFF` | A3 | Kho tổng | Nhận hàng NCC (cân, QC, ảnh), tạo lô, soạn & xuất điều chuyển, kiểm kê kho. **Nhập giá nhập: chỉ khi Master cấp quyền riêng** `purchase_price:write` |
| `SHIPPER` | A5 | Cửa hàng | Nhận chuyến, cập nhật trạng thái, thu COD |
| `CUSTOMER` | A1 | Bản thân | Nhận thông báo, đặt mặt hàng đẩy, theo dõi đơn, khiếu nại |

> Một nhân viên có thể có nhiều vai trò ở nhiều cửa hàng: bảng `user_role_assignments(user_id, role, scope_type, scope_id)`.

### 2.2. Ma trận quyền

**F** toàn quyền · **C** tạo · **A** duyệt · **R** xem · **R\*** xem bản đã che/đã phát hành · **—** không

| Dữ liệu | MASTER | VIEW_ONLY | STORE_MGR | CASHIER | PICKER | WH_STAFF | SHIPPER |
|---|---|---|---|---|---|---|---|
| Tài khoản & phân quyền | F | — | C (CASHIER/PICKER của CH mình) | — | — | — | — |
| Danh mục SP, SKU | F | R | R | R | R | R | — |
| Giá bán lẻ, giá đẩy, giá sỉ (giá xuất) | F | R | R | R | R | — | — |
| **Giá nhập (hóa đơn & landed)** | F | R\* (chỉ trong snapshot) | — | — | — | C (nếu được cấp) | — |
| Nhà cung cấp | F | R\* (tên tùy hồ sơ) | — | — | — | R | — |
| Phiếu nhập kho | F | R\* | R (hàng nhận về CH) | — | — | C | — |
| Tồn kho theo lô | F | R\* (số lượng, không giá trị) | R | R | R | R/E (kho) | — |
| Điều chuyển | F | R\* | C (yêu cầu) / nhận | — | — | C/xuất | — |
| Kiểm kê | F/A | R\* | C/A ≤ hạn mức | — | — | C | — |
| Phiếu hủy hàng | F/A | R\* | C/A ≤ hạn mức | C | C | C | — |
| Hóa đơn POS | F | R\* | R (CH mình) | C | — | — | — |
| Hủy hóa đơn đã thanh toán | F | — | A ≤ hạn mức | — | — | — | — |
| Log thao tác thu ngân | F | R\* (tổng hợp) | R (CH mình) | — | — | — | — |
| Đơn app | F | R\* | R (CH mình) | — | E (soạn) | — | E (giao) |
| Đơn sỉ / khách DN | F | R\* | R (nếu CH mình soạn) | — | E (soạn) | E (soạn ở kho) | E (giao) |
| Khách hàng (SĐT, địa chỉ) | F | R\* (che) | R (che, chỉ khi xử lý đơn) | R (che) | R (che) | — | Gọi qua nút, không xem danh sách |
| Vùng giao, phí ship | F | R | R | — | — | — | — |
| Mặt hàng đẩy & thông báo | F | R | R (của CH mình) | — | — | — | — |
| Phát hành báo cáo | F | — | — | — | — | — | — |
| Báo cáo đã phát hành | F | R | — | — | — | — | — |
| Nhật ký hệ thống | R | — | — | — | — | — | — |

### 2.3. Hạn mức duyệt (cấu hình được)

| Hành động | CASHIER | STORE_MGR | MASTER |
|---|---|---|---|
| Xóa dòng trước thanh toán | Được, có log | — | — |
| Giảm giá tay trên dòng | Không | ≤ 10% hoặc ≤ 50.000đ | Không giới hạn |
| Hủy hóa đơn đã thanh toán | — | ≤ 500.000đ, trong ngày | Không giới hạn |
| Hoàn tiền | — | ≤ 200.000đ | Không giới hạn |
| Duyệt phiếu hủy hàng | — | ≤ 1.000.000đ giá trị | Không giới hạn |
| Điều chỉnh kiểm kê | — | ≤ 2% hoặc ≤ 1.000.000đ | Không giới hạn |
| Nhập cân tay khi cân lỗi | — | Được (PIN + lý do) | Được |
| Mở két không bán | — | Được (PIN + lý do) | — |

### 2.4. Bảo mật tài khoản

| Mã | Yêu cầu |
|---|---|
| SEC1 | Master Admin và Admin Chỉ Xem **bắt buộc 2FA** (ứng dụng Authenticator + mã khôi phục) |
| SEC2 | **Xác thực lại** (nhập lại mã 2FA, hiệu lực 5 phút) khi: phát hành/thu hồi báo cáo, xuất danh sách khách, sửa giá nhập của lô đã có bán, tạo/khóa tài khoản admin |
| SEC3 | Nhân viên POS đăng nhập bằng mã nhân viên + PIN 6 số, **chỉ trên thiết bị đã được Master/cửa hàng trưởng kích hoạt** |
| SEC4 | Access token 15 phút + refresh token xoay vòng, thu hồi được theo thiết bị |
| SEC5 | Khóa tạm sau 5 lần sai; cảnh báo khi admin đăng nhập từ thiết bị mới |
| SEC6 | Khách hàng đăng nhập SĐT + OTP (SMS hoặc Zalo ZNS), giới hạn số lần gửi theo SĐT/thiết bị/IP |

### 2.5. Chặn quyền Admin Chỉ Xem — 4 lớp

| Lớp | Cơ chế |
|---|---|
| 1. Giao diện | Không có nút thêm/sửa/xóa; ẩn cột theo hồ sơ (chỉ là trải nghiệm, không phải lớp bảo mật) |
| 2. API | Viewer chỉ được gọi `/v1/auth/*` và `/v1/viewer/*`. Mọi route khác trả 403. Trong `/viewer/*` chỉ có route đọc, ngoại trừ: yêu cầu tải file báo cáo đã phát hành, đánh dấu đã đọc thông báo |
| 3. Database | Route `/viewer/*` dùng connection pool riêng với role `viewer_ro` — chỉ có `SELECT` trên schema `reporting`, **không có quyền vào schema `core`** |
| 4. Lọc theo dòng (RLS) | Bảng `reporting.*` bật Row-Level Security, lọc theo danh sách cửa hàng trong hồ sơ hiển thị |

---

## 3. Kiến trúc kỹ thuật

### 3.1. Sơ đồ

```
 App người dùng (A1) ─┐
 POS quầy/tablet (A2/A3) ─┤        ┌──────────────────────────────────────┐
 App shipper (A5) ────────┼──────► │ NestJS API (modular monolith)        │
 Trang quản lý (A4) ──────┘        │  auth · rbac · catalog · pricing     │
                                   │  inventory · purchasing · pos        │
                                   │  app-orders · wholesale · delivery   │
                                   │  payments · push-deals · notify      │
                                   │  reporting · publish · audit · files │
                                   │  Realtime Gateway (Socket.IO)        │
                                   └───────┬──────────────────┬───────────┘
                                           │                  │
                                   ┌───────▼──────┐    ┌──────▼──────┐
                                   │ PostgreSQL   │    │ Redis       │
                                   │ core         │    │ cache       │
                                   │ reporting    │    │ pub/sub     │
                                   │ audit        │    │ BullMQ      │
                                   │ integration  │    └──────▲──────┘
                                   └───────▲──────┘           │
                                   ┌───────┴──────────────────┴───────┐
                                   │ Worker: outbox, projection báo   │
                                   │ cáo, push FCM, gửi webhook 3PL,  │
                                   │ báo cáo ngày, kiểm độ chín, retry│
                                   └───────────────┬──────────────────┘
               ┌───────────────┬───────────────────┼──────────────┬───────────────┐
            SePay (VA+webhook) FCM/APNs        3PL (1 đối tác)   Bản đồ        Lưu file S3-compatible
```

### 3.2. Nguyên tắc

1. **Một database, một backend** cho POS, app, trang quản lý → doanh thu POS xuất hiện trên trang quản lý ngay khi chốt hóa đơn, không cần đồng bộ bằng cron.
2. **Modular monolith**: một ứng dụng NestJS, chia module rõ ràng; Worker là process riêng chạy cùng codebase.
3. **Transactional outbox**: ghi nghiệp vụ và sự kiện trong cùng transaction → Worker phát sự kiện → không mất thông báo/báo cáo khi Redis hoặc Worker khởi động lại.
4. **Consumer idempotent** theo `event_id`.
5. **Tiền tính ở backend** bằng số nguyên; client chỉ hiển thị.

### 3.3. Phân vùng database

| Schema | Nội dung | Ghi | Đọc |
|---|---|---|---|
| `core` | Dữ liệu vận hành gốc | API (`app_rw`) | API |
| `reporting` | Bảng tổng hợp realtime đã lọc + snapshot đã phát hành | Worker (`projector_rw`) | API Master, API Viewer (`viewer_ro`) |
| `audit` | Nhật ký — chỉ được INSERT | API (`audit_writer`) | Master |
| `integration` | Outbox, webhook inbox, log gọi API ngoài | API, Worker | Worker |

### 3.4. Realtime

- Socket.IO; rooms: `store:{id}` (chuông đơn mới), `order:{id}` (khách theo dõi), `shipper:{id}`, `admin:master`, `viewer:{profile_id}`.
- Viewer chỉ nhận dữ liệu đã qua projection & che trường.
- Mục tiêu độ trễ: **p95 ≤ 3 giây**.
- Client mất kết nối → gọi REST lấy trạng thái mới nhất; socket chỉ để báo có thay đổi.

### 3.5. Lưu file

- Ảnh cân, ảnh hủy hàng, ảnh nhận hàng, ảnh giao hàng, ảnh mặt hàng đẩy, file báo cáo → object storage tương thích S3 (Cloudflare R2/MinIO…).
- Upload trực tiếp bằng presigned URL; backend lưu `sha256`, thời điểm chụp, thiết bị.
- Ảnh hủy hàng & ảnh cân: chụp trực tiếp trong app (không chọn từ thư viện), app đóng **watermark** (mã cửa hàng, giờ, mã nhân viên); server so `sha256` để phát hiện ảnh cũ bị dùng lại.

### 3.6. Hạ tầng (VPS + Docker)

- `docker compose`: `api`, `worker`, `postgres`, `redis`, `caddy` (HTTPS tự động), (tùy chọn) `minio`.
- **Backup PostgreSQL**: pgBackRest hoặc WAL-G → object storage **ở nhà cung cấp khác** với VPS; backup đầy đủ hằng ngày + WAL liên tục (khôi phục được đến từng thời điểm). **Diễn tập khôi phục mỗi quý.**
- Giám sát uptime từ bên ngoài (UptimeRobot hoặc tương đương) + cảnh báo qua Telegram/Zalo.
- 3 môi trường: dev (Docker local), staging, production. Migration có version, **không dùng `synchronize: true`**.


---

## 4. Dữ liệu danh mục

### 4.1. Cây sản phẩm

```
Danh mục      : Quả nhập khẩu > Nho
  Sản phẩm    : Nho Mẫu Đơn
    SKU       : Nho Mẫu Đơn Hàn Quốc — bán theo kg          (WEIGHT)
    SKU       : Nho Mẫu Đơn Hàn Quốc — hộp 500 g cố định    (PACK_FIXED)
```

### 4.2. Kiểu bán (`sale_unit_type`)

| Kiểu | Ví dụ | Tồn kho theo | Tính tiền | Tính theo cân thực |
|---|---|---|---|---|
| `WEIGHT` | Nho bán theo kg | gram | đ/kg × gram thực | Có |
| `PIECE_BY_WEIGHT` | Dưa lưới, sầu riêng nguyên trái | gram + số quả | đ/kg × gram thực | Có |
| `PIECE_FIXED` | Bơ 25.000đ/quả | số quả | đ/quả | Không |
| `PACK_FIXED` | Hộp dâu 250 g | hộp | đ/hộp | Không |
| `PACK_VARIABLE` | Khay cắt dán tem cân | gram | theo tem cân | Có (tem in sẵn) |
| `BUNDLE` | Giỏ quà, combo | trừ thành phần | đ/giỏ | Không |
| `SERVICE` | Phí gọt, phí ship | — | đ/lần | Không |

### 4.3. Thuộc tính SKU

| Trường | Ý nghĩa |
|---|---|
| `sku_code`, `name`, `product_id` | Định danh |
| `sale_unit_type` | Kiểu bán |
| `std_weight_g` | Trọng lượng chuẩn 1 quả/hộp — dùng để tính giá tham khảo trên app |
| `weight_min_g`, `weight_max_g` | Khoảng cân hợp lệ 1 quả (cảnh báo khi chọn nhầm SKU) |
| `tare_g` | Bì mặc định (hộp, khay) |
| `retail_price_per_kg` / `retail_price_per_unit` | **Giá bán lẻ tại quầy** |
| `scale_plu` (5 số) | Mã PLU trên cân |
| `barcode` | Mã vạch hàng đóng gói |
| `shelf_life_days`, `storage_note` | Hạn dùng chuẩn, cách bảo quản |
| `has_ripeness` | Có theo dõi độ chín không (xoài, bơ, chuối, sầu riêng, đu đủ, kiwi…) |
| `shrink_norm_pct_week` | Định mức hao hụt cho phép mỗi tuần |
| `is_high_value` | Hàng giá trị cao → kiểm đếm cuối ca, bắt buộc ảnh cân, đơn app bắt buộc "trả sau khi cân" |
| `cold_required` | Cần túi giữ lạnh khi giao |
| `images[]` | Ảnh hiển thị trên app (khi được đẩy) |

### 4.4. Ba loại giá xuất

| Loại | Dùng ở | Nơi cấu hình |
|---|---|---|
| **Giá lẻ** | POS tại quầy | SKU (có thể khác theo cửa hàng qua `store_prices`) |
| **Giá đẩy** | App, chỉ trong thời gian & vùng của mặt hàng đẩy | Mặt hàng đẩy (§7.3) |
| **Giá sỉ** | Đơn bán sỉ | Bảng giá sỉ theo khách/nhóm khách hoặc nhập tay trên đơn (§9) |

- Mọi thay đổi giá ghi `price_change_logs` (ai, khi nào, cũ → mới).
- Giảm giá cận hạn (markdown) cho từng lô: §5.8.

**Quy tắc tính tiền hàng cân (dùng chung POS, app, đơn sỉ):**
- Cân trả về gram (số nguyên). `thành_tiền_dòng = round_half_up(giá_mỗi_kg × gram / 1000)` → **chính xác đến 1 đồng**, không làm tròn thêm.
  - Ví dụ: 1,21 kg × 95.000đ/kg = **114.950đ**; 0,845 kg × 320.000đ/kg = **270.400đ**; 1,237 kg × 45.000đ/kg = 55.665đ.
- Hiển thị khối lượng 3 số lẻ (`1,210 kg`) hoặc rút gọn (`1,21 kg`) — cấu hình hiển thị, không ảnh hưởng tiền.
- Hóa đơn luôn ghi đúng tổng đến từng đồng. Khi khách trả **tiền mặt** mà không có tiền lẻ, thu ngân có thể bấm **"Bớt lẻ"** (bật/tắt trong cấu hình, mặc định **tắt**, giới hạn ≤ 1.000đ/hóa đơn) → in thành dòng "Bớt lẻ" riêng để báo cáo thấy được. Thanh toán VietQR luôn đúng số tiền.

### 4.5. Nhà cung cấp

`suppliers`: mã, tên, loại (vườn/HTX/đầu mối/nhà nhập khẩu), người liên hệ, SĐT, tài khoản ngân hàng, kỳ hạn thanh toán, ghi chú. Danh sách SKU cung cấp + giá tham khảo gần nhất.

### 4.6. Cửa hàng, kho, thiết bị

- **`stores`**: mã, tên, địa chỉ, tọa độ, giờ mở cửa, trạng thái bán tại quầy (`OPEN/CLOSED`), trạng thái nhận đơn app (`ONLINE/PAUSED`), năng lực đơn app/giờ.
- **`warehouses`**: kho tổng (1 kho ở giai đoạn đầu).
- **`locations`**: vị trí trong kho/cửa hàng (kho lạnh, kệ, tủ mát, khu chín, **đang vận chuyển**).
- **`registers`**: quầy thu ngân.
- **`devices`**: loại (cân quầy, cân in tem, cân nhập kho, máy in hóa đơn, máy in tem, két, màn hình phụ, máy quét, tablet), hãng/model, serial, kết nối (COM/USB/LAN/Bluetooth), tham số giao thức, `last_seen_at`, **hạn kiểm định** của cân (để nhắc lịch — cân dùng mua bán cần kiểm định còn hạn).

### 4.7. Khách hàng

- **Khách app** (`customers`): họ tên, SĐT (mã hóa + `phone_hash` để tìm), địa chỉ giao (nhiều), tọa độ, vùng giao hiện tại, đồng ý nhận thông báo khuyến mãi (có/không, thời điểm), token thiết bị FCM, trạng thái (active/khóa/đã xóa).
- **Khách sỉ / doanh nghiệp** (`wholesale_customers`): tên công ty/cửa hàng, người liên hệ, SĐT, địa chỉ giao, MST (lưu để in trên phiếu giao nếu khách cần), nhóm giá sỉ, hạn mức công nợ, kỳ thanh toán, ghi chú.
- Khách mua tại quầy **không bắt buộc** gắn tài khoản.

### 4.8. Nhân viên

`staff`: mã nhân viên, họ tên, SĐT, PIN (băm Argon2id), vai trò + phạm vi, trạng thái, ngày vào/nghỉ.


---

## 5. Kho, lô hàng, giá nhập, hao hụt

### 5.1. Nguyên tắc sổ kho

1. **Sổ kho chỉ thêm, không sửa/xóa** (`core.stock_movements`). Sai thì ghi bút toán điều chỉnh.
2. Tồn = tổng phát sinh; bảng `stock_balances(location_id, batch_id)` cập nhật trong cùng transaction.
3. Mỗi phát sinh có: lô, vị trí, gram, số quả (nếu có), **giá nhập/kg của lô**, chứng từ nguồn, người làm, thời điểm.
4. Kho tổng **không cho tồn âm**. Cửa hàng **cho phép âm tạm thời** (khi POS offline/cân lệch) nhưng cảnh báo và xử lý trong kiểm kê.

### 5.2. Loại phát sinh kho

| Mã | Ý nghĩa | Dấu |
|---|---|---|
| `PURCHASE_IN` | Nhận hàng NCC | + |
| `PURCHASE_RETURN` | Trả NCC (QC không đạt) | − |
| `TRANSFER_OUT` / `TRANSFER_IN` | Điều chuyển kho tổng → cửa hàng (qua vị trí "đang vận chuyển") | − / + |
| `TRANSFER_VARIANCE` | Chênh lệch khi nhận điều chuyển | ± |
| `SALE_POS` | Bán tại quầy | − |
| `SALE_APP` | Đơn app (trừ khi đóng gói) | − |
| `SALE_WHOLESALE` | Đơn sỉ (trừ khi xuất hàng) | − |
| `RETURN_IN` | Hàng trả lại còn bán được (đơn giao thất bại) | + |
| `BUNDLE_CONSUME` | Trừ thành phần khi lắp giỏ quà/combo | − |
| `PROCESS_CONSUME` / `PROCESS_OUTPUT` | Sơ chế (nguyên quả → khay) | − / + |
| `SAMPLING` | Ăn thử | − |
| `SPOILAGE` | Hủy hàng hỏng (ảnh + duyệt) | − |
| `STOCKTAKE_ADJ` | Điều chỉnh kiểm kê (gồm hao hụt tự nhiên) | ± |
| `INTERNAL_USE` | Xuất dùng nội bộ (§21.3.4) | − |
| `OPENING_BALANCE` | Tồn đầu kỳ khi go-live (§21.3.17) | + |

> v3.2: mọi chứng từ kho theo vòng đời Phiếu tạm → Hoàn thành → Đã hủy (bút toán đảo) — §21.3.2. Đơn vị tính nhiều quy cách dùng chung tồn — §21.3.1.

### 5.3. Nhập hàng từ NCC (trên App kho)

**Không bắt buộc đơn đặt hàng trước** (mua chợ đầu mối là chuyện thường); có thể tạo "đơn đặt NCC" đơn giản nếu muốn theo dõi hàng sắp về.

Mỗi dòng nhận hàng:

| Bước | Dữ liệu |
|---|---|
| Cân | Số thùng/sọt, **cả bì (gross_g)**, bì/thùng (theo loại thùng cấu hình sẵn hoặc cân mẫu), **tịnh = gross − số thùng × bì** |
| Đếm (hàng quả) | Số quả; cân mẫu vài quả → trọng lượng TB/quả |
| QC | Độ chín (nếu có theo dõi), độ ngọt Brix (tùy chọn, nhập 1–3 mẫu), số lượng dập/hỏng loại ra, ảnh thùng hàng |
| Kết quả | Đạt hết / Đạt một phần (phần loại → trả NCC hoặc hủy) / Không đạt (trả toàn bộ) |
| **Giá nhập** | đ/kg hoặc đ/thùng theo hóa đơn/phiếu NCC + ảnh chứng từ. Ai không có quyền giá nhập thì để trống → Master nhập sau trên trang quản lý (lô ở trạng thái "chờ giá") |
| Hạn | Hạn dùng dự kiến = ngày nhận + `shelf_life_days` (sửa được) |

Mỗi dòng đạt → tạo **1 lô** mã `B{yyMMdd}-{số}` → in **tem lô** (QR) dán thùng.

### 5.4. Giá nhập & chi phí nhập (landed cost)

- Chi phí theo chuyến (xe lạnh, bốc xếp, phí khác) nhập trên phiếu nhận → **phân bổ vào các lô** theo trọng lượng tịnh (mặc định) hoặc theo giá trị.
- Mỗi lô có 2 giá:
  - `invoice_cost_per_kg` — giá mua trên chứng từ NCC
  - `landed_cost_per_kg` — đã cộng chi phí phân bổ → **dùng tính giá vốn**
- Chi phí đến muộn (hóa đơn xe về sau): vẫn phân bổ được; phần lô đã bán ghi vào giá vốn của ngày ghi nhận, phần còn tồn tăng giá trị tồn.
- **Sửa giá nhập của lô đã có bán**: chỉ Master, xác thực lại, ghi log; báo cáo đã phát hành của kỳ trước **không tự đổi** (muốn cập nhật thì phát hành phiên bản mới — §10.4).
- (Tùy chọn) Theo dõi **công nợ NCC**: tổng phải trả theo phiếu nhận, đã trả, còn nợ, hạn trả.

### 5.5. Lô hàng & FEFO

**Thuộc tính lô:** mã lô, SKU, NCC, ngày nhận, hạn dùng, độ chín hiện tại, Brix TB, trọng lượng TB/quả, `invoice_cost_per_kg`, `landed_cost_per_kg`, trạng thái (`ACTIVE`, `PENDING_COST`, `DEPLETED`, `WRITTEN_OFF`).

- Lô sinh ra ở kho tổng; khi điều chuyển xuống cửa hàng **giữ nguyên mã lô** → truy được từ quầy về NCC.
- **FEFO**:
  - Bán tại quầy theo kg: thu ngân không chọn lô → hệ thống tự trừ lô hết hạn sớm nhất tại cửa hàng; quét tem lô thì trừ đúng lô đó.
  - Soạn đơn app/đơn sỉ: hệ thống gợi ý lô (phù hợp độ chín khách chọn → hạn sớm nhất); picker quét tem lô hoặc chọn.

> v3.2: thêm mốc `alert_date` và `stop_sell_app_date` cho mỗi lô — §21.3.7.

### 5.6. Độ chín (chỉ SKU `has_ripeness`)

| Giai đoạn | Mã | Ý nghĩa | Hệ thống làm gì |
|---|---|---|---|
| 1 | `S1_UNRIPE` | Xanh/cứng | Bán cho khách chọn "để vài ngày" |
| 2 | `S2_READY` | Chín tới | Giá bình thường |
| 3 | `S3_PEAK` | Chín đậm | Gợi ý Master **đẩy lên app** ("Ăn ngon hôm nay") |
| 4 | `S4_MARKDOWN` | Cận hạn | Đề xuất giảm giá (§5.8) hoặc chuyển sơ chế |
| 5 | `S5_SPOILED` | Hỏng | Chỉ cho tạo phiếu hủy, chặn bán |

- Hệ thống **không tự chuyển giai đoạn theo lịch**. Mỗi sáng tạo **danh sách lô cần kiểm tra** cho từng cửa hàng → nhân viên xác nhận trên tablet (giữ/chuyển giai đoạn, ảnh khi chuyển S4/S5).
- Lô không đều → **tách lô** (cùng giá nhập) theo tỷ lệ.
- Lô quá 48 giờ chưa kiểm tra → báo cửa hàng trưởng.

### 5.7. Hao hụt tự nhiên & kiểm kê

**Không tự trừ kho theo % hằng ngày.** Hao hụt chỉ được ghi nhận qua kiểm kê thực tế.

**Kiểm kê:**
| Loại | Khi nào | Phạm vi |
|---|---|---|
| Kiểm nhanh cuối ca | Mỗi ca | Hàng giá trị cao (`is_high_value`) |
| Kiểm xoay vòng | Hằng ngày | 15–20% SKU, mỗi SKU ≥ 2 lần/tuần |
| Kiểm toàn bộ | Cuối tuần/tháng | Toàn cửa hàng/kho |

- **Đếm mù**: màn hình kiểm không hiện tồn hệ thống.
- Cân theo lô (quét tem) hoặc theo SKU (chênh lệch phân về lô cũ nhất trước).
- Mỗi dòng lưu thời điểm đếm; hàng bán sau thời điểm đó không tính vào chênh lệch.
- Chênh lệch âm **trong định mức** (`shrink_norm_pct_week` × số tuần từ lần kiểm trước) → ghi "Hao hụt tự nhiên", tự duyệt. **Vượt định mức** → bắt buộc giải trình + duyệt theo hạn mức (§2.3).

**Tránh bán quá trên app:** tồn khả dụng cho mặt hàng đẩy = tồn hệ thống × (1 − hệ số an toàn) − đang giữ cho đơn khác. Hệ số an toàn mặc định = định mức hao hụt, Master chỉnh được theo từng mặt hàng đẩy.

### 5.8. Giảm giá cận hạn (markdown) có kiểm soát

- Mỗi sáng hệ thống **đề xuất** giảm giá cho lô S4/sắp hết hạn (ví dụ 15% / 25% / 35%).
- **Giá sàn**: không thấp hơn `landed_cost × (1 − mức lỗ tối đa cấu hình)`; muốn bán dưới giá sàn → chỉ Master duyệt.
- Cửa hàng trưởng duyệt ≤ 20%; > 20% → Master.
- Duyệt xong → in **tem giảm giá** cho lô đó; giá giảm chỉ áp khi xuất đúng lô.
- Nhân viên không được mua hàng giảm giá trong ca của mình.
- Có thể **đẩy luôn lên app** thành mặt hàng đẩy "Giá tốt hôm nay" (§7.3).

### 5.9. Hủy hàng

- Tạo trên POS/tablet/App kho: lô, gram/số quả, lý do (dập vận chuyển, chín nẫu, thối, quá hạn, lỗi NCC, khác), **ảnh chụp trực tiếp có watermark**.
- Duyệt theo hạn mức (§2.3); người tạo ≠ người duyệt.
- Giá trị hủy = gram × `landed_cost_per_kg`.
- Lỗi NCC → có thể chuyển thành phiếu trả NCC.

### 5.10. Điều chuyển kho tổng → cửa hàng

```
[Cửa hàng yêu cầu hoặc kho tổng chủ động] → [Kho soạn hàng theo lô] →
[Xuất: TRANSFER_OUT → "đang vận chuyển"] → [Cửa hàng nhận: cân lại, đếm lại, ảnh] →
[TRANSFER_IN; lệch → TRANSFER_VARIANCE]
```
- Trạng thái: `DRAFT → PICKING → IN_TRANSIT → RECEIVED → CLOSED` / `CANCELLED`.
- Lệch khi nhận > ngưỡng (ví dụ 1% hoặc 200 g) → bắt buộc ảnh + lý do; Master thấy cảnh báo.
- Phiếu "đang vận chuyển" quá N giờ chưa nhận → cảnh báo.

### 5.11. Sơ chế & giỏ quà (đơn giản)

**Sơ chế** (ví dụ 5 kg dưa hấu → 12 khay):
- Công thức: thành phẩm, nguyên liệu, **tỷ lệ thu hồi chuẩn** (yield %), bao bì, hạn dùng thành phẩm (giờ).
- Phiếu sơ chế: cân nguyên liệu thực tế (chọn lô) → đếm/cân thành phẩm → hệ thống tính yield thực, cảnh báo nếu thấp hơn chuẩn quá ngưỡng.
- Giá vốn khay = (giá vốn nguyên liệu + bao bì) / số khay; thành phẩm tạo lô mới, nhớ lô gốc.

**Giỏ quà / combo:**
- Định mức thành phần (SKU + số lượng/khối lượng chuẩn), bao bì, **ngân sách giá vốn ± dung sai**.
- Giỏ đóng sẵn: phiếu lắp ráp trừ thành phần → cộng 1 giỏ; bán giỏ chỉ trừ giỏ.
- Đổi thành phần (hết Táo Envy → Táo Dazzle cùng size): chỉ trong nhóm thay thế đã khai báo; vượt ngân sách giá vốn → cảnh báo, cửa hàng trưởng xác nhận.

### 5.12. Giá vốn

- **Giá vốn theo lô** (xuất lô nào lấy giá `landed_cost_per_kg` của lô đó) — phù hợp vì giá nhập hoa quả đổi theo từng chuyến.
- Giá vốn dòng bán = gram × giá/kg của lô / 1000 (hoặc số quả × giá/quả).
- Báo cáo tách riêng: **giá vốn hàng bán**, **hao hụt trong định mức**, **hao hụt vượt định mức**, **hủy hàng (theo lý do)**, **ăn thử**.
- Lô "chờ giá" đã bán → báo cáo lãi gộp hiển thị cảnh báo "thiếu giá nhập" cho đến khi Master nhập.

---

## 6. POS tại quầy

### 6.1. Mục tiêu hiệu năng

| Chỉ số | Mục tiêu |
|---|---|
| Đặt hàng lên cân → bấm SP → dòng xuất hiện | ≤ 1,5 giây |
| Quét tem cân | ≤ 0,5 giây |
| Giao dịch tiền mặt 5 món | ≤ 20 giây |
| Mất mạng | Vẫn bán tiền mặt bình thường |

### 6.2. Ca & ngày

```
[Mở cửa hàng] → [Mở ca: nhân viên + quầy + tiền đầu ca theo mệnh giá] → [Bán hàng, thu/chi] →
[Đóng ca: đếm mù tiền mặt + kiểm nhanh hàng giá trị cao] → [X/Z-report ca] →
[Đóng ngày: Z-report ngày] → tự gửi về trang quản lý (§6.11)
```
- Không bán khi chưa mở ca; mỗi quầy 1 ca đang mở.
- **Đếm mù**: nhập số đếm trước, xác nhận xong mới thấy số hệ thống & chênh lệch; không cho nhập lại.
- Chênh lệch > ngưỡng (ví dụ 20.000đ) → bắt buộc lý do, cửa hàng trưởng xác nhận.
- Z-report gồm: doanh thu theo phương thức thanh toán, số hóa đơn, số dòng xóa, hóa đơn hủy, giảm giá tay, hoàn tiền, thu/chi, mở két không bán, chênh lệch tiền.

> v3.2: nhiều nhân viên trên 1 quầy (đổi người bằng thẻ/PIN), đóng ca đối chiếu từng phương thức, mức chênh cho phép, in báo cáo K80 — §21.3.9, §21.3.10.

### 6.3. Luồng bán

```
1. Thêm hàng:
   a. Hàng cân: đặt lên cân → chọn SP (phím tắt/tìm) → lấy số cân khi cân báo ổn định
   b. Tem cân in sẵn: quét EAN-13 → tách PLU + gram
   c. Hàng mã vạch / theo quả: quét hoặc chọn + số lượng
   d. Giỏ quà: chọn giỏ đóng sẵn
2. (Tùy chọn) Nhập SĐT khách để lưu lịch sử
3. Giảm giá tay (theo hạn mức) / tem markdown tự áp theo lô
4. Thanh toán: tiền mặt · VietQR (SePay VA) · chuyển khoản thủ công · chia nhiều phương thức
5. Chốt: lưu hóa đơn → trừ kho FEFO → in phiếu → mở két (tiền mặt) → sự kiện về trang quản lý
```

**Quy tắc cân:**
- Chỉ nhận khi cân **ổn định** và > 0.
- Cấu hình theo quầy: trừ bì bằng phần mềm **hoặc** bằng nút tare trên cân (không trừ 2 lần).
- Cảnh báo khi trọng lượng ngoài khoảng `weight_min_g..weight_max_g` (dấu hiệu chọn nhầm SP).
- Mỗi dòng lưu: thiết bị cân, số đọc gốc, thời điểm ổn định, nguồn (`SCALE` / `LABEL` / `MANUAL`).

### 6.4. Cân lỗi

- Mất kết nối → POS báo đỏ; nút **"Nhập cân tay"** cần PIN cửa hàng trưởng + lý do.
- Dòng nhập tay đánh dấu `MANUAL`; báo cáo riêng theo thu ngân/ca.

### 6.5. Mã vạch tem cân (EAN-13)

| Mẫu | Cấu trúc | Ý nghĩa |
|---|---|---|
| W1 (mặc định) | `20 PPPPP WWWWW C` | PLU 5 số, trọng lượng 5 số (gram), số kiểm |
| W2 | `2F PPPPP $$$$$ C` | Nhúng **giá tiền** thay trọng lượng |
| W3 | `2F PPPP WWWWWW C` | PLU 4 số, trọng lượng 6 số |

- Cấu hình mẫu theo từng cân in tem (mỗi hãng cài khác nhau).
- Giải mã: kiểm tra độ dài, tiền tố 20–29, **checksum** (Phụ lục B), tra PLU → SKU.
- W1: tính tiền theo giá lẻ hiện hành. W2: đối chiếu với giá hiện hành, lệch → cảnh báo (tem cũ).
- Cùng một mã tem quét 2 lần trong ngày → cảnh báo.
- Bản đầu nạp PLU vào cân in tem bằng **file xuất từ trang quản lý** theo mẫu của hãng cân.

> v3.2: tem cân cấu hình bằng bảng `barcode_rules` (gồm tem nhúng giá, tem lô, thẻ nhân viên) — §21.3.8.

### 6.6. Thanh toán tại quầy

| Phương thức | Chi tiết |
|---|---|
| Tiền mặt | Nhập tiền khách đưa → tiền thối, gợi ý mệnh giá, mở két |
| **VietQR (SePay VA)** | Backend tạo VA cho hóa đơn, đúng số tiền → hiện QR trên **màn hình phụ** + in trên phiếu tạm tính → webhook SePay → POS báo "Đã nhận tiền" (âm báo) |
| Chuyển khoản thủ công | Thu ngân xác nhận + ảnh/ghi chú; cửa hàng trưởng đối soát cuối ngày |
| Chia nhiều phương thức | Ví dụ 200.000 tiền mặt + phần còn lại VietQR |

**Tình huống VietQR:**
| Tình huống | Xử lý |
|---|---|
| Chuyển sai số tiền | VA theo đơn của SePay chỉ nhận đúng số tiền — app ngân hàng của khách báo lỗi ngay, khách chuyển lại đúng số |
| Muốn trả một phần (tiền mặt + QR) | Tạo VA cho đúng phần còn lại |
| Webhook đến sau khi đã chuyển sang tiền mặt | Ghi "thu thừa", xử lý hoàn |
| Mất mạng | Không xác minh được → đề nghị tiền mặt; nếu thu ngân xác nhận bằng mắt → `PENDING_VERIFY`, cửa hàng trưởng đối soát khi có mạng |
| VA hết hạn | Tạo VA mới |

### 6.7. Hủy, trả, treo

| Thao tác | Điều kiện | Log |
|---|---|---|
| Xóa dòng chưa thanh toán | Thu ngân tự làm | Có — **đặc biệt đánh dấu dòng đã cân rồi xóa** |
| Hủy hóa đơn đã thanh toán | Theo hạn mức, trong ngày | Có |
| Trả hàng/hoàn tiền | Có hóa đơn gốc; hàng tươi trả lại → ghi hủy, không nhập lại kệ (trừ khi cửa hàng trưởng chọn) | Có |
| Mở két không bán | PIN cửa hàng trưởng + lý do | Có |
| Treo hóa đơn | Tự hủy sau N giờ | Có |

### 6.8. In ấn

**Máy in nhiệt 80 mm (KiotViet KV804 hoặc máy ESC/POS bất kỳ)** — USB hoặc LAN (cổng 9100).
- Kiểm tra trên đúng máy: font tiếng Việt (nếu lỗi → in phiếu dạng ảnh), lệnh QR native (nếu không có → in QR dạng ảnh), cắt giấy, mở két.

```
TÊN CỬA HÀNG — địa chỉ — hotline
PHIẾU THANH TOÁN            Số: CH01-251117-0042
17/11/2026 18:42 · Thu ngân: Lan · Quầy 1
------------------------------------------------
Nho Mẫu Đơn
   0,845 kg × 320.000đ/kg            270.400
Dưa lưới Hoàng Kim (1 quả)
   1,920 kg × 95.000đ/kg             182.400
Bơ 034 (giảm giá lô)  2 × 20.000      40.000
------------------------------------------------
TỔNG                                 492.800
Tiền mặt 500.000 · Thối 7.200
------------------------------------------------
[QR VietQR — chỉ khi chọn chuyển khoản]
Cảm ơn quý khách!
```

**Máy in tem** (40×30 mm): tem lô kho (QR), tem khay sơ chế (tên, cân, giá, giờ làm, hạn theo giờ), tem giảm giá, tem túi giao hàng (mã đơn, khung giờ, tên người nhận rút gọn, QR đơn).

### 6.9. Màn hình phụ hướng khách

Hiển thị từng dòng vừa thêm (tên, **số cân, giá/kg, thành tiền**), QR thanh toán + trạng thái, lúc rảnh hiển thị mặt hàng đang đẩy.

### 6.10. Thu chi cửa hàng

Phiếu thu (shipper nộp COD, khách sỉ trả nợ tại cửa hàng), phiếu chi (đá lạnh, túi, chi lặt vặt) có danh mục + ảnh + duyệt theo hạn mức; phiếu nộp tiền về công ty. Số dư tiền mặt theo cửa hàng.

### 6.11. Nối POS vào trang quản lý — báo cáo doanh thu hằng ngày

**Realtime (trong ngày):**
- Mỗi hóa đơn chốt → sự kiện `sale.completed` → Worker cập nhật `reporting.live_sales_hourly` (doanh thu theo giờ × cửa hàng × kênh) → trang quản lý của Master cập nhật ≤ 3 giây.
- Master thấy: doanh thu, số hóa đơn, giá trị TB/hóa đơn, cơ cấu phương thức thanh toán, top mặt hàng (khối lượng & tiền), **lãi gộp tạm tính** (theo giá vốn lô).
- Viewer thấy doanh thu & sản lượng tạm tính (nhãn "chưa chốt"), **không có giá vốn** (D14).

**Chốt ngày:**
1. Cửa hàng trưởng bấm **"Đóng ngày"** trên POS (hoặc hệ thống tự chốt lúc 23:59 nếu quên — ca chưa đóng thì báo Master).
2. Hệ thống tạo **Z-report ngày** bất biến cho cửa hàng.
3. Khi **tất cả cửa hàng** đã chốt (hoặc đến giờ cấu hình, ví dụ 23:30), Worker tạo **Báo cáo doanh thu ngày toàn chuỗi**:
   - Gửi thông báo cho Master (trên web + email/Telegram tùy chọn).
   - **Tự phát hành** bản "Doanh thu ngày" (không có giá vốn) cho Admin Chỉ Xem theo rule tự động (§10.4.3).
   - Bản có giá vốn/lãi gộp → nằm chờ Master duyệt phát hành (theo tuần/tháng).
4. Xuất Excel/PDF báo cáo ngày ngay trên trang quản lý.

**Offline:** hóa đơn offline đồng bộ lên khi có mạng → báo cáo ngày cập nhật lại; nếu đồng bộ sau khi đã chốt ngày → báo cáo ngày có **phiên bản bổ sung** (ghi rõ "bổ sung N hóa đơn offline").

### 6.12. Offline

| Chức năng | Offline |
|---|---|
| Bán tiền mặt, đọc cân, in, mở két | Có (SQLite, số hóa đơn riêng `CH01-Q1-OFF-000123`) |
| Giá & danh mục | Dùng bản đã tải |
| VietQR | Không xác minh được (§6.6) |
| Nhận đơn app | Không — cửa hàng tự chuyển `PAUSED` cho đơn app khi POS mất kết nối > 2 phút |

- Mỗi giao dịch có `client_txn_id` (UUID v7) → gửi lại không bị trùng.
- Thứ tự đồng bộ: mở ca → hóa đơn → thu chi → đóng ca.
- Giá đổi trong lúc offline → giữ giá đã bán.
- Offline tối đa 24 giờ, quá hạn phải đồng bộ mới bán tiếp.

### 6.13. Phần cứng

| Thiết bị | Kết nối | Triển khai |
|---|---|---|
| Cân quầy | RS232 (USB-Serial) / USB | Adapter theo hãng `ScaleAdapter { connect, readStable, tare }`; màn hình "Kiểm tra cân" hiện dữ liệu thô |
| Cân in tem | LAN/RS232 | Bản đầu nạp PLU bằng file |
| Máy in nhiệt | USB / LAN 9100 | ESC/POS, hàng đợi in, báo hết giấy |
| Két tiền | RJ11 qua máy in | Lệnh mở két |
| Máy quét | USB HID | Bắt chuỗi phím kết thúc bằng Enter |
| Màn hình phụ | HDMI 2 | Cửa sổ Flutter thứ 2 |
| Camera | Webcam/tablet | Ảnh cân, ảnh đóng gói |

Heartbeat thiết bị → trang quản lý thấy thiết bị nào mất kết nối; nhắc trước 30 ngày khi cân sắp hết hạn kiểm định.


---

## 7. App người dùng: thông báo & mặt hàng đẩy

### 7.1. Mục đích

App **không phải cửa hàng online đầy đủ**. App dùng để:
1. Nhận **thông báo** từ chuỗi (hàng mới về, mặt hàng đẩy, thông báo chung).
2. Xem và **đặt mua các mặt hàng đang được đẩy** — chỉ khi địa chỉ của khách nằm trong **vùng giao** của mặt hàng đó.
3. Theo dõi đơn, xem ảnh cân thực tế, thanh toán, khiếu nại.
4. (Để sau — H1) Đăng ký điểm bán.

### 7.2. Màn hình

| # | Màn hình | Nội dung |
|---|---|---|
| U01 | Khởi động / bắt buộc cập nhật | Kiểm tra phiên bản tối thiểu |
| U02 | Đăng nhập | SĐT + OTP; đồng ý điều khoản; **hỏi quyền nhận thông báo** (giải thích rõ lợi ích) |
| U03 | Địa chỉ của tôi | Chọn trên bản đồ / nhập; hệ thống xác định **vùng giao** địa chỉ đó thuộc về (hoặc "ngoài vùng giao") |
| U04 | Trang chủ = **Hàng đang đẩy** | Danh sách mặt hàng đẩy còn hiệu lực. Mặt hàng **không áp dụng cho vùng của khách** vẫn hiện (để khách biết) nhưng nút đặt bị khóa với ghi chú "Chỉ giao khu vực …" — hoặc ẩn hẳn (Master chọn khi tạo mặt hàng đẩy) |
| U05 | Chi tiết mặt hàng đẩy | Ảnh, mô tả, xuất xứ, **giá đẩy** (đ/kg hoặc đ/quả/hộp), **giá tham khảo** theo quả (ghi rõ "tiền thật theo cân"), thời gian còn lại, số lượng còn lại (nếu Master cho hiện), giới hạn mỗi khách, tùy chọn độ chín/sơ chế (nếu có), vùng giao |
| U06 | Giỏ hàng | Chỉ chứa mặt hàng đẩy; các mặt hàng trong giỏ phải **cùng cửa hàng phục vụ** (cùng vùng giao) |
| U07 | Đặt hàng | Địa chỉ (trong vùng), khung giờ giao (nếu có), phí ship, ghi chú, phương thức thanh toán: **trả sau khi cân** hoặc **COD** (§8.4) |
| U08 | Thanh toán VietQR | QR VA đúng số tiền, đếm ngược, tự chuyển trạng thái |
| U09 | Theo dõi đơn | Trạng thái, **phiếu cân thực tế** (ảnh từng món trên cân + số cân + số tiền), vị trí shipper |
| U10 | Thanh toán sau khi cân | Ảnh từng món trên cân, số cân, **số tiền thực**, QR VietQR đúng số tiền (nếu chọn trả sau khi cân) hoặc thông báo số tiền cần chuẩn bị (COD) |
| U11 | Lịch sử đơn | Các đơn đã đặt |
| U12 | Khiếu nại | Trong 24 giờ sau giao: chọn món, lý do, **ảnh/video chụp trực tiếp** |
| U13 | Hộp thông báo | Tất cả thông báo đã nhận, mở lại được |
| U14 | Tài khoản | Hồ sơ, địa chỉ, bật/tắt nhận thông báo khuyến mãi, **xóa tài khoản** (bắt buộc theo App Store/Google Play) |

### 7.3. Mặt hàng đẩy (Push Deal) — Master tạo trên trang quản lý

| Trường | Ý nghĩa |
|---|---|
| Tên chiến dịch | "Sầu riêng Ri6 về sáng nay" |
| SKU | 1 SKU / 1 mặt hàng đẩy (có thể tạo nhiều mặt hàng đẩy cùng lúc) |
| Ảnh, mô tả | Hiển thị trên app (lấy mặc định từ SKU, sửa được) |
| **Giá đẩy** | đ/kg hoặc đ/đơn vị; hiển thị kèm giá lẻ tại quầy để so sánh (tùy chọn) |
| **Vùng giao áp dụng** | Chọn 1 hoặc nhiều vùng giao (§8.2). Mỗi vùng gắn 1 cửa hàng phục vụ |
| Cửa hàng xuất hàng | Tự lấy theo vùng; Master có thể chỉ định lô cụ thể (ví dụ đẩy lô S3 hoặc lô markdown) |
| **Hạn mức số lượng** | Tổng kg/số quả được bán qua app (không vượt tồn khả dụng — §5.7); có thể chia theo vùng |
| Giới hạn mỗi khách | Ví dụ tối đa 3 kg/khách |
| Thời gian | Bắt đầu – kết thúc; tự tắt khi hết hạn mức |
| Khung giờ giao | Giao ngay (ASAP) / theo khung giờ / cả hai |
| Thanh toán cho phép | Trả sau khi cân và/hoặc COD (§8.4); có thể tắt COD cho hàng giá trị cao |
| Tùy chọn | Độ chín (nếu SKU có), sơ chế (ví dụ "bóc múi hút chân không +20.000đ") |
| Hiển thị ngoài vùng | Hiện nhưng khóa đặt / Ẩn |
| **Thông báo** | Nội dung push (tiêu đề, nội dung, ảnh), thời điểm gửi (ngay / hẹn giờ), **đối tượng**: tất cả khách trong vùng áp dụng / tất cả khách có bật thông báo |
| Trạng thái | `DRAFT → SCHEDULED → LIVE → SOLD_OUT / ENDED` / `CANCELLED` |

**Khi Master bấm "Đẩy":**
1. Kiểm tra tồn khả dụng ≥ hạn mức tại cửa hàng phục vụ từng vùng → nếu thiếu: cảnh báo, gợi ý giảm hạn mức hoặc tạo phiếu điều chuyển.
2. **Giữ hạn mức** (không giữ tồn vật lý, chỉ đặt trần số lượng bán qua app).
3. Lên lịch gửi push qua FCM/APNs cho đúng đối tượng; ghi số người nhận, số mở.
4. Mặt hàng hiện trên app đúng giờ bắt đầu.
5. Mỗi đơn đặt → trừ hạn mức còn lại; hết → `SOLD_OUT`, app hiện "Đã hết", có thể gửi thông báo "Đã hết, hẹn lần sau" (tùy chọn).

### 7.4. Thông báo chung (không gắn mặt hàng)

- Master gửi thông báo tự do: tiêu đề, nội dung, ảnh, đường dẫn (mở màn hình mặt hàng đẩy / hộp thông báo / link web).
- Đối tượng: tất cả / theo vùng giao / theo cửa hàng khách hay mua (dựa trên lịch sử đơn) / danh sách SĐT (nhập file).
- Hẹn giờ gửi; **giới hạn tần suất** (ví dụ tối đa 2 thông báo khuyến mãi/ngày/khách) để tránh khách tắt thông báo hoặc xóa app.
- Thông báo khuyến mãi **chỉ gửi cho khách đã bật** "nhận thông báo khuyến mãi"; thông báo trạng thái đơn luôn gửi.
- Báo cáo: đã gửi, gửi lỗi (token hết hạn → dọn token), số mở, số đơn phát sinh trong 24 giờ sau thông báo.

### 7.5. Thông báo giao dịch (tự động)

| Sự kiện | Nội dung |
|---|---|
| Đặt đơn thành công | Mã đơn, khung giờ |
| Cửa hàng nhận đơn | — |
| **Đã cân** | Ảnh cân + số cân + số tiền thực; kèm QR nếu trả sau khi cân |
| Đang giao / đã giao | Tên shipper, nút gọi |
| Hoàn tiền | Số tiền, cách hoàn |
| Bước cần khách hành động chưa được xử lý sau 3 phút | Gửi thêm SMS/ZNS (tùy cấu hình) |

### 7.6. Đăng ký điểm bán — định nghĩa đề xuất (H1, làm ở G6)

> Bạn chưa định nghĩa phần này. Dưới đây là phương án mình đề xuất, khớp với app dạng thông báo. Bạn xác nhận hoặc sửa trước G6.

**Nghĩa:** khách **đăng ký 1 cửa hàng (điểm bán) quen** của mình trên app.

| Cách đăng ký | Chi tiết |
|---|---|
| Quét QR tại quầy | Mỗi cửa hàng có QR dán ở quầy/in cuối phiếu thanh toán → mở app (hoặc tải app) → tự đăng ký cửa hàng đó |
| Chọn trong app | Danh sách cửa hàng gần (theo vị trí) → bấm "Đăng ký cửa hàng này" |

**Tác dụng:**
- Khách nhận thông báo **riêng của cửa hàng đó** (hàng mới về ở cửa hàng, giờ mở cửa thay đổi…).
- Master gửi thông báo theo đối tượng "khách đăng ký cửa hàng X".
- Báo cáo: số khách đăng ký theo cửa hàng, theo nguồn (QR quầy / app), tăng trưởng theo tuần — đo được hiệu quả quét QR tại quầy.
- Mỗi khách đăng ký tối đa 1 cửa hàng chính (đổi được), dữ liệu ở bảng `store_follows`.

Nếu "điểm bán" của bạn nghĩa là **đối tác/đại lý đăng ký bán hàng của chuỗi**, phần này sẽ thành luồng khác (form đăng ký → Master duyệt → tạo khách sỉ) — báo mình để đổi.

### 7.7. Yêu cầu kỹ thuật tối thiểu cho app

- Có chức năng **xóa tài khoản** trong app (yêu cầu của App Store/Google Play): ẩn danh thông tin cá nhân, giữ đơn hàng cho báo cáo.
- Trang **chính sách quyền riêng tư** (link trong app và trên store).
- Khách bật/tắt thông báo khuyến mãi bất cứ lúc nào.
- SĐT, địa chỉ mã hóa khi lưu; nhân viên chỉ thấy SĐT đã che (ngoại trừ shipper/picker gọi qua nút khi đang xử lý đơn).

---

## 8. Đơn app trong vùng giao & giao hàng

### 8.1. Phạm vi

Đơn app chỉ gồm **mặt hàng đẩy**, chỉ giao trong **vùng giao** đã chọn của mặt hàng đó, do **cửa hàng gắn với vùng** xử lý.

### 8.2. Vùng giao (Delivery Zone)

| Trường | Ý nghĩa |
|---|---|
| Tên | "Quận 7 – Phú Mỹ Hưng" |
| Hình dạng | **Đa giác vẽ trên bản đồ** (lưu GeoJSON/PostGIS) hoặc bán kính từ cửa hàng |
| Cửa hàng phục vụ | 1 cửa hàng |
| Phí ship | Đồng giá trong vùng, hoặc theo bậc khoảng cách đường đi; miễn phí từ giá trị đơn X |
| Năng lực | Số đơn tối đa/khung giờ |
| Giờ nhận đơn | Ví dụ 7:00–20:00 |
| Trạng thái | Bật/tắt (tắt nhanh khi mưa lớn, quá tải) |

- Kiểm tra địa chỉ khách nằm trong vùng bằng **point-in-polygon** (PostGIS `ST_Contains`).
- Một địa chỉ nằm trong nhiều vùng chồng nhau → chọn vùng có độ ưu tiên cao hơn / cửa hàng gần hơn.
- Khoảng cách tính phí (nếu theo bậc): dùng **khoảng cách đường đi** từ API bản đồ (Goong/Google/OSRM tự host); đường chim bay chỉ để lọc sơ bộ.

### 8.3. Máy trạng thái đơn app

```
     PLACED ──► ACCEPTED ──► PICKING ──► WEIGHED ──┬─► AWAITING_CONFIRM (chỉ khi THIẾU hàng)
        │                                          │
        │                                          ├─► AWAITING_PAYMENT (trả sau khi cân: chờ VietQR đúng số tiền thực)
        │                                          │      COD: bỏ qua bước này
        │                                          ▼
        │                                       PACKED ──► SHIPPER_ASSIGNED ──► DELIVERING ──► DELIVERED ──► COMPLETED
        │                                                                          │                   (sau 24h không khiếu nại)
        ▼                                                                          ▼
     REJECTED (cửa hàng từ chối)                                           DELIVERY_FAILED
   CANCELLED (khách hủy trước PICKING / cửa hàng / hệ thống — có lý do)
```

| Trạng thái | Ai chuyển | Ghi chú |
|---|---|---|
| `PLACED` | Hệ thống | Trừ hạn mức mặt hàng đẩy, **giữ tồn** (khối lượng đặt × 1,1), chuông báo cửa hàng (lặp mỗi 15 giây đến khi nhận; quá 3 phút báo cửa hàng trưởng, quá 5 phút báo Master) |
| `ACCEPTED` / `REJECTED` | Picker / cửa hàng trưởng | Từ chối → hoàn tiền (nếu đã trả), nhả giữ tồn, trả hạn mức |
| `WEIGHED` | Picker | Cân từng dòng + ảnh → tính số tiền thực |
| `PACKED` | Picker | Trừ kho thật (FEFO), nhả giữ tồn, in tem túi |
| `DELIVERED` | Shipper / 3PL | Ảnh giao hàng, thu COD |
| `DELIVERY_FAILED` | Shipper / 3PL | Lý do; giao lại hoặc hủy (hàng còn tốt → nhập lại kho; hỏng → hủy hàng) |
| `COMPLETED` | Hệ thống | Hết thời hạn khiếu nại |

### 8.4. Tính tiền theo cân thực & thanh toán (D9, D10)

**Nguyên tắc:** hoa quả niêm yết giá theo kg, **tiền = giá/kg × số cân thực**, chính xác đến từng đồng (§4.4). Không có dung sai, không có phần cửa hàng chịu, không hỏi lại khách về chênh lệch.

**Khi đặt:**
- Khách chọn số lượng theo cách mặt hàng đẩy quy định: **theo kg** (ví dụ 1 kg, bước 0,5 kg) hoặc **theo quả** (ví dụ 2 quả dưa lưới).
- App hiện **giá tham khảo** = giá/kg × (kg đã chọn hoặc số quả × trọng lượng chuẩn/quả), kèm dòng: *"Tiền thực tính theo cân lúc soạn hàng. Bạn sẽ nhận ảnh cân và số tiền chính xác trước khi giao."*
- Không thu tiền lúc đặt.

**Khi soạn:** picker cân từng món → ảnh trên cân → hệ thống tính `actual_amount` từng dòng → tổng đơn = Σ dòng + phí ship.
- Picker nhặt hàng **sát số lượng khách đặt nhất có thể** (theo kg: chọn quả để tổng gần số kg đặt; theo quả: đúng số quả, đúng size).
- Hệ thống cảnh báo picker (không cảnh báo khách) nếu cân thực lệch lớn so với đặt (ví dụ > 15%) — để picker đổi quả cho sát hơn. Đây là kiểm soát soạn hàng nội bộ, không phải dung sai tiền.

**Thanh toán:**
| Phương thức | Luồng |
|---|---|
| **Trả sau khi cân** | `WEIGHED` → push ảnh cân + số tiền thực + **VA SePay đúng số tiền** → khách trả → `PACKED` → giao. Nhắc sau 10 phút; quá 30 phút chưa trả → hủy đơn, hàng trả lại kệ, hoàn hạn mức mặt hàng đẩy |
| **COD** | `WEIGHED` → push ảnh cân + số tiền thực → đóng gói luôn → shipper thu đúng số tiền in trên tem túi. Master đặt **giá trị tối đa cho COD** (ví dụ 2.000.000đ) |

**Hoàn tiền** chỉ còn phát sinh từ khiếu nại (§8.8) hoặc đơn bị hủy sau khi đã trả: chuyển khoản lại cho khách, Master/cửa hàng trưởng đánh dấu đã hoàn + ảnh chứng từ.

### 8.5. Thiếu hàng khi soạn

- Hết hàng hoặc không đủ quả đạt chất lượng → picker đánh dấu thiếu → đơn `AWAITING_CONFIRM`: khách chọn nhận phần còn lại hoặc hủy cả đơn (vì chưa thu tiền nên không phát sinh hoàn). Hết 10 phút không trả lời → giao phần còn lại.
- Mặt hàng đẩy chỉ 1 SKU nên **không có thay thế** sang SKU khác ở bản đầu.

### 8.6. Màn hình soạn đơn (tablet)

1. Hàng đợi: ưu tiên khung giờ gần nhất, đơn ASAP, đơn sỉ đến hạn.
2. Mở đơn: dòng hàng, **tùy chọn độ chín/sơ chế, ghi chú khách** (nổi bật), lô gợi ý + vị trí kệ.
3. Quét tem lô → cân → ảnh → xác nhận từng dòng.
4. Ảnh tổng giỏ; đóng gói (túi giữ lạnh + đá gel nếu `cold_required`); in tem túi.
5. Gọi ship: shipper nội bộ hoặc 3PL.
6. Ghi thời gian từng bước → báo cáo năng suất.

### 8.7. Giao hàng (D7)

**Shipper nội bộ (A5):**
- Nhận chuyến (cửa hàng phân công hoặc tự nhận), gộp nhiều đơn cùng tuyến.
- Cập nhật: đã lấy hàng → đang giao → đã giao (ảnh) / thất bại (lý do: không liên lạc được, sai địa chỉ, khách từ chối…).
- Gửi vị trí mỗi 15–30 giây khi đang giao (chỉ khi đang có đơn).
- Thu COD → **sổ COD theo shipper**; cuối ca nộp cho cửa hàng (phiếu thu) → đối soát; nợ COD vượt hạn mức → không nhận chuyến mới.

**1 đối tác 3PL (Ahamove / GrabExpress / Lalamove — chọn theo hợp đồng ký được):**
- Cần tài khoản doanh nghiệp/đối tác để có API.
- Adapter: báo giá → tạo đơn → nhận webhook trạng thái → hủy.
- Dùng khi: shipper nội bộ bận, đơn xa, hoặc cửa hàng chọn.
- Lưu phí báo giá, phí thực tế, mã vận đơn; COD qua 3PL đối soát theo bảng kê của đối tác.
- Không tìm được tài xế sau N phút → báo cửa hàng.

**Chi phí giao:** lưu **phí thu khách** và **chi phí thực** (lương/khoán shipper theo chuyến hoặc phí 3PL) → báo cáo lãi/lỗ giao hàng.

### 8.8. Khiếu nại đơn app (D12)

1. Trong 24 giờ sau `DELIVERED`, khách chọn món, lý do (dập, hỏng, sượng, thiếu cân…), ảnh/video chụp trực tiếp.
2. **Tự duyệt** nếu giá trị ≤ 100.000đ và khách chưa quá 2 lần/30 ngày → hoàn chuyển khoản hoặc giao bù lần sau (khách chọn).
3. Vượt ngưỡng → Master xử lý trên trang quản lý.
4. Khiếu nại gắn lô → thống kê lô/NCC bị khiếu nại nhiều.

---

## 9. Đơn bán sỉ / khách doanh nghiệp

### 9.1. Luồng

```
[Master tạo đơn sỉ trên trang quản lý] → [Chọn kho/cửa hàng xuất] → [Xác nhận đơn (in/gửi phiếu xác nhận)] →
[Soạn hàng: cân thực tế theo lô] → [Chốt số lượng & tiền thực] → [Xuất kho] →
[Giao (shipper nội bộ / 3PL / khách tự lấy)] → [Ký nhận (ảnh/chữ ký)] → [Thu tiền / ghi công nợ]
```

### 9.2. Trạng thái

`DRAFT → CONFIRMED → PICKING → READY → DELIVERING → DELIVERED → PAID` (hoặc `PARTIALLY_PAID`) · `CANCELLED`

### 9.3. Thông tin đơn sỉ

| Phần | Trường |
|---|---|
| Khách | Chọn từ danh sách khách sỉ (§4.7) hoặc tạo nhanh |
| Giao | Ngày & khung giờ, địa chỉ (1 hoặc nhiều địa chỉ — ví dụ giỏ quà công ty giao từng người), người nhận |
| Dòng hàng | SKU, **số lượng đặt** (kg / quả / thùng / giỏ), **giá sỉ** (lấy từ bảng giá sỉ của nhóm khách, sửa được trên dòng — có log), ghi chú quy cách (size, độ chín, đóng thùng) |
| Giỏ quà/combo | Chọn giỏ theo định mức; có thể đặt số lượng lớn → tạo phiếu lắp ráp hàng loạt |
| Chiết khấu | % hoặc số tiền trên tổng đơn |
| Phí | Phí giao, phí đóng gói |
| Thanh toán | Đặt cọc % (tùy chọn) / thanh toán khi giao / **công nợ** (theo kỳ hạn của khách) — số tiền cuối theo cân thực |
| Kho xuất | Kho tổng hoặc cửa hàng |

### 9.4. Tính tiền theo cân thực với đơn sỉ

- Đơn sỉ đặt theo kg/thùng/quả → khi soạn, **cân thực tế** từng dòng; tiền = giá sỉ/kg × cân thực, đúng đến từng đồng (như §4.4).
- Đơn ở trạng thái `READY` hiển thị cho Master **số đặt và số thực từng dòng** để Master báo khách nếu cần; không có ngưỡng tự động.
- In **phiếu giao hàng / phiếu xuất** có số cân thực từng dòng, đơn giá, thành tiền, chữ ký người nhận.

### 9.5. Công nợ khách sỉ

- Sổ công nợ theo khách: phát sinh (đơn đã giao), đã thu, còn nợ, hạn, quá hạn.
- Ghi nhận thu tiền: tiền mặt (qua phiếu thu cửa hàng), chuyển khoản (tạo **VA SePay cho khách/đơn** để tự khớp), khác.
- Quá hạn mức công nợ hoặc nợ quá hạn → cảnh báo khi tạo đơn mới (Master quyết có cho tạo không).
- Xuất **bảng đối chiếu công nợ** theo khách, theo kỳ (Excel/PDF).

### 9.6. Bảng giá sỉ

- `wholesale_price_lists`: tên nhóm (Đại lý cấp 1, Nhà hàng, Công ty…), hiệu lực; `items`: SKU, giá/kg hoặc giá/đơn vị, số lượng tối thiểu.
- Giá sỉ trên đơn được ghi lại dù bảng giá đổi sau đó.


---

## 10. Trang quản lý: Master Admin & Admin Chỉ Xem

Một ứng dụng Next.js, hai giao diện theo vai trò. Viewer dùng route `/viewer/*` riêng (§2.5).

### 10.1. Master Admin — các mục chức năng

| Mục | Chức năng |
|---|---|
| **1. Tổng quan hôm nay** | Doanh thu realtime toàn chuỗi & từng cửa hàng (quầy / app / sỉ), số hóa đơn, lãi gộp tạm tính, đơn app đang xử lý, đơn sỉ đến hạn giao, cảnh báo (chênh két, tồn âm, lô sắp hết hạn, hàng chờ giá nhập, POS/cân mất kết nối, đơn app trễ, webhook thanh toán ngừng) |
| **2. Báo cáo doanh thu** | Theo ngày/tuần/tháng/khoảng tùy chọn × cửa hàng × kênh × danh mục × SKU; so sánh cùng kỳ; Z-report từng cửa hàng; xuất Excel/PDF (§11) |
| **3. Giá nhập – giá xuất** | Bảng theo SKU/lô: giá nhập hóa đơn, giá nhập landed, giá lẻ, giá đẩy, giá sỉ, giá bán thực tế bình quân, **biên lãi gộp**; lịch sử giá nhập theo NCC; cảnh báo giá nhập tăng/giảm bất thường so với lần trước |
| **4. Đơn bán sỉ** | Tạo/sửa/hủy đơn sỉ, theo dõi soạn & giao, thu tiền, công nợ khách sỉ, bảng giá sỉ, danh sách khách sỉ (§9) |
| **5. Mặt hàng đẩy & thông báo** | Tạo mặt hàng đẩy, chọn vùng, hạn mức, lịch, nội dung push; theo dõi bán được bao nhiêu; thông báo chung; thống kê gửi/mở (§7.3–7.4) |
| **6. Đơn app** | Danh sách & chi tiết đơn app, can thiệp trạng thái (có log), hoàn tiền, xử lý khiếu nại vượt ngưỡng |
| **7. Kho** | Tồn theo kho/cửa hàng/lô (số lượng + giá trị), phiếu nhập NCC (nhập giá cho lô "chờ giá"), chi phí nhập, điều chuyển, kiểm kê, duyệt hủy/kiểm kê vượt hạn mức, lô sắp hết hạn, đề xuất giảm giá chờ duyệt |
| **8. Kiểm soát POS** | Log xóa dòng đã cân, nhập cân tay, giảm giá tay, hủy hóa đơn, mở két không bán, chênh lệch két theo ca/thu ngân |
| **9. Danh mục** | Sản phẩm, SKU, ảnh, giá lẻ, PLU (xuất file nạp cân), định mức giỏ quà, công thức sơ chế, định mức hao hụt |
| **10. Cửa hàng & vùng giao** | Cửa hàng, giờ mở, thiết bị (trạng thái, hạn kiểm định cân), quầy; vẽ vùng giao, phí ship, năng lực |
| **11. Giao hàng** | Shipper nội bộ, sổ COD, cấu hình 3PL, đối soát phí 3PL |
| **12. Nhà cung cấp** | Danh sách NCC, lịch sử nhập & giá, chất lượng (tỷ lệ loại/hủy/khiếu nại theo lô), (tùy chọn) công nợ NCC |
| **13. Khách hàng app** | Danh sách (SĐT đầy đủ — chỉ Master), lịch sử đơn, khiếu nại, khóa tài khoản; xuất danh sách cần xác thực lại + ghi log |
| **14. Nhân viên & phân quyền** | Tài khoản, vai trò, cửa hàng, hạn mức, kích hoạt thiết bị POS, phiên đăng nhập |
| **15. Phát hành báo cáo** | Hồ sơ hiển thị viewer, rule tự động, chuẩn bị – xem trước – phát hành – thu hồi snapshot, "Xem như viewer" (§10.4) |
| **16. Nhật ký** | Tra cứu nhật ký thao tác |
| **17. Cấu hình** | Thanh toán SePay, OTP, push, khiếu nại, bớt lẻ tiền mặt (bật/tắt), COD tối đa, hạn mức duyệt |

### 10.2. Admin Chỉ Xem — các mục

| Mục | Nội dung | Cập nhật |
|---|---|---|
| **Hôm nay** | Doanh thu & số đơn realtime toàn chuỗi/từng cửa hàng/kênh — nhãn **"Tạm tính, chưa chốt"**; trạng thái cửa hàng (mở/đóng, ca đang mở); đơn app & đơn sỉ đang xử lý/đang giao | ≤ 3 giây |
| **Doanh thu theo ngày** | Báo cáo doanh thu ngày đã chốt (tự phát hành mỗi tối) | Hằng ngày |
| **Đơn hàng** | Danh sách đơn app & đơn sỉ: mã, cửa hàng, trạng thái, tổng tiền, khối lượng, khách **đã che** — không có nút thao tác | Realtime |
| **Tồn kho** | Tồn theo cửa hàng (số lượng), lô sắp hết hạn | Realtime |
| **Báo cáo đã phát hành** | Báo cáo tuần/tháng có giá nhập, giá vốn, lãi gộp, hao hụt, xuất–nhập–tồn có giá trị, giao hàng — chỉ những gì Master đã phát hành; xem biểu đồ, lọc, tải PDF/Excel; xem lịch sử phiên bản | Khi Master phát hành |

### 10.3. Hồ sơ hiển thị (Viewer Profile)

| Cấu hình | `SHAREHOLDER` (cổ đông/nhà đầu tư) | `EXECUTIVE` (ban giám đốc) |
|---|---|---|
| Phạm vi | Toàn chuỗi | Toàn chuỗi |
| Hôm nay (realtime) | Doanh thu, số đơn | Doanh thu, số đơn, trạng thái cửa hàng, đơn đang xử lý, tồn kho |
| Giá vốn / giá nhập | Chỉ trong snapshot đã phát hành, **cơ sở THỰC TẾ** | Chỉ trong snapshot đã phát hành; được phép nhận cả báo cáo quản trị dùng **giá vốn định mức có nhãn** |
| Khách hàng | Chỉ số liệu tổng hợp | Che một phần (`Ng. V. A · 098***4321`), không địa chỉ |
| Tên NCC | Ẩn | Hiện |
| Kiểm soát POS | Ẩn | Tổng hợp theo cửa hàng (số dòng xóa, chênh két) |
| Tải file | Chỉ file snapshot | Chỉ file snapshot |

Master tạo thêm hồ sơ khác nếu cần (ví dụ chỉ 1–2 cửa hàng). Nút **"Xem như [tên viewer]"** cho Master kiểm tra đúng những gì viewer thấy.

### 10.4. Phát hành báo cáo (Publish Gate)

**10.4.1. Nguyên tắc**
1. **Ẩn thì được, sửa ngầm thì không.** Master luôn có quyền không cho viewer xem một chỉ tiêu. Nhưng con số nào đã hiển thị thì phải là số thực tế, hoặc mang nhãn rõ (ví dụ "Giá vốn định mức").
2. Báo cáo cho hồ sơ `SHAREHOLDER` dùng **giá vốn thực tế**.
3. Snapshot **không sửa được**. Cập nhật = phát hành **phiên bản mới** + lý do; viewer thấy "v2 thay thế v1 lúc…".
4. Mỗi snapshot lưu người phát hành, thời điểm, checksum dữ liệu.

**10.4.2. Các bước phát hành thủ công**
```
① Chọn loại báo cáo + kỳ + cửa hàng + hồ sơ viewer nhận
② Hệ thống kiểm tra: còn ca chưa đóng? lô "chờ giá" đã bán? phiếu hủy/kiểm kê chưa duyệt? → liệt kê cảnh báo
③ Chọn cơ sở giá vốn: THỰC TẾ | ĐỊNH MỨC (bảng giá vốn định mức theo SKU/kỳ, chỉ cho EXECUTIVE)
④ Xem trước 3 cột: Số thực tế · Số viewer sẽ thấy · Chênh lệch (tô màu dòng chênh)
⑤ Ghi chú phát hành + xác thực lại 2FA
⑥ Phát hành → ghi snapshot + sinh PDF/Excel + thông báo viewer
⑦ Thu hồi (đánh dấu "đã thu hồi" + lý do) hoặc phát hành phiên bản mới
```

**10.4.3. Phát hành tự động (rule)**
| Rule mặc định | Lịch | Nội dung | Cần duyệt? |
|---|---|---|---|
| Doanh thu ngày | Sau khi chốt ngày (hoặc 23:30) | Doanh thu, số hóa đơn, kênh, cửa hàng, top SKU — **không giá vốn** | Không |
| Báo cáo tuần | Thứ Hai 9:00 | Doanh thu + lãi gộp + hao hụt + tồn | **Có** — hệ thống chuẩn bị bản nháp, Master duyệt 1 chạm |
| Báo cáo tháng | Ngày 3 hằng tháng | P&L quản trị + xuất–nhập–tồn có giá trị + giá nhập/xuất | **Có** |

Rule có giá vốn **không được chạy tự động hoàn toàn**.

**10.4.4. Khóa số liệu kỳ (đơn giản, không liên quan thuế)**
- Master "khóa" một tuần/tháng sau khi đã kiểm tra → chứng từ trong kỳ chỉ đọc; phát sinh sau ghi vào kỳ đang mở dưới dạng điều chỉnh.
- Mở khóa: Master + xác thực lại + lý do → snapshot của kỳ đó đánh dấu "cần phát hành lại".

### 10.5. Cấu trúc snapshot

```
reporting.snapshots(id, report_type, period_start, period_end, store_ids[], viewer_profile_ids[],
                    cost_basis (ACTUAL|STANDARD|NONE), version, supersedes_id,
                    status (PUBLISHED|REVOKED|SUPERSEDED), published_by, published_at,
                    release_note, checksum, summary jsonb, file_ids[])
reporting.snap_sales(snapshot_id, date, store_id, channel, sku_id, qty_units, weight_g,
                     gross_amount, discount_amount, net_amount, cogs_amount, gross_profit, basis_label)
reporting.snap_inventory(snapshot_id, location_id, sku_id, opening_g, in_g, out_g, shrink_g,
                         spoil_g, closing_g, closing_value, basis_label)
reporting.snap_purchase(snapshot_id, supplier_label, sku_id, weight_g, avg_cost_per_kg, value, basis_label)
reporting.snap_price_spread(snapshot_id, sku_id, avg_cost_per_kg, avg_sell_per_kg_retail,
                            avg_sell_per_kg_app, avg_sell_per_kg_wholesale, margin_pct, basis_label)
reporting.snap_delivery(snapshot_id, store_id, date, orders, on_time, avg_minutes, fee_collected, cost_paid)
reporting.snap_pnl(snapshot_id, line_code, line_label, amount, basis_label, sort)
```
Tất cả bảng `snap_*` có trigger chặn UPDATE/DELETE.

---

## 11. Báo cáo & KPI

### 11.1. Định nghĩa (dùng chung cho POS, trang quản lý, snapshot)

| Chỉ tiêu | Công thức |
|---|---|
| Doanh thu gộp | Σ giá bán gốc (lẻ/đẩy/sỉ) × khối lượng/số lượng thực |
| Giảm trừ | Giảm giá tay + giảm giá lô (markdown) + chiết khấu đơn sỉ + "bớt lẻ" tiền mặt (nếu bật) + hoàn tiền khiếu nại |
| **Doanh thu thuần** | Doanh thu gộp − giảm trừ (không gồm phí ship) |
| Thu khác | Phí ship, phí sơ chế, phí đóng gói |
| **Giá vốn hàng bán** | Σ gram × `landed_cost_per_kg` của lô xuất |
| **Lãi gộp** | Doanh thu thuần − giá vốn hàng bán |
| Biên lãi gộp % | Lãi gộp / doanh thu thuần |
| Hao hụt & hủy | Hao hụt tự nhiên (trong định mức) · hao hụt vượt định mức · hủy theo lý do · ăn thử |
| **Lãi gộp sau hao hụt** | Lãi gộp − hao hụt − hủy − ăn thử |
| Lãi/lỗ giao hàng | Phí ship thu − chi phí shipper/3PL − bao bì giữ lạnh |
| Chênh lệch giá nhập–xuất / kg | Giá bán thực bình quân/kg − giá vốn bình quân/kg (theo SKU, theo kênh) |

### 11.2. Danh sách báo cáo

| # | Báo cáo | Kỳ | Master | Viewer |
|---|---|---|---|---|
| R01 | Doanh thu realtime (hôm nay) | Realtime | Có (kèm lãi gộp tạm tính) | Có (không giá vốn) |
| R02 | Z-report ca / ngày từng cửa hàng | Ca/ngày | Có | EXECUTIVE (tổng hợp) |
| R03 | **Doanh thu ngày toàn chuỗi** | Ngày | Có | Tự phát hành |
| R04 | Doanh thu theo kênh (quầy / app / sỉ) | Tùy chọn | Có | Qua snapshot |
| R05 | Doanh thu theo SKU/danh mục (kg, số lượng, tiền) | Tùy chọn | Có | Qua snapshot |
| R06 | **Giá nhập – giá xuất – biên lãi theo SKU** | Tuần/tháng | Có | Qua snapshot |
| R07 | Lịch sử giá nhập theo NCC & SKU | Tùy chọn | Có | Qua snapshot (EXECUTIVE) |
| R08 | Xuất – nhập – tồn (khối lượng + giá trị) | Tuần/tháng | Có | Qua snapshot |
| R09 | Hao hụt & hủy hàng theo cửa hàng/SKU/lý do | Tuần | Có | Qua snapshot |
| R10 | Hiệu quả mặt hàng đẩy: hạn mức, đã bán, doanh thu, lãi gộp, số push gửi/mở, đơn phát sinh | Theo chiến dịch | Có | Qua snapshot (EXECUTIVE) |
| R11 | Đơn app: thời gian nhận/soạn/giao, tỷ lệ đúng hẹn, tỷ lệ hủy (gồm hủy do không thanh toán sau cân), lệch cân TB so với đặt (để chỉnh trọng lượng chuẩn), khiếu nại | Tuần | Có | Qua snapshot |
| R12 | Đơn sỉ & công nợ khách sỉ | Tùy chọn | Có | Qua snapshot (tổng hợp) |
| R13 | Giao hàng: số chuyến, COD, chi phí, lãi/lỗ | Tuần | Có | Qua snapshot |
| R14 | Kiểm soát POS: xóa dòng sau cân, cân tay, giảm giá tay, hủy hóa đơn, chênh két | Tuần | Có | EXECUTIVE (tổng hợp) |
| R15 | P&L quản trị (doanh thu thuần → lãi gộp sau hao hụt → lãi/lỗ giao hàng) | Tháng | Có | Qua snapshot |
| R16 | Chất lượng NCC (tỷ lệ loại khi nhận, hủy, khiếu nại theo lô) | Tháng | Có | EXECUTIVE |

Mọi báo cáo xuất được **Excel và PDF**; file Excel dùng để công ty tự làm việc thuế/kế toán bên ngoài.

---

## 12. Cơ sở dữ liệu

### 12.1. Quy ước

| Quy ước | Chi tiết |
|---|---|
| Khóa chính | UUID v7 |
| Mã hiển thị | `CH01-251117-0042` (hóa đơn), `APP-251117-0007`, `WS-2511-015` (đơn sỉ), `B251117-003` (lô) |
| Tiền | `BIGINT` (đồng) — hậu tố `_amount`, `_price`; đơn giá/kg `_per_kg` |
| Khối lượng | `INTEGER` gram — hậu tố `_g` |
| Số lượng | `INTEGER` — hậu tố `_units` |
| Thời gian | `TIMESTAMPTZ`; ngày kinh doanh `business_date` theo giờ VN |
| Không xóa chứng từ | Chỉ hủy logic; danh mục dùng `archived_at` |
| Khóa lạc quan | Cột `version` trên đơn, tồn |
| Không gian | PostGIS cho vùng giao |

### 12.2. Bảng chính — schema `core`

```
-- Danh mục & cấu hình
categories(id, parent_id, name, sort)
products(id, category_id, name, description, origin, images jsonb, archived_at)
skus(id, product_id, sku_code, name, sale_unit_type, std_weight_g, weight_min_g, weight_max_g, tare_g,
     retail_price_per_kg, retail_price_per_unit, scale_plu, barcode, shelf_life_days, has_ripeness,
     shrink_norm_pct_week, is_high_value, cold_required, images jsonb, archived_at)
store_prices(store_id, sku_id, retail_price_per_kg, retail_price_per_unit)
price_change_logs(id, sku_id, scope, old_value, new_value, reason, changed_by, changed_at)
bundle_templates(id, sku_id, cost_budget_amount, cost_tolerance_pct, packaging jsonb)
bundle_items(id, bundle_id, component_sku_id, substitute_group, qty_units, weight_g)
processing_recipes(id, output_sku_id, std_yield_pct, output_shelf_hours, packaging jsonb)
processing_recipe_inputs(recipe_id, input_sku_id, std_weight_g)

-- Tổ chức, người dùng, thiết bị
stores(id, code, name, address, lat, lng, opening_hours jsonb, status, app_status, app_capacity_per_hour)
warehouses(id, code, name, address)
locations(id, store_id, warehouse_id, type, name)
registers(id, store_id, code)
devices(id, store_id, register_id, type, brand, model, serial, connection jsonb,
        calibration_expires_at, last_seen_at, status)
users(id, type, phone_enc, phone_hash, email, password_hash, pin_hash, totp_secret_enc, status)
staff(user_id, staff_code, full_name, hired_at, left_at)
user_role_assignments(id, user_id, role, scope_type, scope_id)
approval_limits(role, action, max_amount, max_pct)
pos_devices(id, store_id, register_id, fingerprint, activated_by, activated_at, revoked_at)
sessions(id, user_id, device_id, refresh_hash, created_at, expires_at, revoked_at)
viewer_profiles(id, code, name, store_ids uuid[], modules text[], customer_visibility,
                cost_visibility, supplier_visibility, pos_control_visibility)
viewer_profile_assignments(user_id, viewer_profile_id)

-- Khách
customers(id, user_id, full_name, phone_enc, phone_hash, promo_opt_in, promo_opt_in_at, status, anonymized_at)
customer_addresses(id, customer_id, label, receiver_name, receiver_phone_enc, address_enc, location geography, zone_id)
customer_devices(id, customer_id, fcm_token, platform, last_seen_at)
store_follows(customer_id, store_id, followed_at)                         -- để dành cho H1
wholesale_customers(id, code, name, contact_name, phone_enc, address_enc, tax_code, price_list_id,
                    credit_limit_amount, payment_terms_days, note, status)
wholesale_price_lists(id, name, valid_from, valid_to)
wholesale_price_items(price_list_id, sku_id, price_per_kg, price_per_unit, min_qty)

-- Mua hàng & kho
suppliers(id, code, name, type, contact jsonb, bank jsonb, payment_terms_days, note)
goods_receipts(id, code, supplier_id, warehouse_id, received_at, received_by, doc_photo_ids uuid[], status)
goods_receipt_lines(id, receipt_id, sku_id, containers, container_tare_g, gross_g, net_g, units,
                    avg_piece_g, brix_samples numeric[], ripeness_stage, rejected_g, reject_reason,
                    invoice_price_per_kg, invoice_price_per_unit, photo_ids uuid[], batch_id)
landed_cost_entries(id, receipt_id, type, amount, method)  ·  landed_cost_allocations(entry_id, batch_id, amount)
supplier_returns(id, supplier_id, receipt_id, status, lines jsonb, photo_ids uuid[])
supplier_payables(id, supplier_id, receipt_id, amount, paid_amount, due_at)          -- tùy chọn
inventory_batches(id, code, sku_id, supplier_id, receipt_line_id, parent_batch_ids uuid[], received_at,
                  expiry_date, ripeness_stage, ripeness_checked_at, brix_avg, avg_piece_g,
                  invoice_cost_per_kg, landed_cost_per_kg, invoice_cost_per_unit, landed_cost_per_unit, status)
stock_movements(id, business_date, location_id, batch_id, sku_id, movement_type, qty_g, qty_units,
                unit_cost_per_kg, unit_cost_per_unit, cost_amount, source_type, source_id, reason_code,
                created_by, created_at)                                              -- chỉ INSERT
stock_balances(location_id, batch_id, sku_id, on_hand_g, on_hand_units, version)
stock_reservations(id, ref_type, ref_line_id, location_id, sku_id, reserved_g, reserved_units, expires_at, status)
transfers(id, code, from_location_id, to_location_id, status, created_by, shipped_at, received_at)
transfer_lines(id, transfer_id, batch_id, sku_id, sent_g, sent_units, received_g, received_units, variance_reason, photo_ids uuid[])
stocktakes(id, code, location_id, type, status, started_at, closed_at, approved_by)
stocktake_lines(id, stocktake_id, sku_id, batch_id, counted_g, counted_units, counted_at,
                system_g_at_count, variance_g, variance_class, explanation)
spoilage_logs(id, location_id, batch_id, type (SPOILAGE|SAMPLING), reason_code, loss_g, loss_units,
              cost_amount, photo_ids uuid[], created_by, approved_by, status)
ripeness_checks(id, batch_id, location_id, from_stage, to_stage, split_batch_id, photo_id, checked_by, at)
markdowns(id, batch_id, location_id, pct, price_per_kg, price_per_unit, valid_to, status, proposed_by, approved_by)
processing_orders(id, recipe_id, location_id, status, output_units, output_g, yield_pct, cost_amount, output_batch_id)
processing_order_inputs(processing_order_id, batch_id, weight_g, units)

-- POS
shifts(id, store_id, register_id, cashier_id, opened_at, opening_cash jsonb, closed_at, counted_cash jsonb,
       counted_total, expected_total, variance_amount, variance_reason, status)
day_closes(id, store_id, business_date, closed_by, closed_at, z_report jsonb, version)
cash_movements(id, shift_id, store_id, type, category, amount, note, photo_id, created_by, approved_by)
pos_sales(id, code, store_id, register_id, shift_id, client_txn_id UNIQUE, is_offline, customer_phone_hash,
          subtotal_amount, discount_amount, rounding_amount, total_amount, paid_amount, status,
          created_by, created_at, voided_by, voided_at, void_reason)
pos_sale_lines(id, sale_id, sku_id, qty_units, weight_g, weight_source, scale_device_id, raw_reading,
               unit_price_per_kg, unit_price_per_unit, markdown_id, line_amount, discount_amount,
               batch_allocations jsonb, cogs_amount, status, voided_by, voided_at, void_reason, weighed_at)

-- App: mặt hàng đẩy, thông báo, đơn
delivery_zones(id, name, store_id, area geography(MultiPolygon), fee_rule jsonb, capacity_per_slot,
               order_hours jsonb, priority, active)
delivery_slots(id, zone_id, date, start_time, end_time, capacity, booked)
push_deals(id, name, sku_id, title, description, images jsonb, price_per_kg, price_per_unit,
           show_retail_compare, quota_g, quota_units, sold_g, sold_units, per_customer_limit_g,
           per_customer_limit_units, starts_at, ends_at, delivery_mode, payment_modes text[],
           modifiers jsonb, outside_zone_display, batch_ids uuid[], status, created_by, version)
push_deal_zones(push_deal_id, zone_id, quota_g, quota_units, sold_g, sold_units)
notifications_campaigns(id, type (DEAL|GENERAL), push_deal_id, title, body, image_id, deep_link,
                        audience jsonb, scheduled_at, sent_at, sent_count, failed_count, opened_count, created_by)
notification_deliveries(id, campaign_id, customer_id, device_id, status, sent_at, opened_at)
app_orders(id, code, customer_id, zone_id, store_id, status, payment_mode (PAY_AFTER_WEIGH|COD),
           ref_subtotal, actual_subtotal, shipping_fee_amount, service_fee_amount, total_amount, paid_amount,
           refunded_amount, slot_id, address_snapshot_enc, notes,
           placed_at, accepted_at, weighed_at, packed_at, delivered_at, completed_at, cancelled_at,
           cancel_reason, version)
app_order_lines(id, order_id, push_deal_id, sku_id, ordered_g, ordered_units, actual_weight_g, actual_units,
                unit_price_per_kg, unit_price_per_unit, ref_amount, actual_amount, modifiers jsonb,
                scale_photo_id, batch_allocations jsonb, cogs_amount, status)
app_order_events(id, order_id, from_status, to_status, actor_id, reason, at)
complaints(id, app_order_id, customer_id, lines jsonb, reason, evidence_ids uuid[], amount,
           auto_approved, resolution, status, handled_by, batch_ids uuid[])

-- Đơn sỉ
wholesale_orders(id, code, customer_id, source_location_id, status, delivery_date, delivery_slot,
                 addresses jsonb, discount_amount, shipping_fee_amount, subtotal_amount, total_amount,
                 payment_terms, deposit_amount, paid_amount, due_at, notes, created_by, version)
wholesale_order_lines(id, order_id, sku_id, ordered_g, ordered_units, actual_g, actual_units,
                      price_per_kg, price_per_unit, line_amount, note, batch_allocations jsonb, cogs_amount)
wholesale_receivables(id, customer_id, order_id, type (INVOICE|PAYMENT|ADJUST), amount, method, ref, at, created_by)

-- Thanh toán & giao hàng (dùng chung POS / app / sỉ)
payments(id, ref_type (POS_SALE|APP_ORDER|WHOLESALE), ref_id, method, amount, status,
         sepay_va, payment_code, qr_payload, expires_at, paid_at, provider_txn_id, raw jsonb)
refunds(id, ref_type, ref_id, amount, method (BANK_TRANSFER|CASH), status, proof_photo_id, created_by, approved_by)
unmatched_bank_txns(id, provider_txn_id, amount, content, txn_at, matched_ref_type, matched_ref_id, matched_by)
shippers(id, user_id, store_id, status, cod_limit_amount)
shipments(id, ref_type (APP_ORDER|WHOLESALE), ref_id, carrier (INTERNAL|<3PL>), carrier_order_id, shipper_id,
          status, raw_status, quoted_fee_amount, actual_fee_amount, cod_amount, pod_photo_id,
          assigned_at, picked_at, delivered_at, failed_reason)
shipment_tracks(shipment_id, lat, lng, at)
shipper_cod_ledger(id, shipper_id, shipment_id, type (COLLECT|REMIT), amount, at)

-- Khác
files(id, owner_type, owner_id, kind, storage_key, sha256, bytes, captured_at, device_id, created_by)
period_locks(id, period_start, period_end, locked_by, locked_at, unlocked_by, unlock_reason)
```

### 12.3. Schema `reporting`, `audit`, `integration`

```
reporting.live_sales_hourly(business_date, hour, store_id, channel, orders, net_amount, cogs_amount, weight_g)
reporting.live_store_status(store_id, status, app_status, open_shifts, pending_app_orders, updated_at)
reporting.live_orders(ref_type, ref_id, code, store_id, channel, status, total_amount, weight_g,
                      customer_masked, updated_at)
reporting.live_stock(location_id, sku_id, on_hand_g, on_hand_units, batches, nearest_expiry)
reporting.daily_revenue(business_date, store_id, channel, orders, gross_amount, discount_amount,
                        net_amount, version)                                     -- R03
reporting.snapshots + reporting.snap_*                                          -- §10.5
reporting.standard_cost_matrix(sku_id, period, cost_per_kg, note)               -- viewer không đọc

audit.logs(id, at, actor_id, role, ip, device_id, action, resource_type, resource_id, before jsonb, after jsonb, reason)
audit.login_logs(id, at, user_id, result, ip, device)
audit.export_logs(id, at, user_id, export_type, filters jsonb, rows, file_id)
audit.viewer_access(id, at, user_id, profile_id, resource, snapshot_id)

integration.outbox(id, event_type, aggregate_id, payload jsonb, occurred_at, published_at, attempts)
integration.processed_events(consumer, event_id, at)
integration.webhook_inbox(id, provider, external_id, body jsonb, verified, received_at, processed_at, result)
                          UNIQUE(provider, external_id)
integration.external_calls(id, provider, endpoint, request jsonb, response jsonb, status, ms, at)
```

### 12.4. Ràng buộc & quyền

```sql
-- Sổ kho & snapshot bất biến
CREATE TRIGGER t_mov_immutable BEFORE UPDATE OR DELETE ON core.stock_movements
  FOR EACH ROW EXECUTE FUNCTION core.raise_immutable();
-- (tương tự cho reporting.snap_*, audit.*)

-- POS offline không trùng
CREATE UNIQUE INDEX ux_pos_client_txn ON core.pos_sales(client_txn_id);

-- Không vượt hạn mức mặt hàng đẩy: cập nhật sold_* bằng
--   UPDATE push_deals SET sold_g = sold_g + $1 WHERE id=$2 AND sold_g + $1 <= quota_g RETURNING ...
-- (0 dòng trả về = hết hạn mức)

-- Vùng giao
CREATE INDEX ix_zones_area ON core.delivery_zones USING GIST(area);

-- Quyền DB
CREATE ROLE viewer_ro LOGIN;
GRANT USAGE ON SCHEMA reporting TO viewer_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO viewer_ro;
REVOKE SELECT ON reporting.standard_cost_matrix FROM viewer_ro;
REVOKE ALL ON SCHEMA core FROM viewer_ro;
ALTER TABLE reporting.live_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_scope ON reporting.live_orders FOR SELECT TO viewer_ro
  USING (store_id = ANY (reporting.allowed_stores(current_setting('app.viewer_profile_id')::uuid)));
```


---

## 13. API, sự kiện, tích hợp

### 13.1. Quy ước

- REST JSON `/v1`; nhóm route: `/app/*` (khách), `/pos/*` (cửa hàng, kho, tablet), `/shipper/*`, `/admin/*` (Master), `/viewer/*` (Admin Chỉ Xem), `/webhooks/*`.
- Header: `X-Request-Id`, `X-Device-Id`; thao tác ghi từ POS/app gửi `Idempotency-Key`.
- Lỗi: `{ code, message, details, request_id }` — mã nghiệp vụ: `STOCK_INSUFFICIENT`, `DEAL_SOLD_OUT`, `OUT_OF_ZONE`, `SHIFT_NOT_OPEN`, `APPROVAL_REQUIRED`, `PERIOD_LOCKED`, `STEP_UP_REQUIRED`…
- Mỗi route khai báo `@RequirePermission(...)`; mặc định từ chối.
- OpenAPI → sinh client Dart (Flutter) và TypeScript (Next.js).

### 13.2. Endpoint chính

| Nhóm | Endpoint |
|---|---|
| Auth | `POST /auth/otp/request` · `/auth/otp/verify` · `/auth/login` · `/auth/pin` · `/auth/2fa/verify` · `/auth/step-up` · `/auth/refresh` · `/auth/logout` |
| App | `GET /app/deals?address_id=` · `GET /app/deals/:id` · `POST /app/addresses` (trả về zone) · `POST /app/orders/quote` · `POST /app/orders` · `GET /app/orders/:id` · `POST /app/orders/:id/confirm` · `POST /app/orders/:id/cancel` · `POST /app/orders/:id/payments` · `POST /app/complaints` · `GET /app/notifications` · `PATCH /app/me/preferences` · `DELETE /app/me` · `POST /app/devices` (FCM token) |
| POS | `POST /pos/shifts/open` · `/pos/shifts/:id/close` · `/pos/day-close` · `POST /pos/sales` · `/pos/sales/:id/void` · `/pos/sales/:id/refund` · `POST /pos/payments/va` · `POST /pos/cash-movements` · `GET /pos/sync/catalog?since=` · `POST /pos/sync/upload` |
| Soạn đơn | `GET /pos/queue` · `POST /pos/app-orders/:id/accept|reject` · `/weigh-line` · `/report-shortage` · `/pack` · `/dispatch` · tương tự `/pos/wholesale-orders/:id/*` |
| Kho | `POST /pos/receipts` · `POST /pos/transfers` · `/pos/transfers/:id/ship|receive` · `POST /pos/stocktakes` · `POST /pos/spoilage` · `GET /pos/ripeness-tasks` · `POST /pos/ripeness-checks` · `POST /pos/processing-orders` · `GET /pos/markdowns` · `POST /pos/markdowns/:id/approve` |
| Shipper | `GET /shipper/jobs` · `POST /shipper/jobs/:id/pickup|deliver|fail` · `POST /shipper/location` · `POST /shipper/cod/remit` |
| Admin | CRUD theo mục §10.1; `GET /admin/reports/:code` · `POST /admin/exports` · `POST /admin/push-deals` · `/admin/push-deals/:id/publish|end` · `POST /admin/notifications` · `POST /admin/wholesale-orders` · `POST /admin/approvals/:id/approve|reject` · `POST /admin/batches/:id/cost` |
| Phát hành | `POST /admin/publish/drafts` · `GET /admin/publish/drafts/:id/preview` · `POST /admin/publish/drafts/:id/publish` · `POST /admin/snapshots/:id/revoke` · `CRUD /admin/viewer-profiles` · `GET /admin/viewer-profiles/:id/preview` · `POST /admin/periods/lock|unlock` |
| Viewer | `GET /viewer/today/*` · `GET /viewer/daily-revenue` · `GET /viewer/orders` · `GET /viewer/stock` · `GET /viewer/snapshots` · `GET /viewer/snapshots/:id/*` · `POST /viewer/files/:id/download` |
| Webhook | `POST /webhooks/sepay` · `POST /webhooks/courier/:provider` |

### 13.3. Sự kiện

| Sự kiện | Người nhận |
|---|---|
| `sale.completed`, `sale.voided` | Báo cáo realtime, kiểm soát POS |
| `day.closed` | Tạo báo cáo ngày, rule phát hành tự động |
| `app_order.placed` | Chuông cửa hàng, báo cáo |
| `app_order.status_changed` | Push khách, realtime cửa hàng/Master/viewer |
| `app_order.weighed` | Push ảnh cân + số tiền thực; tạo VA nếu "trả sau khi cân" |
| `app_order.shortage` | Push hỏi khách nhận phần còn lại / hủy |
| `wholesale_order.status_changed` | Realtime, công nợ |
| `payment.succeeded / expired / unmatched` | Đơn/hóa đơn liên quan, đối soát |
| `stock.moved`, `stock.negative` | Tồn realtime, cảnh báo |
| `batch.stage_changed`, `markdown.approved` | Gợi ý đẩy hàng, giá |
| `push_deal.live / sold_out / ended` | App, thông báo |
| `shipment.status_changed / location` | App khách, realtime |
| `device.offline`, `device.calibration_due` | Cảnh báo Master |
| `snapshot.published / revoked` | Thông báo viewer |

### 13.4. SePay — VA theo đơn (D5)

1. Tạo `payments` (`PENDING`) cho hóa đơn POS / đơn app / đơn sỉ → gọi SePay tạo **VA riêng với số tiền chính xác** → nhận số VA + QR.
2. Khách chuyển → SePay gửi webhook `POST /webhooks/sepay`:
   - Lưu `webhook_inbox` (unique theo mã giao dịch SePay) → **gửi trùng thì bỏ qua**.
   - Xác thực API key/chữ ký của webhook; kiểm tra thời gian để chống gửi lại (replay).
   - Khớp theo VA → `SUCCEEDED` → phát sự kiện (VA theo đơn chỉ nhận đúng số tiền, ngân hàng của khách từ chối nếu chuyển sai số).
   - Trả 200 nhanh; xử lý nặng đưa vào hàng đợi.
3. Giao dịch không khớp VA nào → `unmatched_bank_txns` → Master khớp tay.
4. Job đối soát mỗi giờ + cuối ngày gọi API lịch sử giao dịch SePay để bắt webhook bị lỡ.
5. Cảnh báo nếu quá 30 phút giờ bán hàng không nhận được webhook nào.
6. Tài khoản nhận tiền: **BIDV doanh nghiệp** (§18, O4).

### 13.5. Push (FCM/APNs)

- Worker gửi theo lô (batch 500), giới hạn tốc độ; token lỗi → đánh dấu hết hạn.
- Thông báo có `deep_link` mở đúng màn hình (mặt hàng đẩy / đơn hàng / hộp thông báo).
- Ghi nhận mở thông báo từ app → `opened_at`.

### 13.6. 3PL & bản đồ

- `CourierAdapter { quote, create, cancel, track, parseWebhook }` — 1 đối tác đầu tiên.
- `MapProvider { geocode, reverseGeocode, routeDistance }` — cache theo ô lưới.

---

## 14. Kiểm soát gian lận & nhật ký

| # | Rủi ro | Kiểm soát |
|---|---|---|
| F1 | Thu ngân cân, thu tiền mặt rồi xóa dòng | Log dòng đã cân bị xóa; báo cáo theo thu ngân; giờ chính xác để đối chiếu camera |
| F2 | Chọn SP rẻ hơn cho người quen | Cảnh báo cân ngoài khoảng chuẩn; màn hình phụ hướng khách; thống kê bất thường |
| F3 | Nhập cân tay thấp | PIN quản lý + lý do + báo cáo |
| F4 | Báo hủy hàng tốt để mang về | Ảnh trực tiếp + watermark + hash; người duyệt ≠ người tạo; thống kê hủy theo nhân viên/lô |
| F5 | Tự đánh dấu cận hạn để mua rẻ | Cấm mua hàng giảm giá trong ca; người đề xuất ≠ người duyệt |
| F6 | Mở két lấy tiền | PIN + lý do; đếm mù cuối ca |
| F7 | Shipper giữ tiền COD | Sổ COD; chặn nhận chuyến khi vượt hạn mức |
| F8 | Khách lạm dụng khiếu nại | Giới hạn 2 lần/30 ngày, ≤100.000đ tự duyệt, ảnh trực tiếp |
| F9 | Đặt dồn mặt hàng đẩy để bán lại | Giới hạn mỗi khách theo SĐT + thiết bị + địa chỉ |
| F10 | Khai sai cân/giá khi nhập kho | Người nhận hàng ≠ người nhập giá (mặc định); so giá với lần nhập trước ± ngưỡng → cảnh báo |
| F11 | Hàng "mất" khi điều chuyển | Cân 2 đầu, ảnh, cảnh báo quá hạn nhận |
| F12 | Sửa giá sỉ trên đơn để bán rẻ | Log thay đổi giá dòng; báo cáo đơn sỉ có giá thấp hơn bảng giá |
| F13 | Webhook giả | Xác thực, chống replay, đối soát API |
| F14 | Admin sửa số rồi xóa dấu vết | Nhật ký chỉ-thêm ở schema `audit`; bản sao nhật ký đẩy định kỳ ra lưu trữ ngoài |

**Nhật ký:** ghi mọi thao tác tạo/sửa/hủy/duyệt (trước–sau), mọi lần xem giá nhập/danh sách khách đầy đủ, xuất file, "xem như viewer", đăng nhập.

---

## 15. Yêu cầu phi chức năng

| Nhóm | Yêu cầu |
|---|---|
| Hiệu năng | API đọc p95 ≤ 300 ms; chốt hóa đơn p95 ≤ 500 ms; realtime p95 ≤ 3 s |
| Quy mô thiết kế | 5 cửa hàng, 3.000 hóa đơn/ngày, 500 đơn app/ngày (ngày đẩy hàng), 50.000 khách app, gửi 50.000 push/lần |
| Sẵn sàng | POS bán được khi mất mạng; backend mục tiêu 99,5%/tháng |
| Sao lưu | Mất dữ liệu tối đa 5 phút (WAL liên tục); khôi phục ≤ 4 giờ; backup ở nhà cung cấp khác; diễn tập mỗi quý |
| Bảo mật | HTTPS; bí mật trong biến môi trường; mã hóa SĐT/địa chỉ; Argon2id cho mật khẩu/PIN; rate limit; kiểm tra file upload; token trên mobile lưu Keychain/Keystore |
| Quan sát | Log JSON có `request_id`; Sentry (backend, Flutter, Next.js); theo dõi hàng đợi outbox/push/webhook; cảnh báo Telegram/Zalo: POS offline > 10 phút giờ bán, webhook SePay ngừng, DB/ổ đĩa gần đầy, lỗi 5xx tăng |
| Kiểm thử | Unit test bắt buộc: tính tiền theo gram (bộ test vector chung), giải mã tem cân, FEFO, giá vốn, hạn mức mặt hàng đẩy, vùng giao, máy trạng thái đơn, phân quyền. Test thiết bị thật cho từng model cân/máy in. Test offline POS |
| Giao diện | Tiếng Việt; tiền `1.250.000đ`, cân `0,845 kg`; POS nút lớn cho màn cảm ứng + phím tắt; app chạy tốt trên Android cấu hình thấp |

---

## 16. Lộ trình triển khai

Ước tính cho 1 lập trình viên toàn thời gian. Mỗi giai đoạn kết thúc bằng bản chạy thật.

| Giai đoạn | Thời lượng | Nội dung | Kết quả |
|---|---|---|---|
| **G0. Nền móng** | 2 tuần | VPS + Docker + backup, CI, NestJS khung, auth (Master 2FA, PIN POS, OTP khách), phân quyền, nhật ký, outbox, upload file, Next.js khung, package `shared_models` | Đăng nhập & phân quyền chạy |
| **G1. Danh mục + Kho** | 3 tuần | SP/SKU/giá lẻ, NCC, nhập hàng có cân/bì/QC/ảnh, lô, giá nhập + chi phí nhập, sổ kho, điều chuyển, kiểm kê, hủy hàng | Kho tổng nhập & chuyển hàng xuống cửa hàng |
| **G2. POS** | 5 tuần | Ca, bán hàng, cân quầy, tem cân, in ESC/POS, két, màn hình phụ, SePay VA, hủy/trả, offline, Z-report, **chốt ngày → báo cáo doanh thu ngày trên trang quản lý** | **Cửa hàng bán thật; Master xem doanh thu hằng ngày** |
| **G3. Trang quản lý Master + Viewer** | 3 tuần | Tổng quan, báo cáo doanh thu, giá nhập–xuất, kiểm soát POS, tồn kho, schema `reporting` + realtime, hồ sơ viewer, phát hành snapshot + rule tự động, giao diện Admin Chỉ Xem | Lãnh đạo & cổ đông dùng được |
| **G4. App người dùng + đơn app + giao hàng** | 5 tuần | Vùng giao (vẽ bản đồ), mặt hàng đẩy, push, app (U01–U14), tính tiền theo cân thực + 2 phương thức thanh toán (trả sau khi cân, COD), soạn đơn tablet, shipper nội bộ + COD, 1 đối tác 3PL, khiếu nại | Đẩy hàng & nhận đơn app trong vùng |
| **G5. Đơn sỉ** | 2 tuần | Khách sỉ, bảng giá sỉ, đơn sỉ, soạn theo cân thực, phiếu giao, công nợ, VA cho khách sỉ | Master lên đơn sỉ |
| **G6. Tối ưu** | 2–3 tuần | Độ chín & đề xuất giảm giá, sơ chế, giỏ quà, báo cáo NCC, báo cáo mặt hàng đẩy | Giảm hủy hàng |

**Tổng: khoảng 22–23 tuần (5–6 tháng)** — sau bổ sung v3.2 (§21.6) là **26–27 tuần (~6 tháng)**; go-live theo §21.5. Thứ tự G3–G5 có thể đổi tùy ưu tiên kinh doanh (ví dụ làm G5 đơn sỉ trước G4 nếu doanh thu sỉ quan trọng hơn).

**Làm song song ngay từ G0:** đăng ký SePay + ngân hàng hỗ trợ VA; tài khoản Apple/Google Play; tài khoản đối tác 3PL; gửi OTP (SMS brandname/Zalo ZNS); mua mẫu cân & máy in để test.

---

## 17. Kịch bản nghiệm thu

| # | Kịch bản | Kết quả mong đợi |
|---|---|---|
| T01 | Bán 0,845 kg nho 320.000đ/kg tại quầy | 270.400đ; trừ 845 g lô FEFO; phiếu in đúng; doanh thu hiện trên trang quản lý ≤ 3 giây |
| T02 | Quét tem `2000123008455` | PLU 00123, 845 g; sửa số cuối → báo sai checksum |
| T03 | Rút cáp cân | POS báo lỗi; nhập tay cần PIN quản lý; dòng `MANUAL` |
| T04 | Mất mạng, bán 10 hóa đơn tiền mặt, có mạng lại, gửi lại 2 lần | Đúng 10 hóa đơn; báo cáo ngày cập nhật |
| T05 | Hóa đơn 114.950đ (1,21 kg × 95.000đ) trả VietQR | VA đúng 114.950đ; webhook về → POS báo đã nhận; thử chuyển 115.000đ → ngân hàng từ chối |
| T06 | Webhook SePay gửi trùng 3 lần | Ghi nhận 1 lần |
| T07 | Đóng ngày tất cả cửa hàng | Z-report từng cửa hàng; báo cáo doanh thu ngày toàn chuỗi; viewer nhận bản không giá vốn |
| T08 | Đẩy "Sầu riêng Ri6" hạn mức 50 kg, vùng Q7 | Push gửi khách vùng Q7; khách Q1 thấy nhưng không đặt được (hoặc không thấy — theo cấu hình) |
| T09 | Khách đặt khi chỉ còn 2 kg hạn mức, đặt 3 kg | Báo `DEAL_SOLD_OUT`/chỉ cho đặt ≤ 2 kg |
| T10 | Đơn app 2 quả dưa lưới (95.000đ/kg, tham khảo 1,8 kg/quả = 342.000đ), cân thực 3,84 kg | Tiền thực 364.800đ; khách nhận ảnh cân + QR đúng 364.800đ; không có bước hỏi chênh lệch |
| T11 | Đơn app 1 kg nho, cân thực 1,21 kg, giá 320.000đ/kg, COD | Tiền thực 387.200đ in trên tem túi; shipper thu đúng 387.200đ |
| T12 | Picker cân 1,45 kg cho đơn đặt 1 kg (lệch 45%) | Tablet cảnh báo picker đổi quả; khách không bị hỏi |
| T13 | Đơn "trả sau khi cân" — khách không trả sau 30 phút | Đơn hủy, hàng trả lên kệ, hạn mức hoàn lại |
| T14 | Master tạo đơn sỉ 20 kg cam giá sỉ 32.000đ/kg, cân thực 20,3 kg | Tiền 649.600đ theo 20,3 kg; phiếu giao in số đặt & số thực; ghi công nợ |
| T15 | Đơn sỉ mới khi khách đã vượt hạn mức nợ | Cảnh báo, Master quyết định |
| T16 | Viewer gọi `GET /v1/admin/reports/sales` | 403 |
| T17 | Role `viewer_ro` chạy `SELECT * FROM core.pos_sales` | Permission denied |
| T18 | Viewer `SHAREHOLDER` mở báo cáo tháng | Chỉ giá vốn thực tế; không tên NCC; khách chỉ số tổng hợp |
| T19 | Master phát hành lại báo cáo tháng | v2 thay v1; viewer thấy lịch sử phiên bản |
| T20 | Kiểm kê: nho hao 2,1% với định mức 3% | Tự duyệt "hao hụt tự nhiên" |
| T21 | Kiểm kê: cherry hao 9% | Cần giải trình + duyệt |
| T22 | Phiếu hủy 2.000.000đ, cửa hàng trưởng hạn mức 1.000.000đ | Chờ Master duyệt |
| T23 | Lô bán khi chưa có giá nhập | Báo cáo lãi gộp cảnh báo "thiếu giá nhập"; Master nhập giá → cập nhật |
| T24 | Khách xóa tài khoản | Ẩn danh SĐT/địa chỉ; đơn vẫn trong báo cáo |
| T25 | Shipper nợ COD vượt hạn mức | Không nhận được chuyến mới |

---

## 18. Kết quả xử lý các việc còn mở

| # | Việc | Kết quả |
|---|---|---|
| O1 | Định nghĩa "đăng ký điểm bán" | **Đã có định nghĩa đề xuất** ở §7.6 — khách đăng ký cửa hàng quen (quét QR tại quầy hoặc chọn trong app) để nhận thông báo riêng. Cần bạn xác nhận |
| O2 | Phần cứng | **Đã chốt tiêu chí + danh sách mua** — §18.1 |
| O3 | Đối tác 3PL | **Ahamove** (dự phòng Lalamove) — §18.2 |
| O4 | Ngân hàng cho SePay VA | **BIDV tài khoản doanh nghiệp** — §18.3 |
| O5 | Vùng giao & phí ship | **Đã có mẫu cấu hình + quy trình vẽ vùng** — §18.4. Bạn chỉ cần vẽ vùng thật trên trang quản lý |
| O6 | Khoảng 3–5% catch-weight | **Đã bỏ** — tính tiền đúng theo cân thực (D9) |
| O7 | Hoàn tiền chênh cân | **Đã bỏ** — không còn chênh lệch vì thu tiền sau khi cân |
| O8 | Mẫu phiếu, thương hiệu | **Đã có cấu hình thương hiệu + mẫu phiếu/tem** — §18.5. Bạn điền tên, logo |
| O9 | Giỏ quà & công thức sơ chế | **Đã có mẫu nhập liệu + ví dụ** — §18.6 |

**Còn cần bạn tự làm (không thay được):** xác nhận §7.6 · điền tên thương hiệu/logo/hotline · vẽ vùng giao thật · mua thiết bị mẫu · đăng ký các tài khoản ở §19.10.

### 18.1. Phần cứng — tiêu chí & danh sách mua

**Cân in tem (khu kệ/sơ chế):**
- Dòng phổ biến ở Việt Nam: **CAS CL5200** (nhiều mức tải 3/6 kg, 6/15 kg, 15/30 kg) hoặc tương đương.
- Bắt buộc: cổng **Ethernet hoặc RS232** để nạp PLU; cài được định dạng mã vạch **`20` + PLU 5 số + trọng lượng 5 số (gram) + số kiểm** (mẫu W1 §6.5); in được tên hàng tiếng Việt, ngày đóng gói.
- **Đầu số mã vạch cân (20) phải khác đầu số mã vạch hàng hóa thông thường** để POS tự nhận biết.

**Cân quầy nối POS:**
- Bắt buộc: cổng **RS232 hoặc USB (USB-Serial)** xuất số cân; **có tài liệu giao thức** (chuỗi ký tự gửi ra, cờ ổn định) — hỏi nhà bán trước khi mua.
- Mức cân 15 kg hoặc 30 kg, độ chia ≤ 5 g; đĩa cân inox; có tem kiểm định.
- Ưu tiên cùng hãng với cân in tem để dễ bảo hành.

**Máy in hóa đơn:** 80 mm, ESC/POS, **USB + LAN**, có cổng két **RJ11**, dao cắt tự động (KiotViet KV804 nếu đã có — test theo checklist dưới).

**Máy in tem (tem lô, tem túi, tem khay):** máy in tem nhiệt khổ 40×30 mm trở lên, hỗ trợ lệnh TSPL hoặc ZPL, USB/LAN.

**Khác:** két tiền RJ11; máy quét **2D** (đọc được cả EAN-13 và QR tem lô); màn hình phụ hướng khách (HDMI); PC Windows 10/11 cho quầy (≥ 8 GB RAM, SSD); tablet Android ≥ 10 inch có camera sau cho soạn đơn/kiểm kê; điện thoại Android cho shipper; UPS nhỏ cho PC + router quầy.

**Danh sách cho 1 cửa hàng:**
| Thiết bị | SL |
|---|---|
| PC quầy + màn hình chính cảm ứng | 1/quầy |
| Màn hình phụ hướng khách | 1/quầy |
| Cân quầy nối POS | 1/quầy |
| Máy in hóa đơn 80 mm + két | 1/quầy |
| Máy quét 2D | 1/quầy |
| Cân in tem | 1 |
| Máy in tem | 1 |
| Tablet Android | 1–2 |
| UPS | 1 |
| Kho tổng: cân bàn nhập hàng (≥ 60 kg, có cổng RS232) + tablet + máy in tem lô | 1 bộ |

**Checklist test mỗi model trước khi mua số lượng:**
1. Đọc được số cân ổn định qua cổng COM trong màn hình "Kiểm tra cân" (§6.13).
2. Cân in tem in đúng mẫu W1; POS quét và giải mã đúng PLU + gram.
3. Máy in in đúng tiếng Việt có dấu (nếu lỗi → bật chế độ in ảnh), in QR, cắt giấy, mở két.
4. Máy quét đọc được EAN-13 và QR tem lô.
5. Rút cáp/tắt nguồn thiết bị giữa giao dịch → POS báo lỗi đúng, không treo.

### 18.2. Đối tác 3PL: Ahamove

**Lý do chọn:** có tài liệu API công khai, môi trường thử (STG) và chính thức (PROD), webhook cập nhật trạng thái, **COD trên từng điểm giao**, mã đơn nội bộ (`tracking_number`) chống tạo trùng, dịch vụ xe máy nội thành TP.HCM (`SGN-BIKE`).

**Đăng ký:** điền form tích hợp của Ahamove → nhận API key STG + tài khoản Partner Portal qua email → test → gửi email xin PROD kèm tên công ty, SĐT, email, webhook URL, API key STG.

**Ánh xạ trạng thái (để code adapter):**
| Ahamove | Nội bộ |
|---|---|
| `IDLE`, `ASSIGNING` | `SHIPPER_ASSIGNED` (đang tìm tài xế) |
| `ACCEPTED`, `CONFIRMING` | `SHIPPER_ASSIGNED` |
| `IN PROCESS` | `DELIVERING` |
| `COMPLETED` (điểm giao thành công) | `DELIVERED` |
| `COMPLETED` (điểm giao thất bại) / `CANCELLED` | `DELIVERY_FAILED` |

> Kiểm tra lại tên trạng thái chính xác trên tài liệu Ahamove khi code; chỉ hủy được khi đơn còn ở các trạng thái đầu (chưa lấy hàng).

**Dự phòng: Lalamove** — có API báo giá → tạo đơn, webhook, chữ ký HMAC, thị trường `VN_SGN`; báo giá giữ hiệu lực 5 phút. Interface `CourierAdapter` giữ nguyên nên thêm sau không đổi nghiệp vụ.

### 18.3. Ngân hàng cho SePay VA: BIDV doanh nghiệp

- SePay có **API VA theo đơn hàng dành riêng cho BIDV tài khoản doanh nghiệp** — mỗi đơn một VA, đúng số tiền.
- VA chỉ nhận đúng số tiền, tự hủy khi đã thanh toán hoặc hết hạn → không trùng thanh toán.
- Việc cần làm: mở/ dùng tài khoản BIDV doanh nghiệp → liên kết vào SePay → tạo API token + webhook → test trên môi trường thử với số tiền nhỏ.
- Hạn VA: POS 5 phút, đơn app 30 phút, đơn sỉ 7 ngày (cấu hình).

### 18.4. Vùng giao & phí ship — mẫu cấu hình

**Quy trình:** Trang quản lý → Cửa hàng & vùng giao → "Thêm vùng" → vẽ đa giác trên bản đồ (hoặc chọn "bán kính từ cửa hàng") → chọn cửa hàng phục vụ → nhập phí & giờ → Lưu. Kiểm tra bằng ô "Thử địa chỉ" (nhập địa chỉ → hiện vùng & phí).

**Mẫu (giá trị ví dụ, Master sửa):**
| Trường | Giá trị mẫu |
|---|---|
| Kiểu phí | Bậc theo khoảng cách đường đi |
| 0–3 km | 15.000đ |
| 3–5 km | 25.000đ |
| > 5 km | Ngoài vùng (không nhận) |
| Miễn phí ship | Đơn từ 500.000đ |
| Giờ nhận đơn | 7:00–20:00 |
| Khung giao | 2 giờ/khung, 10 đơn/khung |
| Ưu tiên khi chồng vùng | Vùng có độ ưu tiên cao hơn → cửa hàng gần hơn |

**Ghi chú:** phí ship tính trên **tiền hàng thực sau cân** khi xét miễn phí (nếu tiền tham khảo trên ngưỡng nhưng cân thực dưới ngưỡng → vẫn miễn phí, để khách không bị bất ngờ — cấu hình được).

### 18.5. Thương hiệu, phiếu & tem

`brand_settings` (Master sửa trên trang quản lý): tên thương hiệu, logo (PNG đen trắng cho máy in + bản màu cho app), hotline, địa chỉ hiển thị, câu chân phiếu, màu chủ đạo app, link chính sách quyền riêng tư.

Mẫu phiếu thanh toán: §6.8. Mẫu tem:
```
TEM TÚI GIAO HÀNG (40×30)          TEM LÔ KHO (40×30)            TEM KHAY SƠ CHẾ (40×30)
APP-251117-0007                    B251117-003                   Dưa hấu gọt khay
Khung: 16:00–18:00                 Nho Mẫu Đơn HQ                0,452 kg  ×  60.000đ/kg
Ng. V. A · ***4321                 Nhận 17/11 · HSD 24/11        = 27.120đ
COD: 387.200đ                      [QR batch_id]                 Làm 09:30 · Dùng trước 21:30
[QR mã đơn]                                                      [EAN-13 tem cân]
```

### 18.6. Mẫu nhập giỏ quà & công thức sơ chế

Nhập bằng file Excel trên trang quản lý (Danh mục → Nhập file) hoặc nhập tay.

**Giỏ quà** — sheet `bundles`:
| bundle_sku | ten_gio | gia_ban | ngan_sach_gia_von | dung_sai_% | thanh_phan_sku | so_luong | khoi_luong_g | nhom_thay_the |
|---|---|---|---|---|---|---|---|---|
| GQ-PQ-1200 | Giỏ Phú Quý | 1.200.000 | 780.000 | 5 | CHERRY-US | | 500 | |
| GQ-PQ-1200 | | | | | TAO-ENVY-24 | 3 | | TAO-24 |
| GQ-PQ-1200 | | | | | LE-HQ | 2 | | |
| GQ-PQ-1200 | | | | | NHO-MD-HQ | | 700 | |
| GQ-PQ-1200 | | | | | BB-GIO-MAY | 1 | | |

**Công thức sơ chế** — sheet `recipes`:
| thanh_pham_sku | ten | nguyen_lieu_sku | khoi_luong_chuan_g | yield_% | han_dung_gio | bao_bi |
|---|---|---|---|---|---|---|
| KHAY-DUAHAU | Dưa hấu gọt khay | DUAHAU | 5.000 → 12 khay | 68 | 12 | KHAY-500, MANG-CO |

---

## 19. Khởi động dự án

### 19.1. Cấu trúc mã nguồn (monorepo)

```
fruit-retail/
├─ apps/
│  ├─ api/                 NestJS — 2 entry: main.ts (API + Socket.IO), worker.ts (BullMQ, outbox, cron)
│  ├─ admin-web/           Next.js — Master Admin + Admin Chỉ Xem (route group (master) và (viewer))
│  ├─ customer_app/        Flutter — app người dùng (iOS/Android)
│  └─ staff_app/           Flutter — 1 app, 3 chế độ theo vai trò:
│                            • counter (Windows): POS quầy
│                            • tablet  (Android): soạn đơn, kho, kiểm kê, nhận hàng
│                            • shipper (Android): giao hàng, COD
├─ packages/
│  ├─ shared_models/       Dart — DTO + enum sinh từ OpenAPI
│  ├─ api_client_ts/       TypeScript client sinh từ OpenAPI (cho admin-web)
│  └─ money_weight/        Hàm tính tiền/cân dùng chung (Dart + TS, cùng bộ test vector)
├─ infra/
│  ├─ docker-compose.yml   dev & prod (override)
│  ├─ caddy/Caddyfile
│  ├─ backup/              cấu hình pgBackRest/WAL-G
│  └─ sql/                 migration SQL thủ công: trigger bất biến, RLS, role DB, PostGIS
└─ docs/                   đặc tả này, ADR (ghi quyết định kiến trúc), hướng dẫn thiết bị
```

### 19.2. Thư viện chính

| Tầng | Lựa chọn |
|---|---|
| Backend | NestJS · **Prisma** (schema & truy vấn thường) + **migration SQL thủ công** cho PostGIS, trigger, RLS, role · BullMQ · Socket.IO · class-validator · Argon2 · otplib (2FA TOTP) · Pino (log) · Sentry · @nestjs/swagger (OpenAPI) |
| Admin web | Next.js (App Router) · TanStack Query · TanStack Table · thư viện biểu đồ (ECharts/Recharts) · bản đồ vẽ vùng (Leaflet + leaflet-draw hoặc Mapbox GL Draw) · xuất Excel ở backend (exceljs) |
| Flutter chung | Riverpod · Dio · freezed/json_serializable · firebase_messaging |
| Staff app | **drift** (SQLite offline cho POS) · **flutter_libserialport** (cân qua cổng COM) · thư viện ESC/POS (in hóa đơn) · mobile_scanner (quét QR trên tablet) · camera |
| Customer app | flutter_map hoặc google_maps_flutter (chọn địa chỉ) · camera (khiếu nại) |
| Hạ tầng | Docker Compose · Caddy · PostgreSQL + PostGIS · Redis · pgBackRest/WAL-G · UptimeRobot |

> Lưu ý từ kinh nghiệm dự án trước: module NestJS phải khai báo ở mảng `imports` của module cha, **không** đặt trong `forFeature([])` của ORM.

### 19.3. docker-compose (bản rút gọn)

```yaml
services:
  postgres:
    image: postgis/postgis:16-3.4
    environment: { POSTGRES_DB: fruit, POSTGRES_USER: owner, POSTGRES_PASSWORD: ${PG_OWNER_PASSWORD} }
    volumes: [pgdata:/var/lib/postgresql/data, ./backup:/backup]
    restart: unless-stopped
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    restart: unless-stopped
  api:
    build: ../apps/api
    command: node dist/main.js
    env_file: .env
    depends_on: [postgres, redis]
    restart: unless-stopped
  worker:
    build: ../apps/api
    command: node dist/worker.js
    env_file: .env
    depends_on: [postgres, redis]
    restart: unless-stopped
  admin-web:
    build: ../apps/admin-web
    env_file: .env.web
    restart: unless-stopped
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes: [./caddy/Caddyfile:/etc/caddy/Caddyfile, caddy_data:/data]
    restart: unless-stopped
volumes: { pgdata: {}, caddy_data: {} }
```
(Phiên bản image chỉ là ví dụ — dùng bản ổn định mới nhất lúc triển khai.)

### 19.4. Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `DATABASE_URL_APP` | Kết nối role `app_rw` |
| `DATABASE_URL_VIEWER` | Kết nối role `viewer_ro` (chỉ route `/viewer/*`) |
| `DATABASE_URL_PROJECTOR` | Role `projector_rw` (worker) |
| `DATABASE_URL_AUDIT` | Role `audit_writer` |
| `REDIS_URL` | Redis |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Khóa ký token |
| `PII_ENC_KEY`, `PII_HASH_PEPPER` | Mã hóa & băm SĐT/địa chỉ |
| `SEPAY_API_TOKEN`, `SEPAY_WEBHOOK_API_KEY`, `SEPAY_BANK_ACCOUNT_ID` | SePay |
| `AHAMOVE_API_KEY`, `AHAMOVE_BASE_URL`, `AHAMOVE_WEBHOOK_SECRET` | Ahamove |
| `FCM_SERVICE_ACCOUNT_JSON` | Firebase Cloud Messaging |
| `OTP_PROVIDER`, `OTP_API_KEY`, `OTP_SENDER` | Gửi OTP |
| `MAP_PROVIDER`, `MAP_API_KEY` | Bản đồ / khoảng cách |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Lưu file |
| `SENTRY_DSN` | Theo dõi lỗi |
| `ALERT_TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ID` | Cảnh báo |
| `TZ=Asia/Ho_Chi_Minh`, `BUSINESS_DAY_CUTOFF=04:00` | Giờ & mốc ngày kinh doanh |

### 19.5. Quy ước code

- **Tiền & cân:** chỉ dùng helper trong `money_weight` (`lineAmount(pricePerKg, grams)`, `formatVnd`, `formatKg`); cấm dùng số thực (float) cho tiền. Bộ test vector chung (ví dụ Phụ lục A) chạy ở cả Dart và TS.
- **Trạng thái:** enum định nghĩa 1 nơi (backend) → sinh sang Dart/TS; chuyển trạng thái qua 1 service duy nhất mỗi loại đơn (`AppOrderStateMachine`, `WholesaleOrderStateMachine`, `TransferStateMachine`) có bảng chuyển hợp lệ + ghi `*_events`.
- **Ghi dữ liệu:** mỗi use case = 1 transaction; trong transaction ghi luôn `outbox` + `audit`.
- **API:** DTO có validate; lỗi nghiệp vụ dùng mã chuẩn (§13.1); mọi route có `@RequirePermission`.
- **Git:** nhánh `main` (prod), `develop` (staging), `feat/*`; commit theo Conventional Commits; PR tự review bằng checklist DoD (§19.9).
- **Migration:** Prisma migrate cho bảng; file SQL trong `infra/sql` cho trigger/RLS/role/PostGIS, chạy theo thứ tự đánh số.
- **ADR:** mỗi quyết định kiến trúc ghi 1 file ngắn trong `docs/adr/`.

### 19.6. Danh sách mã quyền (permission codes)

```
auth:*                      (mọi người dùng đã đăng nhập)
catalog:read | catalog:write
price:read | price:write
purchase_price:read | purchase_price:write
supplier:read | supplier:write
receipt:create | receipt:read
batch:read | batch:cost_write
stock:read | stock:adjust
transfer:create | transfer:ship | transfer:receive
stocktake:create | stocktake:approve
spoilage:create | spoilage:approve
ripeness:check | markdown:approve
pos:sell | pos:void_line | pos:void_sale | pos:refund | pos:discount | pos:manual_weight | pos:no_sale_open
shift:open | shift:close | day:close
cash:movement | cash:approve
app_order:fulfill | app_order:manage
wholesale:read | wholesale:write | wholesale:fulfill | receivable:write
deal:read | deal:write | notify:send
zone:write | store:write | device:write
customer:read_masked | customer:read_full | customer:export
staff:write | role:assign
report:read | report:export
publish:manage | viewer_profile:write | period:lock
audit:read
shipper:deliver | cod:remit
viewer:read                  (chỉ cho VIEW_ONLY_ADMIN)
```
Bảng ánh xạ vai trò → mã quyền theo §2.2 lưu trong seed `role_permissions`.

### 19.7. Dữ liệu khởi tạo (seed)

- 2 tài khoản Master (bắt buộc bật 2FA lần đầu đăng nhập).
- 2 hồ sơ viewer `SHAREHOLDER`, `EXECUTIVE` theo §10.3.
- Vai trò + mã quyền + hạn mức duyệt (§2.3).
- Mã lý do (Phụ lục D).
- 1 kho tổng, cửa hàng (nhập thật), quầy, vị trí mặc định (kệ, tủ mát, kho lạnh, đang vận chuyển).
- Danh mục mẫu 20–30 SKU phổ biến (nhập thật từ bảng giá hiện tại) kèm PLU.
- Loại thùng/sọt với bì chuẩn (sọt nhựa, thùng carton nhập khẩu…).
- Cấu hình thương hiệu (§18.5), vùng giao mẫu (§18.4), rule phát hành tự động (§10.4.3).

### 19.8. Backlog chi tiết G0 (2 tuần) và G1 (3 tuần)

**G0 — Nền móng**
| # | Việc | Ước tính |
|---|---|---|
| 0.1 | Tạo monorepo, lint/format, CI (build + test) | 0,5 ngày |
| 0.2 | VPS: Docker, Caddy, Postgres + PostGIS, Redis; backup WAL ra object storage khác nhà cung cấp; thử khôi phục | 1,5 ngày |
| 0.3 | NestJS khung: config, logger, Sentry, health check, OpenAPI, cấu trúc module | 1 ngày |
| 0.4 | Prisma schema nhóm người dùng/vai trò/phiên + SQL role DB (`app_rw`, `viewer_ro`, `projector_rw`, `audit_writer`) | 1 ngày |
| 0.5 | Auth: đăng nhập Master (mật khẩu + 2FA TOTP), xác thực lại, refresh xoay vòng, PIN nhân viên + kích hoạt thiết bị POS, OTP khách | 2 ngày |
| 0.6 | RBAC: decorator `@RequirePermission`, guard phạm vi cửa hàng, hạn mức duyệt; tách module `/viewer/*` dùng pool `viewer_ro` | 1 ngày |
| 0.7 | Audit (schema `audit`, interceptor ghi), outbox + worker relay + bảng processed_events | 1 ngày |
| 0.8 | Upload file presigned + bảng `files` + kiểm tra sha256 | 0,5 ngày |
| 0.9 | Next.js khung: đăng nhập + 2FA, layout Master/Viewer, trang quản lý nhân viên & vai trò | 1 ngày |
| 0.10 | Flutter staff_app khung: chọn chế độ, đăng nhập PIN, lưu token an toàn; package `shared_models` sinh từ OpenAPI; package `money_weight` + test vector | 1 ngày |

**G1 — Danh mục + Kho**
| # | Việc | Ước tính |
|---|---|---|
| 1.1 | Danh mục, SKU, giá lẻ, lịch sử giá, xuất file PLU | 2 ngày |
| 1.2 | NCC, loại thùng/bì | 0,5 ngày |
| 1.3 | Nhập hàng trên tablet: cân (đọc cân bàn qua Bluetooth/USB-OTG hoặc nhập số từ cân), bì, QC, ảnh, tạo lô, in tem lô | 3 ngày |
| 1.4 | Giá nhập + chi phí nhập (landed) + lô "chờ giá" trên trang quản lý | 1,5 ngày |
| 1.5 | Sổ kho bất biến + tồn theo lô + FEFO service + test | 2 ngày |
| 1.6 | Điều chuyển (soạn, xuất, nhận, chênh lệch) | 2 ngày |
| 1.7 | Kiểm kê (đếm mù, phân loại hao hụt, duyệt) | 2 ngày |
| 1.8 | Hủy hàng (ảnh watermark, duyệt) | 1 ngày |
| 1.9 | Màn tồn kho trên trang quản lý (số lượng + giá trị) | 1 ngày |

### 19.9. Định nghĩa hoàn thành (Definition of Done)

Một chức năng được coi là xong khi:
1. Đúng đặc tả (hoặc đặc tả đã được cập nhật nếu thay đổi).
2. API có permission, validate, mã lỗi chuẩn, xuất hiện trong OpenAPI.
3. Ghi audit cho thao tác ghi; phát sự kiện outbox nếu báo cáo/realtime cần.
4. Unit test cho logic tiền/cân/trạng thái/quyền; kịch bản nghiệm thu liên quan (§17) chạy qua.
5. Chạy được trên staging với dữ liệu seed; trên thiết bị thật nếu có phần cứng.
6. Không có lỗi trong Sentry sau 1 ngày chạy staging.

### 19.10. Việc làm song song ngay từ tuần 1

| Việc | Ghi chú |
|---|---|
| Mở/kiểm tra tài khoản **BIDV doanh nghiệp** + đăng ký **SePay** | Thủ tục ngân hàng có thể mất vài ngày |
| Đăng ký **Ahamove** (form tích hợp → API key STG) | Cần webhook URL staging |
| Tài khoản **Apple Developer** (đã có) + **Google Play Console** | Bundle ID app người dùng mới (khác app cũ) |
| Firebase project (FCM) cho app người dùng | — |
| Nhà cung cấp **OTP** (SMS brandname hoặc Zalo ZNS) | Đăng ký brandname mất thời gian |
| API bản đồ (Goong/Google) | Lấy key |
| **Mua mẫu thiết bị**: 1 cân quầy, 1 cân in tem, 1 máy in 80 mm, 1 máy in tem, 1 máy quét 2D, 1 tablet | Chạy checklist §18.1 |
| Chuẩn bị dữ liệu: bảng SKU + giá lẻ hiện tại, danh sách NCC, danh sách cửa hàng & nhân viên | Dùng cho seed |

---

## 20. Phụ lục

### A. Công thức tiền

```text
thành_tiền_dòng = round_half_up(giá_mỗi_kg × gram / 1000)      // chính xác đến 1 đồng
  1,21 kg × 95.000   = 1.210 × 95.000 / 1000  = 114.950
  0,845 kg × 320.000 = 845 × 320.000 / 1000   = 270.400
  1,237 kg × 45.000  = 1.237 × 45.000 / 1000  = 55.665

Tính bằng số nguyên (BigInt / bigint): giá_mỗi_kg × gram có thể tới ~10^10 → an toàn trong int64.
round_half_up(x / 1000) = (x + 500) / 1000  (chia nguyên, x ≥ 0)
```

### B. Giải mã EAN-13 tem cân

```text
2000123008455  →  20 | 00123 | 00845 | 5   →  PLU 00123, 845 g

Checksum (12 số đầu d1..d12):
  S = (d1+d3+d5+d7+d9+d11) × 1 + (d2+d4+d6+d8+d10+d12) × 3
  C = (10 − S mod 10) mod 10
  200012300845: lẻ = 2+0+1+3+0+4 = 10; chẵn = 0+0+2+0+8+5 = 15 → S = 10 + 45 = 55 → C = 5
```

### C. Lệnh ESC/POS

| Mục đích | Hex |
|---|---|
| Khởi tạo | `1B 40` |
| Căn giữa / trái | `1B 61 01` / `1B 61 00` |
| Đậm bật/tắt | `1B 45 01` / `1B 45 00` |
| Chữ gấp đôi | `1D 21 11` |
| In ảnh raster | `1D 76 30 00 xL xH yL yH …` |
| QR native | `1D 28 6B …` |
| Cắt giấy | `1D 56 42 00` |
| Mở két | `1B 70 00 19 FA` |

### D. Mã lý do khởi tạo

| Nhóm | Mã |
|---|---|
| Hủy hàng | `DAMAGED_TRANSPORT`, `OVERRIPE`, `ROTTEN`, `EXPIRED`, `SUPPLIER_DEFECT`, `OTHER` |
| Xóa dòng POS | `CUSTOMER_CHANGED_MIND`, `WRONG_ITEM`, `WRONG_WEIGHT`, `OTHER` |
| Hủy đơn app | `CUSTOMER_REQUEST`, `OUT_OF_STOCK`, `PAYMENT_TIMEOUT`, `STORE_OVERLOAD`, `OUT_OF_ZONE` |
| Giao thất bại | `NO_ANSWER`, `WRONG_ADDRESS`, `CUSTOMER_REFUSED`, `DAMAGED_IN_TRANSIT`, `WEATHER` |
| Chênh kiểm kê | `NATURAL_SHRINK`, `UNRECORDED_SPOILAGE`, `UNRECORDED_SAMPLING`, `MISCOUNT`, `THEFT_SUSPECTED`, `UNKNOWN` |
| Nhập cân tay | `SCALE_DISCONNECTED`, `SCALE_ERROR`, `OTHER` |

### E. Tham khảo kỹ thuật

- SePay — API VA theo đơn hàng: https://docs.sepay.vn/api-va-theo-don-hang.html
- SePay — Tạo trang QR + webhook: https://developer.sepay.vn/vi/sepay-webhooks/tao-qr-va-form-thanh-toan
- SePay — API VA theo đơn cho BIDV doanh nghiệp: https://docs.sepay.vn/api-va-theo-don-hang-bidv.html
- Ahamove — Developer docs: https://developers.ahamove.com/docs/introduction · Tạo đơn: https://developers-stg.ahamove.com/en/docs/api-reference/order-apis/create-order · Hủy đơn: https://developers-stg.ahamove.com/docs/api-reference/order-apis/cancel-order
- Lalamove — API: https://developers.lalamove.com/
- Cân in tem CAS CL5200 (tham khảo): https://emin.vn/jeonjajeoul-syupeomakes-jeoul-657/pc.html


---

## 21. Bổ sung từ đối chiếu KiotViet & Odoo (v3.2)

### 21.1. Cách làm

Đã đối chiếu bản v3.1 với tài liệu hướng dẫn chính thức của **KiotViet** (ngành bán lẻ, nông sản – thực phẩm: hàng hóa, lô – hạn sử dụng, kiểm kho, xuất hủy, chi phí nhập hàng, thiết lập cửa hàng, báo cáo) và **Odoo** (Point of Sale, Inventory, Purchase: barcode nomenclature, FEFO, landed costs, đơn vị tính, reordering rules, cash control, multi-employee). Nguyên tắc: **chỉ lấy những gì phù hợp mô hình chuỗi hoa quả 2–5 cửa hàng + kho tổng**, không sao chép những phần đã quyết định bỏ (thuế, hóa đơn điện tử, tích điểm, sàn TMĐT).

### 21.2. Bảng đối chiếu tổng hợp

| # | Tính năng | KiotViet | Odoo | v3.1 | Quyết định v3.2 |
|---|---|---|---|---|---|
| B1 | Nhiều đơn vị tính dùng chung tồn (kg / hộp / thùng) | Có — đơn vị quy đổi, nhập thùng bán kg | Có — UoM category, purchase UoM tự quy đổi | Mỗi quy cách là SKU riêng | **Bổ sung** §21.3.1 |
| B2 | Vòng đời chứng từ: phiếu tạm → hoàn thành → hủy (đảo kho) | Có — "Lưu tạm/Hoàn thành", hủy phiếu đã cân bằng thì tồn quay lại | Có — draft/done | Rải rác từng phiếu | **Chuẩn hóa** §21.3.2 |
| B3 | Kiểm kho: tab Khớp/Lệch/Chưa kiểm, giá trị lệch, hủy ngay khi kiểm | Có | Có (counted vs on hand) | Có đếm mù, thiếu tab & hủy khi kiểm | **Bổ sung** §21.3.3 |
| B4 | Xuất dùng nội bộ | Có | (dùng scrap/location) | Đã bỏ ở v3 | **Thêm lại** §21.3.4 |
| B5 | Chi phí nhập: loại chi phí cấu hình, nhiều cách phân bổ, hoàn chi phí khi trả NCC | Có — chi phí nhập hoàn lại theo tỷ lệ hàng trả | Có — phân bổ theo khối lượng/thể tích/giá trị/số lượng/chia đều | Phân bổ theo khối lượng hoặc giá trị | **Mở rộng** §21.3.5 |
| B6 | Đặt hàng nhập (PO) + bảng giá NCC + min/max + màn hình bổ sung hàng | Có — đặt hàng nhập, dự kiến hết hàng | Có — vendor pricelist, reordering rules, Replenishment | Hoãn | **Bổ sung bản gọn** §21.3.6 |
| B7 | Ngày cảnh báo & ngày ngừng bán của lô | (cảnh báo cận date) | Có — 4 ngày: best before, removal, alert, expiration | Chỉ có hạn dùng | **Bổ sung** §21.3.7 |
| B8 | Quy tắc mã vạch cân cấu hình được, mã giá → quy đổi ra cân | Có (mã cân) | Có — barcode nomenclature, OCA price-to-weight | Có W1–W3 | **Chuẩn hóa thành bảng quy tắc** §21.3.8 |
| B9 | Nhiều nhân viên trên 1 quầy, đổi người không đóng ca, đăng nhập bằng thẻ/PIN | — | Có — multi employees per session, badge/PIN, khóa màn hình | 1 thu ngân / ca | **Bổ sung** §21.3.9 |
| B10 | Đóng ca đối chiếu theo từng phương thức thanh toán, chênh lệch vượt ngưỡng cần quản lý duyệt | Có (báo cáo cuối ngày) | Có — authorized difference, quản lý duyệt khi vượt | Chỉ tiền mặt | **Mở rộng** §21.3.10 |
| B11 | Đổi – trả trong 1 màn hình, phí trả hàng, thời hạn trả | Có | Có (refund) | Trả hàng riêng | **Bổ sung** §21.3.11 |
| B12 | Đơn đặt giữ hàng tại cửa hàng (khách gọi điện/Zalo) | Có — "Đặt hàng của khách" giữ hàng | Có (quotation/order) | Không có | **Bổ sung** §21.3.12 |
| B13 | Khóa sổ theo chi nhánh, chặn lùi ngày giao dịch | Có — khóa sổ đến ngày, khóa sửa thời gian | Có (lock date) | Khóa kỳ toàn chuỗi | **Mở rộng** §21.3.13 |
| B14 | Quy tắc mã giao dịch (tăng dần / theo thời gian / ngẫu nhiên) | Có | Có (sequence) | Cố định | **Bổ sung** §21.3.14 |
| B15 | Sổ quỹ tiền mặt + ngân hàng | Có | (Accounting) | Chỉ tiền mặt cửa hàng | **Bổ sung** §21.3.15 |
| B16 | Báo cáo hàng hóa nhiều góc nhìn (nhân viên theo hàng bán, NCC theo hàng nhập, giá trị kho, công nợ) | Có | Có | Thiếu vài báo cáo | **Bổ sung** §21.3.16 |
| B17 | Nhập/xuất Excel danh mục, tồn đầu kỳ, in tem mã vạch hàng loạt | Có | Có | Chưa có quy trình chuyển đổi dữ liệu | **Bổ sung** §21.3.17 + kế hoạch go-live §21.5 |
| B18 | Tồn combo = tồn nhỏ nhất của thành phần | (Hàng sản xuất) | (Kit BoM) | Chưa nêu | **Bổ sung** §21.3.18 |
| B19 | Vị trí lưu kho mặc định theo SKU | Có | Có (putaway) | Có vị trí, chưa gán mặc định | **Bổ sung** §21.3.19 |
| B20 | Giá vốn bình quân | Có (cố định/bình quân) | Có (AVCO/FIFO) | Giá vốn theo lô | **Giữ giá vốn theo lô** — lý do §21.4 |

### 21.3. Chi tiết bổ sung

#### 21.3.1. Nhiều đơn vị tính dùng chung tồn (B1)

**Học từ:** KiotViet cho nhập theo thùng hoặc kg và tự quy đổi về đơn vị bán nhỏ hơn; Odoo chỉ quy đổi giữa các đơn vị **cùng nhóm** (ví dụ kg ↔ g), và tự đổi đơn vị mua sang đơn vị tồn khi nhận hàng.

**Áp dụng cho hoa quả:**
- **Đơn vị tồn kho chuẩn** của mỗi SKU: `gram` (hàng cân) hoặc `quả`/`hộp` (hàng đếm).
- Bảng `sku_units`: một SKU có nhiều đơn vị bán/mua **dùng chung tồn**:

| SKU | Đơn vị | Quy đổi | Bán | Mua | Mã vạch | Giá |
|---|---|---|---|---|---|---|
| Nho Mẫu Đơn HQ | kg | 1.000 g | ✓ | ✓ | (tem cân) | 320.000đ/kg |
| Nho Mẫu Đơn HQ | Hộp 500 g | 500 g (cố định) | ✓ | | 893xxxx | 165.000đ/hộp |
| Nho Mẫu Đơn HQ | Thùng (danh nghĩa 5 kg) | **cân thực khi nhận** | | ✓ | | theo hóa đơn NCC |

- **Quy tắc riêng ngành hoa quả:** đơn vị mua "thùng/sọt" chỉ là **danh nghĩa** — khi nhận hàng luôn cân để lấy gram tịnh thật (§5.3), không quy đổi cứng. Đơn vị bán "hộp cố định" quy đổi cứng (trừ đúng 500 g), kèm kiểm tra định lượng khi đóng hộp.
- Hộp đóng sẵn từ hàng rời: dùng **phiếu đóng gói** (giống sơ chế) để biết hao hụt khi chia hộp; nếu không theo dõi riêng thì bán hộp trừ thẳng 500 g.
- Thay thế mô hình "mỗi quy cách 1 SKU" của v3.1 khi các quy cách **cùng một hàng thật** (cùng lô, cùng giá vốn). Vẫn tách SKU khi khác hàng (size khác, xuất xứ khác).

**DB:** `units(code, name, kind: WEIGHT|COUNT)`; `sku_units(id, sku_id, unit_code, factor_g, factor_units, is_variable, for_sale, for_purchase, barcode, price_per_unit, archived_at)`; dòng bán/mua lưu thêm `sku_unit_id` + số lượng theo đơn vị đó + số quy đổi về đơn vị tồn.

#### 21.3.2. Vòng đời chứng từ thống nhất (B2)

**Học từ:** KiotViet cho "Lưu tạm" (chưa trừ kho) hoặc "Hoàn thành" (trừ kho ngay); chỉ xóa được phiếu tạm; hủy phiếu kiểm kho đã cân bằng thì tồn kho quay lại trạng thái trước khi kiểm.

**Áp dụng cho mọi chứng từ kho & mua hàng** (nhận hàng NCC, trả NCC, điều chuyển, kiểm kê, hủy hàng, xuất dùng nội bộ, sơ chế, đóng gói, lắp giỏ):

```
DRAFT (phiếu tạm — chưa ảnh hưởng kho, sửa/xóa được)
  └─► COMPLETED (ghi sổ kho — không sửa; trạng thái trung gian riêng nếu có, ví dụ IN_TRANSIT)
        └─► CANCELLED (ghi bút toán ĐẢO ngược toàn bộ phát sinh; giữ phiếu gốc, có lý do + người hủy)
```
- Chỉ xóa vật lý phiếu `DRAFT` do chính mình tạo.
- Hủy phiếu `COMPLETED`: cần quyền tương ứng + lý do; bị chặn nếu kỳ đã khóa (§21.3.13) hoặc nếu hàng của phiếu đã bị xuất tiếp (ví dụ lô nhận về đã bán một phần → không hủy phiếu nhận, chỉ được điều chỉnh).
- Màn danh sách mọi chứng từ có bộ lọc trạng thái Phiếu tạm / Hoàn thành / Đã hủy, thời gian, người tạo; xuất Excel tổng quan hoặc chi tiết.

**DB:** cột chung `status`, `completed_at`, `completed_by`, `cancelled_at`, `cancelled_by`, `cancel_reason`; `stock_movements.reversal_of_id` cho bút toán đảo.

#### 21.3.3. Kiểm kho chi tiết hơn (B3)

**Học từ:** KiotViet chia tab Tất cả / Khớp / Lệch / Chưa kiểm, tự tính giá trị lệch = số lượng lệch × giá vốn, cho xuất hủy ngay trong lúc kiểm. Odoo cho chọn khởi tạo số đếm bằng tồn hiện có hoặc bằng 0, và tô đỏ dòng lệch.

**Bổ sung vào §5.7:**
- Màn kiểm (tablet & web) có 4 tab: **Tất cả · Khớp · Lệch · Chưa kiểm**; tổng **giá trị lệch** (theo `landed_cost_per_kg` của lô) hiển thị cho cửa hàng trưởng **sau khi** chốt số đếm (giữ nguyên đếm mù).
- Số đếm mặc định = **0/trống** (đếm mù); không có chế độ "điền sẵn số tồn".
- Khi đếm thấy hàng hỏng → nút **"Hủy ngay"** trên dòng: nhập số hủy + ảnh → sinh phiếu hủy `DRAFT` liên kết phiếu kiểm (duyệt theo luồng hủy thường), phần hủy không tính vào hao hụt.
- Tùy chọn khi tạo phiếu: kiểm theo nhóm hàng / theo vị trí / theo danh sách; có/không gồm SKU tồn = 0.
- "Chưa kiểm" khi hoàn thành: chọn **giữ nguyên tồn** (mặc định) hoặc **coi như 0** (cần quyền Master).
- Xuất file tổng quan / chi tiết phiếu kiểm (để giải trình hao hụt với cổ đông nếu cần).

#### 21.3.4. Xuất dùng nội bộ (B4)

- Loại phát sinh `INTERNAL_USE` (thêm lại vào §5.2): trưng bày/trang trí, biếu tặng đối tác, nhân viên dùng, làm mẫu chụp ảnh.
- Phiếu: lô, gram/số quả, mục đích (danh mục), người nhận, ảnh (tùy chọn), duyệt theo hạn mức như phiếu hủy.
- Báo cáo riêng, **không gộp** vào hao hụt hay hủy.

#### 21.3.5. Chi phí nhập hàng mở rộng (B5)

**Học từ:** KiotViet cấu hình các loại chi phí nhập, phân bổ vào giá vốn, và khi trả hàng nhập thì tự gợi ý **chi phí nhập hoàn lại** theo tỷ lệ hàng trả (sửa được). Odoo phân bổ chi phí theo khối lượng, thể tích, giá trị, số lượng hoặc chia đều.

**Bổ sung vào §5.4:**
- Danh mục `landed_cost_types`: Cước xe lạnh, Bốc xếp, Phí cảng/kiểm dịch, Phí chợ, Khác — mỗi loại có **cách phân bổ mặc định** và cờ "NCC trả lại khi trả hàng" (có/không).
- Cách phân bổ: **theo khối lượng tịnh** (mặc định cho hoa quả) · theo giá trị · theo số thùng · chia đều theo dòng · chỉ định tay.
- Phân loại chi phí: **trả NCC** (cộng vào công nợ NCC) hoặc **trả bên khác** (xe thuê ngoài, bốc xếp — ghi chi trong sổ quỹ).
- **Trả hàng NCC**: hệ thống gợi ý **chi phí nhập hoàn lại** = chi phí đã phân bổ cho phần hàng trả (theo tỷ lệ), người dùng chỉnh/bỏ từng khoản; phần không được hoàn → giữ trong giá vốn phần còn lại hoặc ghi chi phí (cấu hình).
- Báo cáo "Ảnh hưởng chi phí nhập lên giá vốn" theo phiếu & theo SKU.

#### 21.3.6. Đặt hàng nhập, bảng giá NCC & bổ sung hàng (B6)

**Học từ:** Odoo lưu trên mỗi sản phẩm **bảng giá NCC** (giá, số lượng tối thiểu, thời gian giao); quy tắc min/max: khi dự báo tồn xuống dưới min thì gợi ý đặt **= Max − tồn dự báo**; màn **Replenishment** cho "Đặt 1 lần" hoặc "Tự động". KiotViet có "Đặt hàng nhập" và "Dự kiến hết hàng".

**Bản gọn cho v3.2 (đưa vào G6):**
- `supplier_prices(supplier_id, sku_id, unit, price, min_qty, lead_time_days, valid_from, valid_to)` — cập nhật tự động giá lần nhập gần nhất; nhiều NCC/SKU, có NCC ưu tiên.
- **Đặt hàng nhập (PO)**: `DRAFT → SENT → PARTIALLY_RECEIVED → RECEIVED → CLOSED` / `CANCELLED`; nhận hàng từ PO tự điền dòng; nhận thiếu → PO còn mở phần thiếu hoặc đóng.
- **Quy tắc tồn min/max theo (vị trí, SKU)**, đơn vị gram/quả; **max bị giới hạn bởi hạn dùng**: `max ≤ bán_TB_ngày × (shelf_life_days − ngày_an_toàn)`.
- **Dự kiến hết hàng** = tồn khả dụng / bán TB ngày (14 ngày gần nhất) → hiển thị "còn ~1,5 ngày".
- **Màn Bổ sung hàng** (Master & kho): danh sách SKU dưới min ở từng cửa hàng → nút "Tạo phiếu điều chuyển nháp" từ kho tổng; kho tổng dưới min → "Tạo PO nháp" cho NCC ưu tiên. **Không tự động gửi** — luôn qua người duyệt (hoa quả biến động theo mùa/giá chợ).

#### 21.3.7. Các mốc ngày của lô (B7)

**Học từ:** Odoo theo dõi trên mỗi lô: hạn dùng, ngày ngừng xuất (removal date = hạn dùng trừ N ngày), ngày cảnh báo; chiến lược FEFO dựa trên ngày ngừng xuất.

**Bổ sung vào §5.5:** mỗi lô có 3 mốc, tính tự động từ ngày nhận + tham số SKU (sửa được trên lô):

| Mốc | Tham số SKU | Hệ thống làm gì |
|---|---|---|
| `alert_date` (cảnh báo) | `alert_days_before_expiry` | Đưa vào danh sách "sắp hết hạn", gợi ý đẩy app / giảm giá |
| `stop_sell_app_date` (ngừng bán qua app & đơn sỉ) | `stop_app_days_before_expiry` | Không phân bổ lô này cho đơn app/đơn sỉ (giao xong khách còn kịp ăn); vẫn bán tại quầy, thường kèm giảm giá |
| `expiry_date` (hạn dùng) | `shelf_life_days` | Chặn bán; chỉ cho hủy, sơ chế (nếu còn dùng được, cửa hàng trưởng xác nhận) hoặc dùng nội bộ |

- FEFO sắp theo `expiry_date`; với đơn app/sỉ bỏ qua lô đã qua `stop_sell_app_date`.
- Ba mốc này **bổ trợ** cho độ chín (§5.6): độ chín do người kiểm tra xác nhận, mốc ngày do hệ thống tính.

#### 21.3.8. Bảng quy tắc mã vạch (B8)

**Học từ:** Odoo dùng "barcode nomenclature" — các quy tắc khai báo loại (hàng cân, hàng có giá…) và mẫu; mặc định mã cân EAN bắt đầu bằng 21 với 5 số trọng lượng. Module OCA cho quét mã **nhúng giá** rồi tính ngược ra khối lượng = giá trên tem ÷ đơn giá/kg.

**Chuẩn hóa §6.5 thành bảng `barcode_rules`** (Master cấu hình, POS tải về):

| Trường | Ý nghĩa |
|---|---|
| `priority` | Thứ tự thử khớp |
| `type` | `WEIGHT` (nhúng gram) · `PRICE` (nhúng tiền) · `PRODUCT` (mã thường) · `BATCH` (tem lô QR) · `ORDER` (tem túi) · `STAFF` (thẻ nhân viên) |
| `pattern` | Ví dụ `20{PLU:5}{W:5}{C}`, `21{PLU:5}{P:5}{C}`, `MF-B{ID}` |
| `value_scale` | Đơn vị phần nhúng: gram / 10 g / đồng / 100 đồng |
| `checksum` | EAN-13 / không |

**Hàng nhúng giá (PRICE):** tiền dòng = **giá trên tem** (không tính lại); khối lượng ghi sổ kho = giá tem ÷ giá/kg hiện hành × 1000 (làm tròn gram) → nếu giá/kg đã đổi so với lúc in tem thì khối lượng suy ra sẽ sai → POS cảnh báo "tem in theo giá cũ", khuyến nghị dùng mẫu **nhúng trọng lượng (W1)** làm mặc định.

#### 21.3.9. Nhiều nhân viên trên 1 quầy (B9)

**Học từ:** Odoo cho nhiều nhân viên đăng nhập cùng một phiên quầy, đổi người bằng cách khóa màn hình rồi quét thẻ, chọn tên hoặc nhập PIN; ghi nhận nhân viên trên từng đơn; phân mức quyền cơ bản / nâng cao.

**Bổ sung vào §6.2:**
- **Ca gắn với quầy + người chịu trách nhiệm két** (người mở ca). Trong ca, nhân viên khác được **chuyển người bán** bằng: quét **thẻ nhân viên** (mã vạch/QR in từ trang quản lý) hoặc chọn tên + PIN.
- Nút **Khóa màn hình** (tự khóa sau N phút không thao tác).
- Mỗi hóa đơn/dòng xóa/giảm giá ghi `staff_id` người thao tác; báo cáo theo nhân viên.
- Thao tác cần quyền cao hơn (hủy hóa đơn, mở két, cân tay) → **quản lý quét thẻ/nhập PIN tại chỗ** để duyệt, không cần đăng xuất người đang bán.
- Đóng ca vẫn do người chịu trách nhiệm két (hoặc cửa hàng trưởng).
- **Bảo mật thẻ:** thẻ in ra có thể bị mượn → mặc định yêu cầu **thẻ + PIN** cho thao tác duyệt; chỉ thẻ cho đổi người bán (cấu hình).

#### 21.3.10. Đóng ca đối chiếu theo từng phương thức (B10)

**Học từ:** Odoo đặt **mức chênh lệch cho phép**; người không có quyền nhập chênh lệch vượt mức thì việc đóng phiên bị khóa cho đến khi quản lý duyệt; nhập số đếm theo mệnh giá; ghi chú đóng phiên.

**Bổ sung vào §6.2:**
| Phương thức | Số hệ thống | Số thực tế | Cách lấy số thực tế |
|---|---|---|---|
| Tiền mặt | Σ thu tiền mặt − chi + đầu ca | Đếm mù theo mệnh giá | Nhập tay |
| VietQR (SePay) | Σ hóa đơn trả QR | Σ giao dịch SePay của các VA trong ca | **Tự động** |
| Chuyển khoản thủ công | Σ đã xác nhận | Cửa hàng trưởng đối chiếu app ngân hàng | Tick từng dòng |
| COD shipper nộp | Σ phiếu thu COD | Đếm cùng tiền mặt | — |

- `max_cash_difference` cấu hình theo cửa hàng (ví dụ 20.000đ). Vượt → **khóa đóng ca** đến khi cửa hàng trưởng (thẻ + PIN) hoặc Master duyệt kèm lý do.
- Ghi chú đóng ca bắt buộc khi có chênh lệch.
- In **Báo cáo cuối ca/cuối ngày khổ K80** ngay tại quầy (như KiotViet): tổng bán, theo phương thức, trả hàng, thu/chi, chênh lệch, số dòng xóa, mở két.

#### 21.3.11. Đổi – trả trong một màn hình (B11)

**Học từ:** KiotViet cho trả và đổi/mua mới trong cùng một cửa sổ; có phí trả hàng; **cần trả khách = tổng giá hàng trả − phí trả hàng**; tạo phiếu chi trả khách trong sổ quỹ; cấu hình thời hạn trả hàng.

**Bổ sung vào §6.7:**
- Màn **Đổi/Trả**: quét/tìm hóa đơn gốc → chọn dòng & khối lượng trả (≤ đã mua, tính theo **đơn giá thực trả** sau giảm giá) → (tùy chọn) thêm hàng mua mới → hệ thống tính **chênh lệch**: khách trả thêm hoặc cửa hàng trả lại.
- **Thời hạn trả** cấu hình (mặc định 24 giờ cho hàng tươi); quá hạn chỉ cửa hàng trưởng mới cho.
- Phí trả hàng (mặc định 0đ với hàng lỗi; cấu hình nếu khách đổi ý).
- Hàng tươi trả lại: chọn **Nhập lại kệ** (còn tốt) / **Hủy** (hỏng) / **Chuyển sơ chế** — mặc định Hủy.
- Sinh phiếu chi/thu trong sổ quỹ; hoàn qua VietQR thì tạo lệnh hoàn chuyển khoản.

#### 21.3.12. Đơn đặt giữ hàng tại cửa hàng (B12)

**Học từ:** KiotViet có "Đặt hàng của khách" để ghi nhận nhu cầu và giữ hàng, tùy chọn chặn bán phần đã đặt.

**Áp dụng:** khách quen gọi điện/nhắn Zalo đặt hàng (rất phổ biến ở cửa hàng hoa quả):
- Trên POS/tablet: **"Tạo đơn đặt"** → khách (SĐT), dòng hàng, giờ lấy/giao, ghi chú độ chín → **giữ tồn** (như đơn app).
- Dùng lại luồng đơn app (§8.3) với `channel = PHONE`: soạn – cân – ảnh – thanh toán (VietQR gửi qua Zalo bằng link / tiền mặt khi lấy / COD).
- Tùy chọn **gửi link theo dõi đơn** qua SMS/Zalo cho khách không dùng app.
- Đơn đặt quá giờ lấy N giờ → nhắc; quá hạn → hủy, nhả tồn.

#### 21.3.13. Khóa sổ theo cửa hàng & chặn lùi ngày (B13)

**Học từ:** KiotViet khóa sổ đến một ngày cho từng chi nhánh — sau đó chặn tạo, sửa, xóa hoặc đổi ngày giao dịch về trước ngày khóa; có tùy chọn **khóa sửa thời gian giao dịch** để chống gian lận.

**Bổ sung vào §10.4.4:**
- `store_lock_dates(store_id, locked_until)` + khóa toàn chuỗi; Master đặt.
- **Ngày giao dịch luôn do máy chủ ghi** (POS offline dùng giờ máy, máy chủ kiểm tra lệch giờ > 10 phút → cảnh báo). Không có ô sửa ngày trên mọi chứng từ, trừ phiếu nhập NCC (ngày chứng từ NCC — tách riêng với ngày ghi sổ).
- Chứng từ phát sinh sau ngày khóa nhưng thuộc ngày trước (ví dụ hóa đơn offline đồng bộ muộn) → ghi vào **ngày đồng bộ** + đánh dấu "phát sinh muộn", báo Master.

#### 21.3.14. Quy tắc mã giao dịch (B14)

**Học từ:** KiotViet cho 3 kiểu mã: tăng dần (tiền tố + 6 số), theo thời gian (nhúng ngày giờ, hợp nhiều chi nhánh), ngẫu nhiên 11 ký tự để **giấu quy mô đơn hàng** với đối thủ.

**Áp dụng:**
| Chứng từ | Kiểu mã |
|---|---|
| Hóa đơn POS | Theo thời gian + cửa hàng: `CH01-251117-0042` (dễ tra tại quầy) |
| **Đơn app (khách nhìn thấy)** | **Ngẫu nhiên** 8 ký tự không nhầm lẫn: `APP-7KQ2XH9M` — tránh lộ số đơn/ngày |
| Đơn sỉ, phiếu kho, PO | Tăng dần theo loại: `WS-000123`, `PN-000456` |
| Lô | `B{yyMMdd}-{số}` |

#### 21.3.15. Sổ quỹ (B15)

**Học từ:** KiotViet có sổ quỹ tiền mặt và sổ quỹ ngân hàng (dòng tiền vào/ra), quản lý danh sách tài khoản ngân hàng/ví dùng cho thu chi.

**Bổ sung vào §6.10:**
- `cash_accounts`: quỹ tiền mặt từng cửa hàng, quỹ tiền mặt văn phòng, **tài khoản BIDV (SePay)**, tài khoản khác.
- **Sổ quỹ ngân hàng tự động**: mọi giao dịch SePay (vào) đã khớp → dòng thu; giao dịch chưa khớp → dòng "chờ khớp".
- Phiếu thu/chi có loại (bán hàng, thu nợ sỉ, COD, chi NCC, chi vận hành, nộp tiền về công ty, chuyển quỹ), đối tượng, chứng từ ảnh.
- Báo cáo **Sổ quỹ**: tồn đầu – thu – chi – tồn cuối theo quỹ & kỳ; xuất Excel cho kế toán công ty.

#### 21.3.16. Báo cáo bổ sung (B16)

**Học từ:** báo cáo hàng hóa KiotViet có 7 góc nhìn: bán hàng, lợi nhuận, xuất nhập tồn, xuất nhập tồn chi tiết, nhân viên theo hàng bán, khách theo hàng bán, NCC theo hàng nhập; ngoài ra có báo cáo giá trị kho, công nợ, sổ quỹ, cuối ngày.

**Thêm vào §11.2:**
| # | Báo cáo | Master | Viewer |
|---|---|---|---|
| R17 | Xuất – nhập – tồn **chi tiết theo lô** (mỗi phát sinh) | Có | — |
| R18 | Nhân viên theo hàng bán (doanh thu, kg, số hóa đơn, dòng xóa/giảm giá theo nhân viên) | Có | EXECUTIVE (tổng hợp) |
| R19 | NCC theo hàng nhập (kg, giá TB, chi phí nhập, tỷ lệ loại/hủy) | Có | Qua snapshot |
| R20 | Giá trị kho hiện tại theo vị trí/SKU/lô (theo giá nhập landed) | Có | Qua snapshot |
| R21 | Công nợ phải thu (khách sỉ) & phải trả (NCC), tuổi nợ | Có | Qua snapshot (tổng hợp) |
| R22 | Sổ quỹ (§21.3.15) | Có | — |
| R23 | Dự kiến hết hàng & đề xuất bổ sung (§21.3.6) | Có | — |
| R24 | Xuất dùng nội bộ (§21.3.4) | Có | Qua snapshot |

#### 21.3.17. Nhập/xuất Excel & in tem hàng loạt (B17)

**Học từ:** KiotViet nhập/xuất danh sách hàng hóa từ Excel theo file mẫu, có tùy chọn xử lý **trùng mã hàng/mã vạch**; in tem mã vạch; Odoo có trình xuất file PLU cho cân với **quyền riêng** cho người được xuất.

**Bổ sung:**
- **Nhập Excel** (file mẫu tải từ trang quản lý): SKU + đơn vị + giá lẻ + PLU; NCC; khách sỉ + bảng giá sỉ; **tồn đầu kỳ theo lô** (vị trí, SKU, gram/quả, giá nhập landed, ngày nhận, hạn dùng); giỏ quà & công thức sơ chế (§18.6).
  - Bước **kiểm tra trước** (dry-run): báo lỗi từng dòng; chọn cách xử lý trùng mã: **bỏ qua / cập nhật / dừng**.
  - Nhập tồn đầu kỳ tạo chứng từ `OPENING_BALANCE` (loại phát sinh mới, dấu +), chỉ làm được **trước ngày bắt đầu vận hành** hoặc với quyền Master.
- **Xuất Excel** mọi danh sách.
- **In tem hàng loạt**: tem giá kệ (tên, giá/kg, xuất xứ), tem mã vạch hộp, tem lô.
- **Xuất file PLU** cho cân in tem: chỉ SKU đánh dấu "bán qua cân", quyền `plu:export`, ghi log.

#### 21.3.18. Tồn khả dụng của giỏ/combo (B18)

- `ATP(giỏ) = min( ATP(thành phần i) ÷ định mức i )` (làm tròn xuống), xét cả bao bì.
- Áp dụng khi đẩy giỏ quà lên app hoặc nhận đơn sỉ giỏ quà — hệ thống báo số giỏ tối đa làm được và thành phần đang "nút cổ chai".
- Giỏ đã lắp sẵn (có tồn riêng) cộng thêm vào ATP.

#### 21.3.19. Vị trí mặc định theo SKU (B19)

- `sku_default_locations(store_id, sku_id, location_id)` — kệ/tủ mát nơi đặt hàng thường xuyên.
- Màn soạn đơn sắp danh sách theo **lộ trình vị trí** (thứ tự kệ) để nhặt nhanh; kiểm kê theo vị trí.

### 21.4. Những gì KHÔNG học theo — và lý do

| Tính năng ở KiotViet/Odoo | Lý do không áp dụng |
|---|---|
| **Giá vốn bình quân** (KiotViet: cố định hoặc bình quân; Odoo: AVCO/FIFO) | Giá nhập hoa quả thay đổi theo từng chuyến; bình quân che mất lô nào lời/lỗ. Giữ **giá vốn theo lô** (§5.12) — vẫn hiển thị thêm "giá vốn bình quân kỳ" trong báo cáo để tham khảo |
| **Bán âm kho tự do** | Chỉ cho âm tạm ở cửa hàng khi offline/cân lệch, có cảnh báo (§5.1); kho tổng không cho âm |
| Đặt hàng tự động gửi NCC (Odoo auto reordering) | Giá chợ & chất lượng biến động hằng ngày — chỉ tạo phiếu nháp, người duyệt (§21.3.6) |
| Thuế VAT, kê khai, hóa đơn điện tử | Ngoài phạm vi (công ty tự làm) |
| Tích điểm, coupon, voucher nhiều loại | D11 — để sau |
| Kết nối sàn TMĐT, website bán hàng | App chỉ bán mặt hàng đẩy (D17) |
| Bảo hành – bảo trì, serial/IMEI | Không liên quan hoa quả |
| Kế toán kép (bút toán, sổ cái) | Chỉ xuất dữ liệu Excel cho kế toán công ty |

### 21.5. Kế hoạch chuyển đổi dữ liệu & đưa vào vận hành (go-live)

Thiếu ở v3.1; KiotViet/Odoo đều có công cụ nhập liệu ban đầu — áp dụng thành quy trình:

| Bước | Thời điểm | Việc |
|---|---|---|
| 1 | T−14 ngày | Nhập Excel danh mục (SKU, đơn vị, giá, PLU), NCC, khách sỉ, nhân viên, cửa hàng, thiết bị → kiểm tra trên staging |
| 2 | T−7 | Nạp PLU vào cân in tem; in tem giá kệ; in thẻ nhân viên; đào tạo thu ngân trên staging (bán thử, đóng ca thử) |
| 3 | T−3 | Chạy song song 1 cửa hàng thử (hệ cũ vẫn là chính) — so doanh thu cuối ngày 2 hệ |
| 4 | T−1 tối | Chốt hệ cũ; **kiểm kê toàn bộ** kho tổng + cửa hàng (cân theo lô, ghi hạn dùng ước tính) |
| 5 | T−1 đêm | Nhập **tồn đầu kỳ theo lô** (`OPENING_BALANCE`) + công nợ đầu kỳ khách sỉ/NCC; Master đối chiếu tổng giá trị |
| 6 | T (ngày đầu) | Mở bán; hỗ trợ tại chỗ; theo dõi Sentry, hàng đợi, webhook SePay |
| 7 | T+1 → T+7 | Kiểm kê xoay vòng hằng ngày để phát hiện sai lệch tồn đầu kỳ; chỉnh sửa định mức, PLU, giá |

Khuyến nghị: **không go-live trong 3 tuần trước Tết** hoặc dịp lễ cao điểm.

### 21.6. Ảnh hưởng tới lộ trình

| Bổ sung | Đưa vào giai đoạn | Thêm thời gian |
|---|---|---|
| B1 đơn vị tính, B2 vòng đời chứng từ, B3 kiểm kho, B4 dùng nội bộ, B5 chi phí nhập, B7 mốc ngày lô, B17 nhập Excel & tồn đầu kỳ, B19 vị trí | G1 | +1,5 tuần |
| B8 bảng quy tắc mã vạch, B9 nhiều nhân viên/quầy, B10 đóng ca theo phương thức, B11 đổi–trả, B13 khóa sổ & chặn lùi ngày, B14 mã giao dịch, B15 sổ quỹ | G2 | +1 tuần |
| B16 báo cáo bổ sung | G3 | +0,5 tuần |
| B12 đơn đặt giữ hàng, B18 tồn giỏ | G4 | +0,5 tuần |
| B6 PO + min/max + bổ sung hàng | G6 | +1 tuần |
| Go-live §21.5 | Sau G2 (cửa hàng đầu tiên) | — |

**Tổng lộ trình mới: khoảng 26–27 tuần (~6 tháng).**

### 21.7. Bổ sung kịch bản nghiệm thu

| # | Kịch bản | Kết quả mong đợi |
|---|---|---|
| T26 | Bán 2 hộp nho 500 g (đơn vị "Hộp") và 0,73 kg nho rời cùng SKU | Tồn SKU giảm 1.730 g; báo cáo bán theo đơn vị đúng |
| T27 | Nhận 3 thùng nho "danh nghĩa 5 kg", cân tịnh 14,62 kg | Tồn +14.620 g, không cộng 15 kg |
| T28 | Hủy phiếu kiểm kho đã hoàn thành | Sinh bút toán đảo; tồn quay về như trước khi kiểm; phiếu hiện "Đã hủy" |
| T29 | Hủy phiếu nhận hàng mà lô đã bán một phần | Bị chặn; gợi ý điều chỉnh |
| T30 | Đang kiểm kho bấm "Hủy ngay" 0,4 kg dập | Sinh phiếu hủy nháp liên kết; 0,4 kg không tính vào hao hụt |
| T31 | Trả NCC 20% lô có chi phí xe 500.000đ | Gợi ý chi phí nhập hoàn lại 100.000đ; sửa được |
| T32 | Lô qua `stop_sell_app_date` | Không được phân bổ cho đơn app/sỉ; vẫn bán tại quầy |
| T33 | Quét tem nhúng giá `21…` khi giá/kg đã đổi | Tiền dòng = giá tem; POS cảnh báo "tem giá cũ" |
| T34 | Nhân viên B quét thẻ đổi người bán giữa ca của A | Hóa đơn sau ghi B; ca vẫn của A |
| T35 | Đóng ca chênh 50.000đ (ngưỡng 20.000đ) | Khóa đóng ca đến khi cửa hàng trưởng duyệt + lý do |
| T36 | Đối chiếu QR khi đóng ca | Số thực tế QR tự lấy từ SePay, khớp với hệ thống |
| T37 | Khách đổi 0,5 kg cam lấy 0,6 kg quýt trong 1 màn hình | Tính đúng chênh lệch; cam trả mặc định ghi hủy |
| T38 | Tạo đơn đặt qua điện thoại, giữ 2 kg xoài | Tồn khả dụng giảm 2 kg; đơn vào hàng đợi soạn |
| T39 | Cố sửa ngày hóa đơn về hôm qua | Không có chức năng; API từ chối |
| T40 | Nhập Excel 200 SKU, 3 dòng trùng mã vạch, chọn "bỏ qua" | 197 dòng nhập, báo cáo 3 dòng bị bỏ |
| T41 | Giỏ quà cần 3 táo/giỏ, còn 10 táo; các thành phần khác dư | ATP giỏ = 3, báo "nút cổ chai: táo" |

### 21.8. Bổ sung CSDL & mã quyền (tóm tắt)

```
units, sku_units, sku_default_locations, landed_cost_types, supplier_prices,
purchase_orders, purchase_order_lines, reorder_rules(location_id, sku_id, min_g, max_g, min_units, max_units),
internal_use_logs, barcode_rules, staff_badges(staff_id, badge_code_hash, issued_at, revoked_at),
shift_staff_sessions(shift_id, staff_id, from, to), shift_payment_counts(shift_id, method, expected, counted, diff),
returns(id, original_sale_id, type, fee_amount, ...), return_lines(...),
phone_orders → dùng app_orders với channel = PHONE,
store_lock_dates, code_sequences(doc_type, mode, prefix, next_value),
cash_accounts, cash_entries(account_id, type, category, amount, ref_type, ref_id, ...),
import_jobs(id, type, file_id, mode_on_duplicate, status, report jsonb)
inventory_batches + alert_date, stop_sell_app_date
stock_movements + reversal_of_id ; movement_type + INTERNAL_USE, OPENING_BALANCE
```
Mã quyền mới: `unit:write`, `po:write`, `po:approve`, `reorder:write`, `internal_use:create|approve`, `barcode_rule:write`, `badge:issue`, `return:create`, `phone_order:create`, `lock_date:write`, `cash_account:write`, `import:run`, `plu:export`, `document:cancel`.

### 21.9. Nguồn tham khảo cho phần đối chiếu

- KiotViet — Thiết lập cửa hàng: https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/retail-thiet-lap/thiet-lap-cua-hang/
- KiotViet — Kiểm kho: https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/fnb-hang-hoa/kiem-kho/ · https://kiotviet.vn/huong-dan-su-dung-kiotviet/kiem-kho-booking
- KiotViet — Xuất hủy: https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/salon-hang-hoa/xuat-huy/
- KiotViet — Hàng hóa Lô – Hạn sử dụng: https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/retail-hang-hoa/hang-hoa-lo-han-su-dung/
- KiotViet — Chi phí nhập hàng: https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/retail-giao-dich/chi-phi-nhap-hang/
- KiotViet — Danh sách hàng hóa (Excel, tem, dự kiến hết hàng): https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/retail-hang-hoa/danh-sach-hang-hoa/
- KiotViet — Danh mục hàng hóa (menu chức năng): https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/huong-dan-bar-cafe-nha-hang/danh-muc-hang-hoa-web-fnb/
- KiotViet — Nông sản, thực phẩm & cân điện tử: https://www.kiotviet.vn/phan-mem-quan-ly-cua-hang-nong-san-thuc-pham-tich-hop-can-dien-tu-ban-hang-nhanh-chong/
- KiotViet — Đổi trả hàng: https://www.kiotviet.vn/ki-ot-viet-ra-mat-tinh-nang-doi-tra-hang/
- KiotViet — Báo cáo hàng hóa: https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/huong-dan-bao-cao/bao-cao-hang-hoa/ · Sổ quỹ: https://www.kiotviet.vn/wiki-ki-ot-viet/bao-cao-wiki/so-quy-wiki/
- Odoo — Barcode nomenclature: https://www.odoo.com/documentation/17.0/applications/inventory_and_mrp/barcode/operations/barcode_nomenclature.html
- OCA — POS Price to Weight: https://odoo-community.org/shop/point-of-sale-price-to-weight-1862
- Odoo — FEFO: https://www.odoo.com/documentation/17.0/applications/inventory_and_mrp/inventory/shipping_receiving/removal_strategies/fefo.html · Expiration dates: https://www.odoo.com/documentation/master/applications/inventory_and_mrp/inventory/product_management/product_tracking/expiration_dates.html
- Odoo — Landed costs: https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/product_management/inventory_valuation/landed_costs.html
- Odoo — Units of measure: https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/product_management/configure/uom.html
- Odoo — Reordering rules: https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/replenishment/reordering_rules.html
- Odoo — Multi-employee POS: https://www.odoo.com/documentation/16.0/applications/sales/point_of_sale/employee_login.html
- Odoo — Cash control (Hibou): https://hibou.io/docs/point-of-sale-pos-67/pos-advanced-cash-control-1335

---
*Hết tài liệu — Đặc tả hệ thống v3.2*
