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
}
