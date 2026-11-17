# ADR-004: Tiền số nguyên VND, khối lượng gram, một helper `money_weight`

- Trạng thái: accepted
- Ngày: 2026-11-17 · Người quyết: phiên điều phối (theo D9 đã chốt) · Căn cứ SPEC: D9, §4.4, §12.1, §19.5, Phụ lục A

## Bối cảnh
Hàng cân tính đúng theo số cân thực, tới từng đồng, không dung sai (D9). Sai số float hoặc hai cách làm tròn khác
nhau giữa Dart và TS sẽ làm lệch tiền giữa POS, app và server.

## Quyết định
- Tiền VND: `BIGINT` (SQL) · `bigint` (TS) · `int` 64-bit (Dart, không chạy Dart trên web) · **chuỗi số nguyên**
  trong JSON/OpenAPI (`type: string, pattern: '^-?[0-9]+$'`, `format: vnd`). Đơn giá/kg là tiền (`*_per_kg`).
- Khối lượng: `INTEGER` gram (`*_g`) mọi tầng; kg chỉ để hiển thị.
- Công thức duy nhất: `lineAmount(pricePerKg, grams) = (pricePerKg × grams + 500) div 1000` với `pricePerKg, grams
  ≥ 0`; giá trị âm bị từ chối (đảo/hoàn dùng số đã ghi, không tính lại). Hàng đếm: `price_per_unit × units`.
- `packages/money_weight/` có 2 bản `ts/` và `dart/` + `vectors/money_weight.vectors.json` dùng chung (tối thiểu
  Phụ lục A: 114.950; 270.400; 55.665; biên 0 g, 1 g, làm tròn .5, giá trị lớn 10^10). Hàm: `lineAmount`,
  `unitsAmount`, `formatVnd` (`1.250.000đ`), `formatKg` (`0,845 kg`), `parseVndString`.
- Server là nguồn đúng (FR-INV-04); client dùng helper chỉ để hiển thị/xem trước.
- "Bớt lẻ" tiền mặt: dòng riêng `rounding_amount`, chỉ khi cấu hình bật, |x| ≤ 1.000đ.

## Phương án đã cân nhắc
| Phương án | Ưu | Nhược | Lý do loại |
|---|---|---|---|
| `NUMERIC` + decimal.js | Linh hoạt số lẻ | VND không có xu; thêm thư viện, dễ trộn kiểu | Không cần |
| Tiền JSON dạng number | Gọn | > 2^53 mất chính xác; JS ép float | Trái FR-INV-01 |

## Hệ quả
- Lint cấm `number` cho trường tiền (ESLint rule tùy chỉnh / review); OpenAPI generator map `format: vnd` → `bigint`
  (TS) và `int` (Dart).
- Test vector chạy trong CI ở cả TS và Dart; lệch là lỗi CRITICAL.
