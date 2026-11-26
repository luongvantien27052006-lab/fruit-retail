import 'dart:async';

import 'package:flutter/foundation.dart';

import 'core/api_client.dart';
import 'core/device_identity.dart';

enum Stage { loading, setup, pending, pin, revoked, home }

/// Điều phối luồng staff app (ADR-028): đăng ký máy → chờ kích hoạt → đăng nhập PIN → làm việc → khóa màn hình.
class AppController extends ChangeNotifier {
  AppController({
    required this.api,
    required this.store,
    required this.platform,
    required this.idleLock,
  });

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

  Future<void> init() async {
    identity = await store.load();
    stage = identity == null ? Stage.setup : Stage.pin;
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
    final r = await api.register(id, enrollmentCode, platform);
    // chỉ lưu khi server đã nhận — đăng ký lỗi không để lại khóa mồ côi
    identity = id.withPairingCode(r.pairingCode);
    await store.save(identity!);
    stage = Stage.pending;
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
    _idle?.cancel();
    _idle = Timer(idleLock, () => lock(auto: true));
  }

  /// Phiên chết phía server (thu hồi / hết hạn) khi đang làm việc ⇒ về màn PIN.
  void sessionLost(ApiException e) {
    if (e.deviceGone) {
      _idle?.cancel();
      session = null;
      stage = Stage.revoked;
      error = e.message;
      notifyListeners();
    } else if (e.sessionEnded) {
      _idle?.cancel();
      session = null;
      stage = Stage.pin;
      error = 'Phiên đã hết — nhập PIN lại.';
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
