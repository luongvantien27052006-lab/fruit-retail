import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:staff_app/app_controller.dart';
import 'package:staff_app/core/api_client.dart';
import 'package:staff_app/core/device_identity.dart';
import 'package:staff_app/main.dart';

import 'fake_api.dart';

void main() {
  late FakeApi fake;
  late MemoryDeviceStore store;

  AppController make({
    String platform = 'windows',
    Duration idle = const Duration(minutes: 5),
  }) => AppController(
    api: ApiClient(
      base: Uri.parse('http://localhost:8080'),
      client: fake.client(),
    ),
    store: store,
    platform: platform,
    idleLock: idle,
  );

  setUp(() {
    fake = FakeApi();
    store = MemoryDeviceStore();
  });

  Future<AppController> start(
    WidgetTester t, {
    String platform = 'windows',
    Duration? idle,
  }) async {
    final c = make(
      platform: platform,
      idle: idle ?? const Duration(minutes: 5),
    );
    await t.pumpWidget(StaffApp(controller: c));
    await c.init();
    await t.pumpAndSettle();
    return c;
  }

  Future<void> register(WidgetTester t) async {
    await t.enterText(find.byKey(const Key('device_name')), 'Quầy 1');
    await t.enterText(
      find.byKey(const Key('enrollment_code')),
      'abcd-efgh-2345',
    );
    await t.tap(find.byKey(const Key('register')));
    await t.pumpAndSettle();
  }

  Future<void> pin(WidgetTester t, String code, String pin) async {
    await t.enterText(find.byKey(const Key('staff_code')), code);
    await t.enterText(find.byKey(const Key('pin')), pin);
    await t.tap(find.byKey(const Key('login')));
    await t.pumpAndSettle();
  }

  testWidgets(
    'Windows: chỉ chế độ quầy; đăng ký ⇒ mã ghép; chưa kích hoạt ⇒ quay lại màn chờ',
    (t) async {
      await start(t);
      expect(find.text('Đăng ký máy'), findsWidgets);
      expect(find.byKey(const Key('mode')), findsNothing); // không có lựa chọn
      expect(find.text('Quầy thu ngân'), findsOneWidget);
      await register(t);
      expect(find.text('ABCDE-FGHIJ'), findsOneWidget);
      expect(store.value?.mode, StaffMode.counter);
      expect(store.value?.pairingCode, 'ABCDE-FGHIJ');
      await t.tap(find.byKey(const Key('to_pin')));
      await t.pumpAndSettle();
      await pin(t, 'NV01', '246813');
      expect(find.text('ABCDE-FGHIJ'), findsOneWidget);
      expect(find.textContaining('chưa được kích hoạt'), findsOneWidget);
    },
  );

  testWidgets(
    'mã ghi danh sai định dạng ⇒ báo ngay, không gọi API; sai mã ⇒ không lưu khóa',
    (t) async {
      await start(t);
      await t.enterText(find.byKey(const Key('device_name')), 'Quầy 1');
      await t.enterText(find.byKey(const Key('enrollment_code')), 'ABC');
      await t.tap(find.byKey(const Key('register')));
      await t.pumpAndSettle();
      expect(find.textContaining('12 ký tự'), findsOneWidget);
      expect(fake.calls, isEmpty);
      await t.enterText(
        find.byKey(const Key('enrollment_code')),
        'ZZZZ-ZZZZ-ZZZZ',
      );
      await t.tap(find.byKey(const Key('register')));
      await t.pumpAndSettle();
      expect(find.byKey(const Key('error')), findsOneWidget);
      expect(store.value, isNull);
    },
  );

  testWidgets('Android: chọn tablet hoặc shipper', (t) async {
    await start(t, platform: 'android');
    expect(find.byKey(const Key('mode')), findsOneWidget);
    await t.tap(find.byKey(const Key('mode')));
    await t.pumpAndSettle();
    await t.tap(find.text('Giao hàng').last);
    await t.pumpAndSettle();
    await register(t);
    expect(store.value?.mode, StaffMode.shipper);
  });

  testWidgets(
    'đăng nhập PIN ⇒ làm việc; PIN sai báo lỗi và xóa ô PIN; khóa màn hình thu hồi phiên',
    (t) async {
      await start(t);
      await register(t);
      fake.deviceStatus = 'ACTIVE';
      await t.tap(find.byKey(const Key('to_pin')));
      await t.pumpAndSettle();
      await pin(t, 'NV01', '111111');
      expect(find.byKey(const Key('error')), findsOneWidget);
      expect(find.text('111111'), findsNothing);
      expect(
        (t.widget<EditableText>(
          find.descendant(
            of: find.byKey(const Key('pin')),
            matching: find.byType(EditableText),
          ),
        )).controller.text,
        isEmpty,
      );
      await pin(t, 'NV01', '246813');
      expect(find.byKey(const Key('greeting')), findsOneWidget);
      expect(find.textContaining('Nguyễn Văn A'), findsOneWidget);
      await t.tap(find.byKey(const Key('ping')));
      await t.pumpAndSettle();
      expect(find.textContaining('Kết nối tốt'), findsOneWidget);
      await t.tap(find.byKey(const Key('lock')));
      await t.pumpAndSettle();
      expect(find.text('Đăng nhập nhân viên'), findsOneWidget);
      expect(fake.calls, contains('POST /v1/auth/logout'));
    },
  );

  testWidgets(
    'tự khóa sau thời gian không thao tác; thao tác đặt lại đồng hồ',
    (t) async {
      final c = await start(t, idle: const Duration(seconds: 30));
      await register(t);
      fake.deviceStatus = 'ACTIVE';
      await t.tap(find.byKey(const Key('to_pin')));
      await t.pumpAndSettle();
      await pin(t, 'NV01', '246813');
      expect(c.stage, Stage.home);
      await t.pump(const Duration(seconds: 20));
      await t.tap(
        find.byKey(const Key('greeting')),
        warnIfMissed: false,
      ); // chạm ⇒ đặt lại
      await t.pump(const Duration(seconds: 20));
      expect(c.stage, Stage.home);
      await t.pump(const Duration(seconds: 11));
      await t.pumpAndSettle();
      expect(c.stage, Stage.pin);
      expect(find.textContaining('tự khóa'), findsOneWidget);
      expect(c.session, isNull);
    },
  );

  testWidgets('máy bị thu hồi ⇒ màn thu hồi; đăng ký lại xóa khóa cũ', (
    t,
  ) async {
    await start(t);
    await register(t);
    final oldId = store.value?.deviceId;
    fake.deviceStatus = 'REVOKED';
    await t.tap(find.byKey(const Key('to_pin')));
    await t.pumpAndSettle();
    await pin(t, 'NV01', '246813');
    expect(find.text('Máy đã bị thu hồi'), findsOneWidget);
    await t.tap(find.byKey(const Key('reset_device')));
    await t.pumpAndSettle();
    expect(store.value, isNull);
    await register(t);
    expect(store.value?.deviceId, isNot(oldId));
  });

  testWidgets(
    'mở lại app khi đã đăng ký ⇒ vào thẳng màn PIN (phiên không lưu)',
    (t) async {
      store.value = await DeviceIdentity.generate(
        mode: StaffMode.counter,
        name: 'Quầy 2',
      );
      await start(t);
      expect(find.text('Đăng nhập nhân viên'), findsOneWidget);
      expect(find.textContaining('Quầy 2'), findsOneWidget);
    },
  );

  testWidgets(
    'đăng ký mất phản hồi (server đã nhận) ⇒ vẫn giữ khóa + mã ghép tính tại máy, có lối đăng ký lại',
    (t) async {
      await start(t);
      fake.dropRegisterResponse = true;
      await register(t);
      final saved = store.value;
      expect(saved, isNotNull);
      expect(saved!.pairingCode, await saved.localPairingCode());
      expect(find.text(saved.pairingCode!), findsOneWidget);
      expect(find.textContaining('Mất kết nối khi đăng ký'), findsOneWidget);
      // lối ra: đăng ký lại (có xác nhận) xóa khóa
      await t.tap(find.byKey(const Key('re_register')));
      await t.pumpAndSettle();
      await t.tap(find.byKey(const Key('re_register_confirm')));
      await t.pumpAndSettle();
      expect(store.value, isNull);
      expect(find.text('Đăng ký máy'), findsWidgets);
    },
  );

  testWidgets(
    'kho bảo mật lỗi lúc khởi động ⇒ màn lỗi + thử lại (không kẹt vòng xoay)',
    (t) async {
      final broken = _BrokenStore();
      final c = AppController(
        api: ApiClient(
          base: Uri.parse('http://localhost:8080'),
          client: fake.client(),
        ),
        store: broken,
        platform: 'windows',
        idleLock: const Duration(minutes: 5),
      );
      await t.pumpWidget(StaffApp(controller: c));
      await c.init();
      await t.pumpAndSettle();
      expect(find.text('Không khởi động được'), findsOneWidget);
      broken.fail = false;
      await t.tap(find.byKey(const Key('retry_init')));
      await t.pumpAndSettle();
      expect(find.text('Đăng ký máy'), findsWidgets);
    },
  );

  testWidgets(
    'phím cứng đặt lại đồng hồ tự khóa; quay lại từ nền sau quá hạn ⇒ khóa',
    (t) async {
      var clock = DateTime(2026, 11, 27, 8);
      final c = AppController(
        api: ApiClient(
          base: Uri.parse('http://localhost:8080'),
          client: fake.client(),
        ),
        store: store,
        platform: 'windows',
        idleLock: const Duration(seconds: 30),
        now: () => clock,
      );
      await t.pumpWidget(StaffApp(controller: c));
      await c.init();
      await t.pumpAndSettle();
      await register(t);
      fake.deviceStatus = 'ACTIVE';
      await t.tap(find.byKey(const Key('to_pin')));
      await t.pumpAndSettle();
      await pin(t, 'NV01', '246813');
      await t.pump(const Duration(seconds: 20));
      await t.sendKeyEvent(LogicalKeyboardKey.shiftLeft);
      await t.pump(const Duration(seconds: 20));
      expect(c.stage, Stage.home); // phím đã đặt lại
      clock = clock.add(
        const Duration(minutes: 10),
      ); // máy ngủ, Timer không chạy
      c.resumed();
      await t.pumpAndSettle();
      expect(c.stage, Stage.pin);
    },
  );

  testWidgets('đang làm việc mà phiên bị thu hồi ở server ⇒ về màn PIN', (
    t,
  ) async {
    await start(t);
    await register(t);
    fake.deviceStatus = 'ACTIVE';
    await t.tap(find.byKey(const Key('to_pin')));
    await t.pumpAndSettle();
    await pin(t, 'NV01', '246813');
    fake.validAccess = 'het';
    fake.usedRefresh.add(
      fake.validRefresh,
    ); // refresh sẽ bị coi là dùng lại ⇒ SESSION_REVOKED
    await t.tap(find.byKey(const Key('ping')));
    await t.pumpAndSettle();
    expect(find.text('Đăng nhập nhân viên'), findsOneWidget);
    expect(find.textContaining('Phiên đã hết'), findsOneWidget);
  });

  testWidgets('cấu hình sai ⇒ màn báo lỗi', (t) async {
    await t.pumpWidget(
      const ConfigErrorApp(
        message: 'bản release thiếu --dart-define=API_BASE_URL',
      ),
    );
    expect(find.textContaining('Cấu hình sai'), findsOneWidget);
  });
}

class _BrokenStore extends MemoryDeviceStore {
  bool fail = true;
  @override
  Future<DeviceIdentity?> load() async {
    if (fail) throw PlatformException(code: 'dpapi', message: 'hỏng');
    return super.load();
  }
}
