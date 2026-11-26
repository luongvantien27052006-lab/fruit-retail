import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:staff_app/app_controller.dart';
import 'package:staff_app/core/api_client.dart';
import 'package:staff_app/core/config.dart';
import 'package:staff_app/core/device_identity.dart';
import 'package:staff_app/main.dart';

// Chạy THẬT trên Windows với API local (CP03 lát 9) — do apps/api/test-e2e/staff-app.e2e.ts điều phối:
//   flutter test integration_test/live_api_test.dart -d windows --dart-define=API_BASE_URL=… --dart-define=COORD_DIR=…
//     --dart-define=ENROLL_CODE=… --dart-define=STAFF_CODE=… --dart-define=STAFF_PIN=…
// Khóa thiết bị lưu bằng SecureDeviceStore thật (DPAPI); xóa trước và sau khi chạy.
const _coord = String.fromEnvironment('COORD_DIR');
const _enroll = String.fromEnvironment('ENROLL_CODE');
const _staff = String.fromEnvironment('STAFF_CODE');
const _pin = String.fromEnvironment('STAFF_PIN');

Future<void> _waitFile(File f, Duration max) async {
  final end = DateTime.now().add(max);
  while (!f.existsSync()) {
    if (DateTime.now().isAfter(end)) throw StateError('hết giờ chờ ${f.path}');
    await Future<void>.delayed(const Duration(milliseconds: 300));
  }
}

Future<void> _until(
  WidgetTester t,
  Finder f, {
  Duration max = const Duration(seconds: 30),
}) async {
  final end = DateTime.now().add(max);
  while (f.evaluate().isEmpty) {
    if (DateTime.now().isAfter(end)) throw StateError('không thấy $f');
    await t.pump(const Duration(milliseconds: 200));
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'Windows thật: đăng ký máy → kích hoạt → PIN → refresh có chữ ký → khóa màn hình',
    (t) async {
      expect(
        _coord.isNotEmpty &&
            _enroll.isNotEmpty &&
            _staff.isNotEmpty &&
            _pin.isNotEmpty,
        isTrue,
        reason: 'thiếu --dart-define điều phối',
      );
      final store = SecureDeviceStore();
      await store.clear();
      final config = AppConfig.fromEnvironment();
      final c = AppController(
        api: ApiClient(base: config.apiBase),
        store: store,
        platform: Platform.isWindows ? 'windows' : 'android',
        idleLock: const Duration(minutes: 5),
      );
      try {
        await t.pumpWidget(StaffApp(controller: c));
        await c.init();
        await t.pumpAndSettle();

        await t.enterText(find.byKey(const Key('device_name')), 'Quầy E2E');
        await t.enterText(find.byKey(const Key('enrollment_code')), _enroll);
        await t.tap(find.byKey(const Key('register')));
        await _until(t, find.byKey(const Key('pairing_code')));
        final pairing = (t.widget<SelectableText>(
          find.byKey(const Key('pairing_code')),
        )).data!;
        // khóa đã nằm trong kho bảo mật thật của Windows
        final saved = await SecureDeviceStore().load();
        expect(saved?.deviceId, c.identity?.deviceId);
        expect(saved?.publicKeyB64, c.identity?.publicKeyB64);

        File(
          '$_coord/pairing.txt',
        ).writeAsStringSync('${c.identity!.deviceId}\n$pairing');
        await _waitFile(
          File('$_coord/activated.txt'),
          const Duration(seconds: 90),
        );

        await t.tap(find.byKey(const Key('to_pin')));
        await t.pumpAndSettle();
        await t.enterText(find.byKey(const Key('staff_code')), _staff);
        await t.enterText(find.byKey(const Key('pin')), _pin);
        await t.tap(find.byKey(const Key('login')));
        await _until(t, find.byKey(const Key('greeting')));

        // access "hết hạn" (không hợp lệ) ⇒ client tự refresh bằng chữ ký thiết bị rồi gọi lại
        final before = c.session!.refresh;
        c.session!.access = 'het-han';
        await t.tap(find.byKey(const Key('ping')));
        await _until(t, find.textContaining('Kết nối tốt'));
        expect(c.session!.refresh, isNot(before));

        await t.tap(find.byKey(const Key('lock')));
        await _until(t, find.text('Đăng nhập nhân viên'));
        // logout chạy sau khi đổi màn — chờ request xong trước khi báo điều phối
        await t.runAsync(
          () => Future<void>.delayed(const Duration(seconds: 2)),
        );
        File('$_coord/done.txt').writeAsStringSync(c.identity!.deviceId);
      } finally {
        await store.clear();
      }
    },
  );
}
