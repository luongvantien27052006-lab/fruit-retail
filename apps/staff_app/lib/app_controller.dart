import 'dart:async';

import 'package:flutter/foundation.dart';

import 'core/api_client.dart';
import 'core/device_identity.dart';

enum Stage { loading, failed, setup, pending, pin, revoked, home }

/// Điều phối luồng staff app (ADR-028): đăng ký máy → chờ kích hoạt → đăng nhập PIN → làm việc → khóa màn hình.
class AppController extends ChangeNotifier {
  AppController({
    required this.api,
    required this.store,
    required this.platform,
    required this.idleLock,
    this.now = DateTime.now,
  });

  /// đồng hồ thay được trong test (mốc thao tác cuối)
  final DateTime Function() now;
  DateTime? _lastTouch;

  final ApiClient api;
  final DeviceStore store;

  /// 'windows' | 'android' — quyết định chế độ được phép
  final String platform;
  final Duration idleLock;

  Stage stage = Stage.loading;
  DeviceIdentity? identity;
  StaffSession? session;
  bool busy = false;
  String? error;
  Timer? _idle;

  List<StaffMode> get allowedModes => platform == 'windows'
      ? const [StaffMode.counter]
      : const [StaffMode.tablet, StaffMode.shipper];

  /// Kho bảo mật lỗi (DPAPI/Keystore) ⇒ màn lỗi có nút thử lại, không kẹt ở vòng xoay (review lát 9).
  Future<void> init() async {
    stage = Stage.loading;
    error = null;
    notifyListeners();
    try {
      identity = await store.load();
      stage = identity == null ? Stage.setup : Stage.pin;
    } catch (_) {
      stage = Stage.failed;
      error =
          'Không đọc được kho khóa bảo mật của máy. Thử lại; nếu lặp lại, báo quản trị.';
    }
    notifyListeners();
  }

  Future<T?> _run<T>(Future<T> Function() fn) async {
    if (busy) return null;
    busy = true;
    error = null;
    notifyListeners();
    try {
      return await fn();
    } on ApiException catch (e) {
      error = e.message;
      return null;
    } catch (_) {
      // lỗi ngoài API (kho bảo mật, nền tảng…) vẫn phải hiện cho người dùng, không im lặng
      error = 'Có lỗi trên máy — thử lại; nếu lặp lại, báo quản trị.';
      return null;
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<void> register({
    required String enrollmentCode,
    required StaffMode mode,
    required String name,
  }) => _run(() async {
    if (!allowedModes.contains(mode)) {
      throw ApiException(0, 'INVALID_REQUEST', 'Chế độ không hợp với máy này');
    }
    final id = await DeviceIdentity.generate(mode: mode, name: name.trim());
    try {
      final r = await api.register(id, enrollmentCode, platform);
      identity = id.withPairingCode(r.pairingCode);
      await store.save(identity!);
      stage = Stage.pending;
    } on ApiException catch (e) {
      // server từ chối rõ ràng ⇒ không lưu khóa
      if (e.code != 'NETWORK') rethrow;
      // Mất phản hồi: server CÓ THỂ đã nhận (mã ghi danh đã bị tiêu, gửi lại sẽ bị từ chối). Giữ khóa + mã ghép tính tại
      // máy để quản lý kích hoạt nếu máy đã vào hàng chờ; nếu không thấy, "Đăng ký lại máy" với mã mới.
      identity = id.withPairingCode(await id.localPairingCode());
      await store.save(identity!);
      stage = Stage.pending;
      error =
          'Mất kết nối khi đăng ký — nếu quản lý thấy máy với mã ghép dưới đây thì kích hoạt; nếu không, đăng ký lại máy với mã ghi danh mới.';
    }
  });

  void goToPin() {
    error = null;
    stage = Stage.pin;
    notifyListeners();
  }

  Future<void> login(String staffCode, String pin) => _run(() async {
    final id = identity;
    if (id == null) return;
    try {
      session = await api.pinLogin(id, staffCode, pin);
      stage = Stage.home;
      touch();
    } on ApiException catch (e) {
      if (e.notActivated) {
        stage = Stage.pending;
        error = 'Máy chưa được kích hoạt — đưa mã ghép cho quản lý.';
        return;
      }
      if (e.deviceGone) {
        stage = Stage.revoked;
        error = e.message;
        return;
      }
      rethrow;
    }
  });

  /// Khóa màn hình: thu hồi phiên ở server, xóa phiên trong bộ nhớ, về màn PIN (người khác đăng nhập được ngay).
  Future<void> lock({bool auto = false}) async {
    _idle?.cancel();
    final id = identity;
    final s = session;
    session = null;
    stage = identity == null ? Stage.setup : Stage.pin;
    error = auto
        ? 'Đã tự khóa sau ${idleLock.inMinutes} phút không thao tác.'
        : null;
    notifyListeners();
    if (id != null && s != null) await api.logout(id, s);
  }

  /// Gọi mỗi khi người dùng thao tác — đặt lại đồng hồ tự khóa.
  void touch() {
    if (stage != Stage.home) return;
    _lastTouch = now();
    _idle?.cancel();
    _idle = Timer(idleLock, () => lock(auto: true));
  }

  /// App quay lại từ nền: Timer có thể không chạy khi máy ngủ ⇒ so mốc thao tác cuối với đồng hồ thật.
  void resumed() {
    final t = _lastTouch;
    if (stage == Stage.home && t != null && now().difference(t) >= idleLock) {
      lock(auto: true);
    }
  }

  /// Phiên chết phía server (thu hồi / hết hạn) khi đang làm việc ⇒ về màn PIN.
  void sessionLost(ApiException e) {
    final id = identity;
    final s = session;
    // thu hồi phía server nếu còn sống (best-effort) — vd refresh bị từ chối do lệch đồng hồ
    if (id != null && s != null && !e.deviceGone) unawaited(api.logout(id, s));
    if (e.deviceGone) {
      _idle?.cancel();
      session = null;
      stage = Stage.revoked;
      error = e.message;
      notifyListeners();
    } else if (e.sessionEnded || e.code == 'CLOCK_SKEW') {
      _idle?.cancel();
      session = null;
      stage = Stage.pin;
      error = e.code == 'CLOCK_SKEW'
          ? e.message
          : 'Phiên đã hết — nhập PIN lại.';
      notifyListeners();
    }
  }

  /// Máy bị thu hồi: xóa khóa cũ (không dùng lại được), đăng ký lại từ đầu với mã ghi danh mới.
  Future<void> resetDevice() async {
    _idle?.cancel();
    session = null;
    await store.clear();
    identity = null;
    error = null;
    stage = Stage.setup;
    notifyListeners();
  }

  @override
  void dispose() {
    _idle?.cancel();
    super.dispose();
  }
}
