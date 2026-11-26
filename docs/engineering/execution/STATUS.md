# STATUS — Tracker checkpoint (một người ghi: phiên điều phối)

Trạng thái: `CHƯA MỞ` → `ĐANG LÀM` → `CHỜ REVIEW` → `ĐẠT` (hoặc `CHẶN` + lý do + người gỡ).

| CP | Tên | Trạng thái | Ghi chú |
|---|---|---|---|
| CP00 | Chuẩn hóa quy trình `.claude` | ĐẠT | Tiến xác nhận 2026-11-17; review agent NOT RUN (chạy ở đầu CP01) — `checkpoints/CP00.md` |
| CP01 | Quyết định kiến trúc & hợp đồng | ĐẠT | Tiến xác nhận 2026-11-17 sau review agent — `checkpoints/CP01.md` |
| CP02 | Khung dự án & hạ tầng | CHẶN | Local xong, CI develop xanh, lát 9–10 merge (9cbb196). CHẶN: diễn tập khôi phục trên hạ tầng thật, staging HTTPS, giám sát (VPS, domain, S3 khác nhà cung cấp, Sentry, Telegram) — người gỡ: Tiến. Tiến quyết 2026-11-24 tạm bỏ qua để làm CP03 — `checkpoints/CP02.md` |
| CP03 | Nền tảng: auth, quyền, audit, outbox, file | ĐANG LÀM | Kế hoạch con 10 lát Tiến duyệt; lát 1 (schema nền) và lát 2 (khung request) SẠCH sau 4 vòng agent mỗi lát; lát 3 (auth Master/Viewer) SẠCH sau 4 vòng agent; lát 4 (auth nhân viên POS + thiết bị, mã ghi danh NC-20) SẠCH sau 2 vòng agent; lát 5 (OTP khách + giới hạn tần suất) SẠCH sau 2 vòng agent; lát 6 (RBAC theo phạm vi + cô lập Viewer) SẠCH sau 3 vòng agent; lát 7 (outbox relay + file S3) SẠCH sau 3 vòng agent; NC-19 + NC-21 Tiến đã quyết (migration 0004); lát 8a (API quản trị) SẠCH sau 3 vòng; NC-22 SẠCH sau 2 vòng; lát 8b (admin web BFF, ADR-027) SẠCH sau 3 vòng security + 2 vòng react; tiếp lát 9 — `checkpoints/CP03.md` |
| CP04 | Danh mục, đơn vị tính, giá | CHƯA MỞ | Cần dữ liệu thật SKU + giá |
| CP05 | Mua hàng & lô | CHƯA MỞ | |
| CP06 | Sổ kho: điều chuyển, kiểm kê, hủy, dùng nội bộ | CHƯA MỞ | |
| CP07 | POS lõi: bán, cân, tem cân, in | CHƯA MỞ | Cần thiết bị mẫu |
| CP08 | POS thanh toán SePay, ca, đóng ngày | CHƯA MỞ | Cần BIDV DN + SePay |
| CP09 | POS offline, đổi–trả, nhiều nhân viên, sổ quỹ | CHƯA MỞ | |
| CP10 | Báo cáo realtime & trang Master | CHƯA MỞ | |
| CP11 | ★ PILOT cửa hàng đầu tiên | CHƯA MỞ | |
| CP12 | Admin Chỉ Xem & phát hành báo cáo | CHƯA MỞ | |
| CP13 | Vùng giao, mặt hàng đẩy, thông báo | CHƯA MỞ | Cần Firebase, Play Console, key bản đồ |
| CP14 | App người dùng & đơn app | CHƯA MỞ | **Chặn trước khi bật SMS OTP thật (ADR-023 L2):** device attestation (Play Integrity / App Attest) hoặc CAPTCHA khi lượng gửi bất thường, cảnh báo 50–80% trần gửi, hạn mức riêng cho thiết bị đã xác minh — nếu không, ~7 khối IPv6 /48 hoặc ~67 IPv4 làm cạn trần 2000/giờ (DoS đăng nhập khách, tới 20.000 SMS/ngày) |
| CP15 | Giao hàng: shipper, Ahamove, COD | CHƯA MỞ | Cần Ahamove API key STG |
| CP16 | Đơn bán sỉ & công nợ | CHƯA MỞ | |
| CP17 | Độ chín, giảm giá lô, sơ chế, giỏ quà | CHƯA MỞ | |
| CP18 | Đặt hàng nhập & bổ sung hàng | CHƯA MỞ | |
| CP19 | Gia cố & mở rộng toàn chuỗi | CHƯA MỞ | |
