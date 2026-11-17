# ADR-005: Sổ kho chỉ-thêm và giá vốn theo lô

- Trạng thái: accepted
- Ngày: 2026-11-17 · Người quyết: phiên điều phối (theo SPEC) · Căn cứ SPEC: §5.1, §5.12, §12.4, §21.3.2, §21.4

## Bối cảnh
Hoa quả có giá nhập đổi theo từng chuyến; cần biết lô nào lời/lỗ, truy hao hụt, và không cho sửa ngầm tồn kho.

## Quyết định
- `core.stock_movements` chỉ INSERT: trigger `BEFORE UPDATE OR DELETE` gọi `core.raise_immutable()`; role `app_rw`
  không có quyền UPDATE/DELETE bảng này. Sai sót sửa bằng bút toán đảo (`reversal_of_id`, cùng `qty` trái dấu,
  cùng `unit_cost`).
- `core.stock_balances(location_id, batch_id, sku_id)` là projection, cập nhật **trong cùng transaction** với
  movement; có `version`. Job đối soát định kỳ so `SUM(movements)` với `balances`, lệch → cảnh báo, không tự sửa.
- Kho tổng: CHECK + kiểm tra trong service `on_hand_g >= 0`. Cửa hàng: cho âm tạm chỉ khi nguồn là POS offline/cân
  lệch, phát `stock.negative`.
- Giá vốn = `landed_cost_per_kg` (hoặc `_per_unit`) của lô; mỗi movement xuất ghi `unit_cost_*` và `cost_amount`
  tại thời điểm xuất. Lô "chờ giá" ghi cost = NULL và báo cáo cảnh báo (T23); khi Master nhập giá → bút toán
  điều chỉnh giá vốn, không sửa movement cũ.
- Điều chuyển giữ nguyên `batch_id`; tách lô (độ chín, sơ chế) tạo lô con có `parent_batch_ids`.
- Vòng đời chứng từ `DRAFT → COMPLETED → CANCELLED` (ADR này áp cho mọi chứng từ kho/mua); hủy = đảo toàn bộ, bị
  chặn khi hàng đã xuất tiếp hoặc kỳ đã khóa.
- Thứ tự khóa khi ghi kho: chứng từ → `stock_balances` theo `(location_id, batch_id)` tăng dần → `stock_reservations`.

## Phương án đã cân nhắc
| Phương án | Ưu | Nhược | Lý do loại |
|---|---|---|---|
| Giá vốn bình quân | Đơn giản | Che lô lời/lỗ | §21.4 loại |
| Chỉ lưu tồn, không sổ | Nhẹ | Không truy vết | Trái §5.1 |

## Hệ quả
- Test DB bắt buộc: UPDATE/DELETE movement → lỗi; tồn = tổng movement sau chuỗi thao tác đồng thời.
- Báo cáo đọc movement/projection; "giá vốn bình quân kỳ" chỉ là số tham khảo.
