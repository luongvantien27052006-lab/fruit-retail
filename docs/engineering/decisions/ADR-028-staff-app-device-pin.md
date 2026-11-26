# ADR-028: Staff app Flutter — đăng ký máy, đăng nhập PIN, khóa màn hình (CP03 lát 9)

- Trạng thái: proposed (chờ kiểm thử agent) · Ngày: 2026-11-27 · Người quyết: phiên điều phối (CP03 lát 9)
- Làm rõ: ADR-008 (một codebase ba chế độ), ADR-012 (token, PIN offline để CP09), ADR-022 (thiết bị POS, mã ghi danh),
  SEC3, SPEC §21.3.9 (khóa màn hình)

## Quyết định
1. **Chế độ theo máy.** Windows chỉ có chế độ quầy (`counter`). Android chọn tablet hoặc shipper lúc đăng ký. Chế độ lưu
   cùng danh tính máy. Ở CP03 vai trò không lọc chế độ: token PIN không mang vai trò, và API kiểm quyền mỗi thao tác. Lọc
   theo vai trò làm khi có màn nghiệp vụ (CP07/CP14/CP15).
2. **Danh tính máy:**
   - Máy tự sinh UUID làm `X-Device-Id`, cùng khóa Ed25519 (thư viện `cryptography`, seed 32 byte).
   - Danh tính được lưu trong `flutter_secure_storage`: Windows dùng DPAPI theo tài khoản Windows, Android dùng Keystore.
   - Chỉ lưu sau khi server đã nhận đăng ký; đăng ký lỗi không để lại khóa mồ côi.
   - Dữ liệu lưu hỏng hoặc khác phiên bản thì coi như máy chưa đăng ký.
   - Máy bị thu hồi thì xóa khóa và phải đăng ký lại bằng mã ghi danh mới.
3. **Chữ ký thiết bị.** Thông điệp khớp `apps/api/src/auth/device-proof.ts`, có test vector sinh từ `node:crypto`. Ed25519
   tất định nên chữ ký Dart trùng từng byte. Ràng buộc từng mục đích:
   - register: mã ghi danh dạng chuẩn + "\n" + khóa công khai;
   - pin: mã NV (trim, chữ HOA);
   - refresh: base64url(SHA-256(refresh token)).

   Hợp đồng `DeviceProof` trước đây mô tả sai ràng buộc register (`store_code`); đã sửa thành mã ghi danh.
4. **Phiên chỉ ở trong bộ nhớ.** Access và refresh không ghi xuống đĩa, nên tắt app hoặc khóa màn hình là phải nhập PIN
   lại. PIN offline (bản băm PIN cache 24 giờ, ADR-012) để CP09.
   - Refresh gộp các lời gọi song song thành một lần, vì refresh token dùng một lần và dùng lại thì server thu hồi phiên.
   - Request nhận 401 sau khi một lượt refresh khác đã xong thì gọi lại bằng access mới, không refresh thêm.
5. **Khóa màn hình:**
   - Có nút khóa, và tự khóa sau 5 phút không thao tác. Chạm hoặc gõ phím thì đặt lại đồng hồ. CP09 đưa N vào cấu hình
     cửa hàng.
   - Khóa nghĩa là thu hồi phiên ở server (`/auth/logout`, bỏ qua lỗi mạng), xóa phiên trong bộ nhớ, rồi về màn PIN, để
     người khác đăng nhập được ngay.
   - Đổi người mà giữ ca (`/pos/shifts/{id}/switch-staff`) để CP09.
6. **Địa chỉ API:**
   - Truyền bằng `--dart-define=API_BASE_URL`.
   - Chỉ cho phép https. Riêng máy dev được dùng http: localhost, 127.0.0.1, ::1, và 10.0.2.2 (emulator Android).
   - Không chấp nhận địa chỉ có userinfo, query hay fragment.
   - Cấu hình sai thì app hiện lỗi, không chạy tiếp.
7. **PIN trên giao diện:** PIN bị xóa khỏi ô nhập ngay khi gửi. Ô PIN là `obscureText`, chỉ nhận số, tối đa 6 ký tự, tắt
   gợi ý và tự sửa.

## Hệ quả
- Gói mới (staff_app):
  - `flutter_secure_storage` 11.2.0. Máy **build** Windows cần thành phần "C++ ATL" của VS Build Tools; máy quầy chạy
    bản đã build thì không cần.
  - `cryptography` 2.9.0, `http` 1.6.0, `uuid` 4.6.0.
- Test:
  - widget và unit test `apps/staff_app/test/*`;
  - chạy thật trên Windows: `apps/staff_app/integration_test/live_api_test.dart`, do `apps/api/test-e2e/staff-app.e2e.ts`
    điều phối. Bài này dựng API thật trên PostgreSQL và Redis (Testcontainers), app Windows thật đăng ký máy, Master kích
    hoạt bằng mã ghép đọc từ màn hình, rồi chạy PIN, refresh có chữ ký và khóa màn hình. Cuối cùng kiểm DB: phiên LOGOUT,
    đúng một lần xoay refresh, không REFRESH_REUSE.
