import 'dart:async';
import 'dart:convert';
import 'dart:io' show HttpDate, IOException, SocketException, TlsException;

import 'package:http/http.dart' as http;
import 'package:uuid/uuid.dart';

import 'device_identity.dart';
import 'device_proof.dart';

/// Lỗi API theo envelope §13.1 `{code, message}`; lỗi mạng ⇒ code `NETWORK`.
class ApiException implements Exception {
  ApiException(
    this.status,
    this.code,
    String message, {
    this.skew,
    this.maybeDelivered = true,
  }) : _message = message;
  final int status;
  final String code;
  final String _message;

  /// lệch đồng hồ máy ↔ server (theo header Date của phản hồi 401); null khi không đo được
  final Duration? skew;

  /// lỗi mạng: request CÓ THỂ đã tới server (timeout/mất phản hồi). false = chắc chắn chưa gửi được (DNS, từ chối kết
  /// nối, TLS) — đăng ký máy thử lại an toàn với cùng mã ghi danh
  final bool maybeDelivered;

  /// lệch vượt cửa sổ chữ ký của server (±120 s) ⇒ lỗi 401 là DO đồng hồ (review lát 9 lần 2: dưới ngưỡng này chữ ký vẫn
  /// hợp lệ, không được che lỗi thật như sai PIN / access hết hạn)
  static const proofWindow = Duration(seconds: 120);
  bool get clockSkewed => status == 401 && skew != null && skew! > proofWindow;

  String get message => clockSkewed
      ? 'Đồng hồ máy lệch khoảng ${(skew!.inSeconds / 60).ceil()} phút so với máy chủ — chỉnh lại ngày giờ của máy rồi thử lại'
      : _message;

  bool get deviceGone => code == 'DEVICE_REVOKED';
  bool get notActivated => code == 'DEVICE_NOT_ACTIVATED';
  bool get sessionEnded =>
      code == 'SESSION_REVOKED' || code == 'AUTHENTICATION_REQUIRED';

  @override
  String toString() => 'ApiException($status $code: $message)';
}

class StaffInfo {
  const StaffInfo({
    required this.userId,
    required this.staffCode,
    required this.fullName,
  });
  final String userId;
  final String staffCode;
  final String fullName;
}

/// Phiên nhân viên — CHỈ trong bộ nhớ (ADR-028): tắt app / khóa màn hình ⇒ mất, phải nhập PIN lại.
class StaffSession {
  StaffSession({
    required this.access,
    required this.refresh,
    required this.sessionId,
    required this.staff,
  });
  String access;
  String refresh;
  final String sessionId;
  final StaffInfo staff;

  /// lượt refresh đang chạy CỦA PHIÊN NÀY (review lát 9: không dùng chung giữa hai nhân viên trên cùng client)
  Future<void>? refreshing;
}

class RegisterResult {
  const RegisterResult(this.pairingCode);
  final String pairingCode;
}

/// Client API cho staff app. Mọi request đã xác thực mang `X-Device-Id`; access hết hạn ⇒ refresh (kèm chữ ký thiết
/// bị) MỘT lần, gộp các lời gọi song song (refresh token dùng một lần — dùng lại ⇒ server thu hồi phiên, SEC4).
class ApiClient {
  ApiClient({
    required this.base,
    http.Client? client,
    this.clock = DateTime.now,
    this.timeout = const Duration(seconds: 20),
  }) : _http = client ?? http.Client();

  final Uri base;
  final http.Client _http;
  final Clock clock;
  final Duration timeout;

  /// Mã lỗi hệ điều hành của lỗi KẾT NỐI (chưa gửi được request). Phân loại theo MÃ, không theo chuỗi: thông điệp của
  /// Windows khác POSIX và có thể dịch theo ngôn ngữ máy (review lát 9 lần 3 — Windows: "The remote computer refused the
  /// network connection", 1225).
  static const _connectErrors = {
    // Windows
    1225,
    1228,
    1231,
    1232,
    10051,
    10060,
    10061,
    10064,
    10065,
    11001,
    11002,
    11004,
    // POSIX / Android: ECONNREFUSED, EHOSTUNREACH, ENETUNREACH, ETIMEDOUT(kết nối)
    111, 113, 101, 110,
    // macOS/iOS: ECONNREFUSED, EHOSTUNREACH, ENETUNREACH
    61, 65, 51,
  };

