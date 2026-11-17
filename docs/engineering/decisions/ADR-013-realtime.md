# ADR-013: Realtime Socket.IO giữa API và worker

- Trạng thái: accepted · Ngày: 2026-11-17 · Căn cứ: §3.4 (p95 ≤ 3 s), §2.5, FR-INV-11

## Quyết định
- Gateway Socket.IO chạy trong `main.ts`; **`@socket.io/redis-adapter`** để nhiều instance chia room; worker phát
  bằng **`@socket.io/redis-emitter`** (không mở socket server trong worker).
- Socket chỉ **báo có thay đổi** (`{type, entity, id, version}`), không chở dữ liệu nhạy cảm; client gọi REST lấy
  trạng thái (§3.4). Với viewer, payload chỉ chứa id + version của dòng `reporting.*`.
- **Handshake:** JWT access trong `auth`; kiểm session còn hiệu lực; join room do **server** quyết theo allowlist:
  `store:{id}` (staff có quyền tại cửa hàng), `order:{id}` (đúng khách của đơn), `shipper:{id}` (chính shipper),
  `admin:master` (MASTER_ADMIN), `viewer:{profile_id}` (viewer được gán hồ sơ). Client không tự join. Token hết hạn
  ⇒ server ngắt.
- **Độ trễ:** outbox relay dùng `LISTEN/NOTIFY` (trigger `pg_notify` sau INSERT outbox) + poll dự phòng 500 ms;
  projector cập nhật `reporting.*` rồi emit. Đo p95 từ `occurred_at` đến emit.
- Hợp đồng: `packages/contracts/realtime/rooms.json` (room → ai được join → loại tin).

## Hệ quả
- CP03 thêm việc: gateway + xác thực handshake + test cô lập room viewer. CP10 đo p95.
