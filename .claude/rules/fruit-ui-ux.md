---
paths:
  - "apps/customer_app/**"
  - "apps/staff_app/**"
  - "apps/admin-web/**"
  - "docs/engineering/ux/**"
---

# Fruit Retail design routing

Chọn đúng skill, không nạp cả 5 cho việc backend:
- `ui-ux-pro-max` — tra cứu/rà thiết kế, bố cục, tương tác, a11y.
- `design-system` — token ngữ nghĩa và hợp đồng trạng thái component dùng chung.
- `ui-styling` — hiện thực Flutter native (customer_app, staff_app) hoặc Next.js (admin-web).
- `brand` — giọng văn, nhận diện, chữ trên phiếu/tem/thông báo (theo `brand_settings` §18.5).
- `banner-design` — ảnh/khối quảng bá mặt hàng đẩy và thông báo trên app (§7.3, §7.4).

Mỗi skill đọc `references/fruit-integration.md` trước khi dùng. Mã nguồn hiện có, ADR và danh sách màn hình
`docs/engineering/ux/screens.md` (CP01) thắng ví dụ upstream và kết quả tìm kiếm.

Ba bề mặt, ba ưu tiên:
- **POS quầy (staff_app counter, Windows):** tốc độ là chức năng — §6.1 (≤ 1,5 s từ cân đến dòng, quét tem
  ≤ 0,5 s, giao dịch 5 món ≤ 20 s); nút lớn cho cảm ứng + phím tắt; luôn hiện trạng thái cân/máy in/mạng/offline.
- **Tablet & shipper (staff_app, Android):** thao tác một tay, ảnh chụp trực tiếp, hàng đợi soạn đơn, trạng thái
  đồng bộ.
- **App người dùng (customer_app):** thông báo + mặt hàng đẩy trong vùng giao, chạy tốt trên Android cấu hình
  thấp; giá hàng cân trước khi cân luôn ghi "giá tham khảo"; xóa tài khoản, bật/tắt thông báo (§7.7).
- **Admin web (admin-web):** Master (đủ chức năng §10.1) và Viewer (chỉ đọc §10.2, không có nút ghi — chỉ là trải
  nghiệm, không phải lớp bảo mật).

Hiển thị tiếng Việt: tiền `1.250.000đ`, cân `0,845 kg`, giờ Asia/Ho_Chi_Minh (§15). Định dạng chỉ qua
`money_weight`; UI không bao giờ tính lại tiền làm nguồn đúng. Viewer và nhân viên chỉ thấy PII đã che.