  /// Lỗi xảy ra TRƯỚC khi gửi được request ⇒ server chắc chắn chưa nhận.
  static bool beforeSend(Object e) {
    // HandshakeException/TLS: thân request chưa đi
    if (e is TlsException) return true;
    if (e is SocketException) {
      final code = e.osError?.errorCode;
      if (code != null && _connectErrors.contains(code)) return true;
      // DNS: chuỗi do Dart sinh (không phụ thuộc ngôn ngữ OS)
      return e.message.contains('Failed host lookup');
    }
    if (e is http.ClientException) {
      return e.message.contains('Failed host lookup');
    }
    return false;
  }

  Uri _u(String path) => base.replace(path: '${base.path}/v1$path');

  Map<String, String> _headers(
    DeviceIdentity id, {
    String? bearer,
    bool idempotent = false,
  }) => {
    'content-type': 'application/json',
    'accept': 'application/json',
    'x-device-id': id.deviceId,
    if (bearer != null) 'authorization': 'Bearer $bearer',
    if (idempotent) 'idempotency-key': const Uuid().v4(),
  };

  Future<Map<String, dynamic>> _send(
    Future<http.Response> Function() run,
  ) async {
    http.Response r;
    try {
      r = await run().timeout(timeout);
    } on TimeoutException {
      // đã gửi, chờ quá lâu ⇒ server có thể đã xử lý
      throw ApiException(
        0,
        'NETWORK',
        'Máy chủ không phản hồi — kiểm tra mạng rồi thử lại',
      );
    } on http.ClientException catch (e) {
      // IOClient bọc SocketException thành lớp vừa là ClientException vừa là SocketException ⇒ beforeSend đọc được mã OS
      throw ApiException(
        0,
        'NETWORK',
        'Không kết nối được máy chủ — kiểm tra mạng rồi thử lại',
        maybeDelivered: !beforeSend(e),
      );
    } on IOException catch (e) {
      // TlsException/HandshakeException (chứng chỉ sai, Wi-Fi có cổng đăng nhập), SocketException chưa được bọc…
      throw ApiException(
        0,
        'NETWORK',
        e is TlsException
            ? 'Lỗi kết nối bảo mật tới máy chủ — kiểm tra mạng/Wi-Fi rồi thử lại'
            : 'Không kết nối được máy chủ — kiểm tra mạng rồi thử lại',
        maybeDelivered: !beforeSend(e),
      );
    }
    Map<String, dynamic> body = const {};
    if (r.body.isNotEmpty) {
      try {
        final d = jsonDecode(utf8.decode(r.bodyBytes));
        if (d is Map<String, dynamic>) body = d;
      } catch (_) {
        throw ApiException(
          r.statusCode,
          'INTERNAL_ERROR',
          'Phản hồi máy chủ không hợp lệ',
        );
      }
    }
    if (r.statusCode >= 200 && r.statusCode < 300) return body;
    Duration? skew;
    if (r.statusCode == 401) {
      // đo lệch đồng hồ để nói đúng lý do khi chữ ký bị từ chối vì giờ máy (mã lỗi GIỮ NGUYÊN — luồng refresh không đổi)
      final date = r.headers['date'];
      if (date != null) {
        try {
          skew = clock().toUtc().difference(HttpDate.parse(date)).abs();
        } on FormatException {
          // header Date lạ — bỏ qua
        }
      }
    }
    throw ApiException(
      r.statusCode,
      body['code'] is String ? body['code'] as String : 'INTERNAL_ERROR',
      body['message'] is String
          ? body['message'] as String
          : 'Có lỗi xảy ra (HTTP ${r.statusCode})',
      skew: skew,
    );
  }

  /// Đăng ký máy vào hàng chờ của cửa hàng (mã ghi danh do quản lý tạo). Trả mã ghép để người kích hoạt đối chiếu.
  Future<RegisterResult> register(
    DeviceIdentity id,
    String enrollmentCode,
    String platform,
  ) async {
    final code = normalizeEnrollmentCode(enrollmentCode);
    final proof = await makeProof(
      id,
      ProofPurpose.register,
      '$code\n${id.publicKeyB64}',
      clock: clock,
    );
    final b = await _send(
      () => _http.post(
        _u('/auth/devices/register'),
        headers: _headers(id, idempotent: true),
        body: jsonEncode({
          'enrollment_code': code,
          'name': id.name,
          'platform': platform,
          'public_key': id.publicKeyB64,
          'device_proof': proof,
        }),
      ),
    );
    final pc = b['pairing_code'];
    if (pc is! String) {
      throw ApiException(200, 'INTERNAL_ERROR', 'Thiếu mã ghép trong phản hồi');
    }
    return RegisterResult(pc);
  }

