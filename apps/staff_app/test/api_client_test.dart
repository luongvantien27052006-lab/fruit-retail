import 'package:flutter_test/flutter_test.dart';
import 'package:staff_app/core/api_client.dart';
import 'package:staff_app/core/device_identity.dart';

import 'fake_api.dart';

void main() {
  late FakeApi fake;
  late ApiClient api;
  late DeviceIdentity id;

  setUp(() async {
    fake = FakeApi();
    api = ApiClient(
      base: Uri.parse('http://localhost:8080'),
      client: fake.client(),
    );
    id = await DeviceIdentity.generate(mode: StaffMode.counter, name: 'Quầy 1');
  });

  test(
    'đăng ký: chữ ký register đúng ràng buộc, mã ghi danh chuẩn hóa, trả mã ghép',
    () async {
      final r = await api.register(id, 'abcd-efgh-2345', 'windows');
      expect(r.pairingCode, 'ABCDE-FGHIJ');
      expect(fake.lastRegister?['enrollment_code'], 'ABCDEFGH2345');
      expect(fake.lastRegister?['platform'], 'windows');
      expect(fake.lastRegister?['public_key'], id.publicKeyB64);
    },
  );

  test('đăng nhập PIN: X-Device-Id + chữ ký pin; lỗi trả mã chuẩn', () async {
    await api.register(id, 'ABCDEFGH2345', 'windows');
    await expectLater(
      api.pinLogin(id, 'nv01', '246813'),
      throwsA(
        isA<ApiException>().having((e) => e.notActivated, 'notActivated', true),
      ),
    );
    fake.deviceStatus = 'ACTIVE';
    final s = await api.pinLogin(id, ' nv01 ', '246813');
    expect(s.staff.fullName, 'Nguyễn Văn A');
    await expectLater(
      api.pinLogin(id, 'NV01', '000000'),
      throwsA(isA<ApiException>().having((e) => e.status, 'status', 401)),
    );
    fake.deviceStatus = 'REVOKED';
    await expectLater(
      api.pinLogin(id, 'NV01', '246813'),
      throwsA(
        isA<ApiException>().having((e) => e.deviceGone, 'deviceGone', true),
      ),
    );
  });

  test(
    'access hết hạn: các request song song chỉ refresh MỘT lần (không dùng lại refresh token)',
    () async {
      await api.register(id, 'ABCDEFGH2345', 'windows');
      fake.deviceStatus = 'ACTIVE';
      final s = await api.pinLogin(id, 'NV01', '246813');
      fake.validAccess =
          'at-expired-on-server'; // server coi access của client là hết hạn
      fake.refreshDelay = const Duration(milliseconds: 50);
      final rs = await Future.wait([
        for (var i = 0; i < 4; i++) api.authed(id, s, 'GET', '/auth/sessions'),
      ]);
      expect(rs, hasLength(4));
      expect(fake.refreshCount, 1);
      expect(fake.reuseDetected, isFalse);
      expect(s.access, fake.validAccess);
      expect(s.refresh, fake.validRefresh);
    },
  );

  test('mất mạng ⇒ ApiException NETWORK (không ném lỗi thô)', () async {
    fake.failNetwork = true;
    await expectLater(
      api.register(id, 'ABCDEFGH2345', 'windows'),
      throwsA(isA<ApiException>().having((e) => e.code, 'code', 'NETWORK')),
    );
  });

  test('đăng xuất lỗi mạng không ném', () async {
    await api.register(id, 'ABCDEFGH2345', 'windows');
    fake.deviceStatus = 'ACTIVE';
    final s = await api.pinLogin(id, 'NV01', '246813');
    fake.failNetwork = true;
    await api.logout(id, s);
  });

  test(
    '401 về SAU khi lượt refresh khác đã xong ⇒ gọi lại bằng access mới, KHÔNG refresh lần nữa',
    () async {
      await api.register(id, 'ABCDEFGH2345', 'windows');
      fake.deviceStatus = 'ACTIVE';
      final s = await api.pinLogin(id, 'NV01', '246813');
      fake.validAccess = 'at-expired-on-server';
      // request chậm mang access cũ; trong lúc nó bay, request nhanh làm mới xong
      fake.sessionsDelay = const Duration(milliseconds: 120);
      final slow = api.authed(id, s, 'GET', '/auth/sessions');
      await Future<void>.delayed(const Duration(milliseconds: 20));
      fake.sessionsDelay = Duration.zero;
      await api
          .authed(id, s, 'GET', '/auth/logout-probe')
          .catchError((_) => <String, dynamic>{});
      await slow;
      expect(fake.refreshCount, 1);
      expect(fake.reuseDetected, isFalse);
    },
  );

  test(
    'refresh gộp THEO PHIÊN: lượt refresh của phiên A không bị phiên B dùng nhầm',
    () async {
      await api.register(id, 'ABCDEFGH2345', 'windows');
      fake.deviceStatus = 'ACTIVE';
      final a = await api.pinLogin(id, 'NV01', '246813');
      final b = await api.pinLogin(id, 'NV01', '246813');
      expect(identical(a.refreshing, b.refreshing), isTrue); // cả hai null
      fake.validAccess = 'x';
      fake.refreshDelay = const Duration(milliseconds: 50);
      final fa = api.authed(id, a, 'GET', '/auth/sessions');
      await Future<void>.delayed(const Duration(milliseconds: 5));
      expect(a.refreshing, isNotNull);
      expect(b.refreshing, isNull);
      await fa;
    },
  );

  test(
    'lệch > 120 s ⇒ lỗi 401 mang skew, thông điệp nói rõ chỉnh giờ (mã lỗi giữ nguyên)',
    () async {
      final skewed = ApiClient(
        base: Uri.parse('http://localhost:8080'),
        client: fake.client(),
        clock: () => DateTime.now().add(const Duration(minutes: 5)),
      );
      await expectLater(
        skewed.register(id, 'ABCDEFGH2345', 'windows'),
        throwsA(
          isA<ApiException>()
              .having((e) => e.clockSkewed, 'clockSkewed', true)
              .having((e) => e.code, 'code', 'AUTHENTICATION_REQUIRED')
              .having(
                (e) => e.message,
                'message',
                contains('Đồng hồ máy lệch khoảng 5 phút'),
              ),
        ),
      );
    },
  );

  test(
    'lệch 90 s (trong cửa sổ ±120 s): refresh vẫn chạy, sai PIN vẫn báo sai PIN (review lát 9 lần 2)',
    () async {
      final skewed = ApiClient(
        base: Uri.parse('http://localhost:8080'),
        client: fake.client(),
        clock: () => DateTime.now().add(const Duration(seconds: 90)),
      );
      await skewed.register(id, 'ABCDEFGH2345', 'windows');
      fake.deviceStatus = 'ACTIVE';
      await expectLater(
        skewed.pinLogin(id, 'NV01', '000000'),
        throwsA(
          isA<ApiException>()
              .having((e) => e.clockSkewed, 'clockSkewed', false)
              .having((e) => e.message, 'message', 'Sai mã nhân viên hoặc PIN'),
        ),
      );
      final s = await skewed.pinLogin(id, 'NV01', '246813');
      fake.validAccess = 'het-han';
      await skewed.authed(id, s, 'GET', '/auth/sessions');
      expect(fake.refreshCount, 1);
    },
  );

  test(
    'lỗi kết nối trước khi gửi ⇒ maybeDelivered=false; timeout/mất phản hồi ⇒ true',
    () async {
      fake.failConnect = true;
      await expectLater(
        api.register(id, 'ABCDEFGH2345', 'windows'),
        throwsA(
          isA<ApiException>().having(
            (e) => e.maybeDelivered,
            'maybeDelivered',
            false,
          ),
        ),
      );
      fake.failConnect = false;
      fake.failNetwork = true;
      await expectLater(
        api.register(id, 'ABCDEFGH2345', 'windows'),
        throwsA(
          isA<ApiException>().having(
            (e) => e.maybeDelivered,
            'maybeDelivered',
            true,
          ),
        ),
      );
    },
  );

  test(
    'đăng xuất khi access hết hạn KHÔNG refresh (phiên chết — tránh REFRESH_REUSE)',
    () async {
      await api.register(id, 'ABCDEFGH2345', 'windows');
      fake.deviceStatus = 'ACTIVE';
      final s = await api.pinLogin(id, 'NV01', '246813');
      fake.validAccess = 'het-han';
      await api.logout(id, s);
      expect(fake.refreshCount, 0);
    },
  );

  test(
    'nonce dùng lại / X-Device-Id lạ bị từ chối (FakeApi kiểm như server)',
    () async {
      await api.register(id, 'ABCDEFGH2345', 'windows');
      fake.deviceStatus = 'ACTIVE';
      final s = await api.pinLogin(id, 'NV01', '246813');
      final other = await DeviceIdentity.generate(
        mode: StaffMode.counter,
        name: 'Khác',
      );
      await expectLater(
        api.authed(other, s, 'GET', '/auth/sessions'),
        throwsA(isA<ApiException>().having((e) => e.status, 'status', 401)),
      );
    },
  );
}
