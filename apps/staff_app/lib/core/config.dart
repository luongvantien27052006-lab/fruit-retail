import 'package:flutter/foundation.dart' show kReleaseMode;

/// Cấu hình chạy (ADR-028). Địa chỉ API truyền lúc build: `--dart-define=API_BASE_URL=https://staging.example.vn`.
/// Mặc định trỏ Caddy local (`http://localhost:8080`). HTTP rõ CHỈ cho máy dev (localhost / 127.0.0.1 / 10.0.2.2 của
/// Android emulator); địa chỉ khác bắt buộc https — PIN và token không đi qua mạng không mã hóa.
class AppConfig {
  const AppConfig({
    required this.apiBase,
    this.idleLock = const Duration(minutes: 5),
  });

  final Uri apiBase;

  /// Tự khóa màn hình sau thời gian không thao tác (§21.3.9 "tự khóa sau N phút"). CP09 đưa N vào cấu hình cửa hàng.
  final Duration idleLock;

  static const _defaultBase = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://localhost:8080',
  );

  static const _hasDefine = bool.hasEnvironment('API_BASE_URL');

  /// Bản release: BẮT BUỘC có --dart-define=API_BASE_URL và https (review lát 9: quên define không được lặng lẽ trỏ
  /// localhost). Debug/profile: mặc định Caddy local.
  static AppConfig fromEnvironment() {
    if (kReleaseMode && !_hasDefine) {
      throw const FormatException(
        'bản release thiếu --dart-define=API_BASE_URL',
      );
    }
    return AppConfig(
      apiBase: parseApiBase(_defaultBase, allowDevHttp: !kReleaseMode),
    );
  }

  static const _devHosts = {'localhost', '127.0.0.1', '10.0.2.2', '::1'};

  /// Ném [FormatException] khi địa chỉ không hợp lệ hoặc dùng http cho máy không phải máy dev.
  static Uri parseApiBase(String raw, {bool allowDevHttp = true}) {
    final u = Uri.tryParse(raw.trim());
    if (u == null || !u.hasScheme || u.host.isEmpty) {
      throw FormatException('API_BASE_URL không hợp lệ: $raw');
    }
    if (u.scheme != 'https' &&
        !(allowDevHttp && u.scheme == 'http' && _devHosts.contains(u.host))) {
      throw FormatException(
        'API_BASE_URL phải dùng https (http chỉ cho localhost): $raw',
      );
    }
    if (u.query.isNotEmpty || u.fragment.isNotEmpty || u.userInfo.isNotEmpty) {
      throw FormatException(
        'API_BASE_URL không được có query/fragment/thông tin đăng nhập: $raw',
      );
    }
    final path = u.path.endsWith('/')
        ? u.path.substring(0, u.path.length - 1)
        : u.path;
    return u.replace(path: path);
  }
}