  Future<StaffSession> pinLogin(
    DeviceIdentity id,
    String staffCode,
    String pin,
  ) async {
    final code = normalizeStaffCode(staffCode);
    final proof = await makeProof(id, ProofPurpose.pin, code, clock: clock);
    final b = await _send(
      () => _http.post(
        _u('/auth/pin'),
        headers: _headers(id),
        body: jsonEncode({
          'staff_code': code,
          'pin': pin,
          'device_proof': proof,
        }),
      ),
    );
    final s = b['staff'];
    if (b['access_token'] is! String ||
        b['refresh_token'] is! String ||
        s is! Map<String, dynamic>) {
      throw ApiException(
        200,
        'INTERNAL_ERROR',
        'Phản hồi đăng nhập không hợp lệ',
      );
    }
    return StaffSession(
      access: b['access_token'] as String,
      refresh: b['refresh_token'] as String,
      sessionId: b['session_id'] as String? ?? '',
      staff: StaffInfo(
        userId: s['user_id'] as String? ?? '',
        staffCode: s['staff_code'] as String? ?? code,
        fullName: s['full_name'] as String? ?? code,
      ),
    );
  }

  Future<void> _refresh(DeviceIdentity id, StaffSession s) {
    return s.refreshing ??= () async {
      try {
        final old = s.refresh;
        final proof = await makeProof(
          id,
          ProofPurpose.refresh,
          await refreshBinding(old),
          clock: clock,
        );
        final b = await _send(
          () => _http.post(
            _u('/auth/refresh'),
            headers: _headers(id),
            body: jsonEncode({'refresh_token': old, 'device_proof': proof}),
          ),
        );
        if (b['access_token'] is! String || b['refresh_token'] is! String) {
          throw ApiException(
            200,
            'INTERNAL_ERROR',
            'Phản hồi làm mới phiên không hợp lệ',
          );
        }
        s.access = b['access_token'] as String;
        s.refresh = b['refresh_token'] as String;
      } finally {
        s.refreshing = null;
      }
    }();
  }

  /// Request đã xác thực. 401 AUTHENTICATION_REQUIRED (access hết hạn) ⇒ refresh một lần rồi gọi lại.
  Future<Map<String, dynamic>> authed(
    DeviceIdentity id,
    StaffSession s,
    String method,
    String path, {
    Object? body,
    bool refreshOnExpiry = true,
  }) async {
    final idem = method != 'GET';
    final key = idem ? const Uuid().v4() : null;
    Future<Map<String, dynamic>> once() {
      final h = _headers(id, bearer: s.access);
      if (key != null) h['idempotency-key'] = key;
      final req = http.Request(method, _u(path))..headers.addAll(h);
      if (body != null) req.body = jsonEncode(body);
      return _send(() async => http.Response.fromStream(await _http.send(req)));
    }

    final sent = s.access;
    try {
      return await once();
    } on ApiException catch (e) {
      final expired = e.status == 401 && e.code == 'AUTHENTICATION_REQUIRED';
      if (!refreshOnExpiry || !expired) rethrow;
      // một lời gọi khác đã làm mới xong trong lúc request này bay ⇒ chỉ gọi lại bằng access mới, không refresh nữa
      if (s.access == sent) await _refresh(id, s);
      return once();
    }
  }

  /// Thu hồi phiên ở server (khóa màn hình / đổi người). Lỗi mạng bỏ qua: phiên trong bộ nhớ vẫn bị xóa.
  Future<void> logout(DeviceIdentity id, StaffSession s) async {
    try {
      await authed(
        id,
        s,
        'POST',
        '/auth/logout',
        body: const <String, Object>{},
        // phiên chết thì refresh token cũng vô dụng — không refresh (tránh REFRESH_REUSE / tốn nonce)
        refreshOnExpiry: false,
      );
    } on ApiException {
      // phiên hết hạn / mất mạng — access tự hết hạn sau 15 phút, refresh không còn trong bộ nhớ
    }
  }

  void close() => _http.close();
}
