# Fruit Retail stack and integration contract

Dùng dự án hiện có, không dựng khung mới. Phiên bản theo `docs/engineering/architecture/versions.json`, lockfile và
`.claude/rules/fruit-engineering.md`. Không nâng gói theo ví dụ `@latest` của upstream.

| Bề mặt | Hiện thực | Ghi chú thiết kế |
| --- | --- | --- |
| App người dùng (A1) | `apps/customer_app` Flutter iOS/Android | Mặt hàng đẩy, vùng giao, theo dõi đơn, khiếu nại; Android cấu hình thấp |
| POS quầy (A2 counter) | `apps/staff_app` chế độ counter, Flutter Windows | Cảm ứng + bàn phím/máy quét; cân, máy in, két; offline |
| Tablet kho/soạn đơn (A2/A3) | `apps/staff_app` chế độ tablet, Flutter Android | Nhận hàng, kiểm kê, hủy, soạn đơn; camera |
| Shipper (A5) | `apps/staff_app` chế độ shipper, Flutter Android | Chuyến, trạng thái, ảnh giao, COD |
| Trang quản lý (A4) | `apps/admin-web` Next.js App Router, route group (master)/(viewer) | Bảng lớn, biểu đồ, bản đồ vẽ vùng; responsive dùng được trên điện thoại |

**Nguồn token:** `needs confirmation` (CONTEXT NC-02) — chốt ở CP có UI đầu tiên (CP07/CP10), ghi ADR. Màu chủ đạo, logo, tên thương
hiệu là dữ liệu cấu hình `brand_settings` (§18.5) do Master sửa; token ngữ nghĩa trong code không được hardcode
màu thương hiệu thay cho cấu hình. Khi nguồn token đã chốt: sửa nguồn rồi sinh lại cho cả Flutter và web qua đúng
công cụ sở hữu, không vá file sinh ra.

Flutter là UI Dart native: không dán JSX, Tailwind, shadcn, DOM/ARIA, CSS vào Flutter; chuyển ý đồ sang widget,
`Semantics`, focus/keyboard traversal, `SafeArea`, text scaling. Web: Server Components cho phần tĩnh/dữ liệu,
Client Components chỉ khi cần tương tác; quyền và tiền luôn do server quyết. shadcn/Radix chỉ dùng nếu đã chọn
trong ADR/dependencies.

**Màn hình & nhánh lỗi:** mỗi hành động trên màn phải khớp `docs/engineering/ux/screens.md` (CP01: U01–U14 §7.2,
POS §6, tablet, Admin §10.1–10.2). Thiết kế đủ nhánh: mất mạng/offline (POS vẫn bán tiền mặt), hết hàng / hết hạn
mức mặt hàng đẩy, thanh toán đang chờ (VA SePay chưa về), ngoài vùng giao, mất quyền / cần step-up, cân hoặc máy in
lỗi, xung đột phiên bản. Nút bị vô hiệu phải nói lý do và việc tiếp theo. Hiệu ứng lạc quan KHÔNG phải xác nhận
tiền, tồn hay hoàn tiền đã đổi ở server; giữ UX idempotency và polling.

**Nội dung:** vi-VN; tiền `1.250.000đ`, cân `0,845 kg`, giờ Asia/Ho_Chi_Minh; định dạng qua `money_weight`. Hàng
cân trên app: "giá tham khảo — tiền thật theo số cân". Không bịa khuyến mãi, đánh giá, số liệu; không nhắc tích
điểm, voucher, hóa đơn VAT (ngoài phạm vi). PII khách luôn hiện bản che với nhân viên/viewer (`***4321`).

**Trợ năng:** tương phản chữ thường ≥ 4.5:1, chữ lớn/thành phần UI ≥ 3:1; vùng chạm Android 48dp / iOS 44pt /
web 44px; POS nút lớn hơn cho cảm ứng; hỗ trợ chữ 200%, TalkBack/VoiceOver, bàn phím + focus rõ, nhãn cho nút
icon, giảm chuyển động; không dựa riêng vào màu (trạng thái lô, độ chín, cảnh báo cận hạn có chữ/icon). Kiểm
chiều rộng 320–430 (điện thoại), 768 (tablet), 1280+ (POS Windows/desktop); không cắt dấu tiếng Việt.

**Kiểm chứng:** chạy thật flutter analyze/widget/integration test và kiểm tra component/browser/a11y cho web phù
hợp phạm vi; ghi lệnh, phiên bản, exit code, ảnh chụp, giới hạn. Thiếu máy iOS/thiết bị thật/cân/máy in → ghi
CHẶN hoặc NOT RUN, không PASS. Thiết kế hoàn chỉnh không làm thay đổi trạng thái sẵn sàng của SePay/Ahamove/OTP.


## Riêng cho skill này

- Dùng `search.py` với stack `flutter` (mobile, POS Windows) và `nextjs` (admin-web); kết quả là bằng chứng tham khảo, không thay quyết định đã có.
