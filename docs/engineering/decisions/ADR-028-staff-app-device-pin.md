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

## Sửa theo kiểm thử flutter-reviewer lần 1 (fc98ec4)
- Cao: bản release Android thiếu quyền INTERNET (chỉ debug/profile có) ⇒ thêm vào manifest main.
- TB: lỗi ngoài ApiException lọt ra (HandshakeException/TlsException, PlatformException của kho bảo mật) ⇒ `_send` bắt mọi
  `IOException` thành NETWORK; `_run` bắt lỗi còn lại và hiện thông báo; `init()` lỗi kho ⇒ màn "Không khởi động được" có nút
  thử lại.
- TB: máy kẹt ở màn chờ (PENDING quá 7 ngày bị server ẩn và không kích hoạt được) ⇒ nút "Đăng ký lại máy" (có xác nhận) ở màn
  chờ và màn PIN.
- TB: đăng ký mất phản hồi sau khi server đã nhận (mã ghi danh đã tiêu; gửi lại ⇒ 401, không phải 409 — server không có
  idempotency cho route này) ⇒ lỗi NETWORK khi đăng ký vẫn LƯU khóa + mã ghép tính tại máy (khớp `pairingCode` server, có
  vector Node) và báo rõ; quản lý kích hoạt nếu thấy máy, không thì đăng ký lại với mã mới. Lỗi server rõ ràng (4xx) ⇒ không lưu.
- Thấp: lượt refresh gộp gắn vào TỪNG phiên (`StaffSession.refreshing`), không dùng chung cả client.
- Thấp: bắt thao tác ở cấp app — `Listener` trong `MaterialApp.builder` (cả dialog/menu), `HardwareKeyboard` handler (phím mà
  ô nhập đã xử lý), `AppLifecycleListener.onResume` so mốc thao tác cuối (Timer không chạy khi máy ngủ).
- Thấp: bản release BẮT BUỘC `--dart-define=API_BASE_URL` và https (http máy dev chỉ ở debug/profile).
- Thấp: 401 kèm header `Date` lệch > 60 s so với giờ máy ⇒ lỗi `CLOCK_SKEW` nói rõ "chỉnh ngày giờ"; mất phiên ⇒ logout
  best-effort.
- Thấp: test chạy thật dùng khóa lưu riêng (`…v1.e2e`); e2e quote tham số và `taskkill /T` cây tiến trình trong `finally`.
- Thấp: màn Home cuộn được. FakeApi kiểm như server (±120 s, nonce một lần, X-Device-Id, chữ ký trước dùng lại); thêm test 401
  về sau khi refresh xong, refresh theo phiên, lệch đồng hồ, mất phản hồi đăng ký, lỗi kho, phím/resume, phiên bị thu hồi,
  màn lỗi cấu hình (30/30).
- **Rủi ro chấp nhận:**
  - Phản hồi refresh bị mất (server đã xoay) ⇒ lần refresh sau là dùng lại ⇒ server thu hồi phiên ⇒ nhập PIN lại. An toàn,
    chỉ bất tiện.
  - DPAPI khóa theo TÀI KHOẢN Windows: tiến trình khác chạy cùng tài khoản đọc được seed. Máy quầy nên chạy tài khoản Windows
    riêng, không quyền admin, không cài phần mềm lạ (ghi vào hướng dẫn lắp máy CP07).

## Sửa theo kiểm thử flutter-reviewer lần 2 (176605f)
- TB (hồi quy): ngưỡng lệch đồng hồ 60 s < cửa sổ server ±120 s ⇒ MỌI 401 thành CLOCK_SKEW (không refresh, che sai PIN). Sửa:
  mã lỗi giữ nguyên; `ApiException.skew` đo từ header Date; chỉ khi lệch > 120 s (`clockSkewed`) thông điệp mới đổi thành
  "chỉnh ngày giờ" — luồng refresh không đổi.
- TB: nút "Đăng ký lại máy" ở màn PIN cho phép ai đứng quầy xóa khóa ⇒ BỎ khỏi màn PIN; chỉ còn ở màn chờ kích hoạt (máy lạ /
  chưa kích hoạt ⇒ `/auth/pin` trả DEVICE_NOT_ACTIVATED ⇒ vào màn chờ) và màn thu hồi.
- Thấp: lỗi kết nối TRƯỚC khi gửi (từ chối kết nối, DNS, TLS) ⇒ `maybeDelivered=false` ⇒ đăng ký KHÔNG lưu khóa, mã ghi danh
  cũ dùng lại được; chỉ timeout/mất phản hồi mới lưu khóa + mã ghép tại máy.
- Thấp: `logout` không refresh (`refreshOnExpiry: false`); `sessionLost` chỉ logout best-effort khi lệch giờ (phiên có thể
  còn sống) — không phát thêm REFRESH_REUSE.
- Thấp: `resetDevice` bắt lỗi kho bảo mật và báo.
- Ghi chú cho CP07: bàn phím ảo Android không sinh KeyEvent — ô nhập ở màn nghiệp vụ phải gọi `touch()` trong `onChanged`.
- Test 36/36; chạy thật Windows pass.

## Sửa theo kiểm thử flutter-reviewer lần 3 (b583b1f)
- Thấp: `maybeDelivered` so chuỗi "connection refused" — trên Windows dart:io báo "The remote computer refused the network
  connection" (1225) ⇒ phân loại sai. Sửa: theo MÃ lỗi OS (Windows 1225/10061/10065/11001…, POSIX 111/113/101…), DNS theo
  chuỗi do Dart sinh, TLS luôn là chưa gửi. Test dùng `IOClient` THẬT tới cổng đóng + bảng mã; FakeApi ném SocketException
  đúng như Windows. 38/38.

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
