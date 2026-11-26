import 'dart:async';
import 'dart:convert';
import 'dart:io' show HttpDate, OSError, SocketException;

import 'package:cryptography/cryptography.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:staff_app/core/device_proof.dart';

/// API giả tối thiểu cho test: kiểm chữ ký thiết bị THẬT (Ed25519) như server, đếm lượt refresh, giả lập hết hạn access.
class FakeApi {
  final calls = <String>[];
  final publicKeys =
      <String, List<int>>{}; // deviceId → khóa công khai đã đăng ký
  String deviceStatus = 'PENDING';
  String validAccess = 'at-1';
  String validRefresh = 'rt-1';
  int refreshCount = 0;
  int tokenSeq = 1;
  bool failNetwork = false;

  /// lỗi kết nối TRƯỚC khi gửi (giống dart:io khi server từ chối kết nối)
  bool failConnect = false;
  Duration refreshDelay = Duration.zero;
  final usedRefresh = <String>{};
  bool reuseDetected = false;
  Map<String, Object?>? lastRegister;

  /// giờ "server" (lệch so với máy để thử báo lệch đồng hồ); header Date gửi theo giờ này
  DateTime Function() serverNow = DateTime.now;
  final usedNonces = <String>{};

  /// Phản hồi đăng ký bị "mất" sau khi server đã nhận (giả lập timeout)
  bool dropRegisterResponse = false;

  /// access hợp lệ cũ còn chấp nhận được (giả lập request bay trước khi refresh xong)
  final acceptedAccess = <String>{};

  /// trì hoãn trả lời GET /auth/sessions (để thử nhánh 401 về sau khi lượt refresh khác đã xong)
  Duration sessionsDelay = Duration.zero;

  Map<String, String> get _h => {
    'content-type': 'application/json; charset=utf-8',
    'date': HttpDate.format(serverNow().toUtc()),
  };
  http.Response _err(int status, String code, String msg) => http.Response(
    jsonEncode({'code': code, 'message': msg}),
    status,
    headers: _h,
  );
  http.Response _ok(Object body, [int status = 200]) =>
      http.Response(jsonEncode(body), status, headers: _h);

  Future<bool> _verify(
    String deviceId,
    ProofPurpose p,
    Map<String, dynamic> proof,
    String binding,
  ) async {
    final pub = publicKeys[deviceId];
    if (pub == null) return false;
    // như server: thời điểm ±120 s, nonce một lần
    final ts = proof['ts'] as int;
    final nowS = serverNow().toUtc().millisecondsSinceEpoch ~/ 1000;
    if ((ts - nowS).abs() > 120) return false;
    if (!usedNonces.add('$deviceId:${proof['nonce']}')) return false;
    return Ed25519().verify(
      proofMessage(
        p,
        deviceId,
        proof['ts'] as int,
        proof['nonce'] as String,
        binding,
      ),
      signature: Signature(
        base64Url.decode('${proof['signature']}=='),
        publicKey: SimplePublicKey(pub, type: KeyPairType.ed25519),
      ),
    );
  }

  MockClient client() => MockClient((req) async {
    if (failConnect) {
      // đúng như dart:io trên Windows (thông điệp KHÔNG chứa "connection refused")
      throw const SocketException(
        'The remote computer refused the network connection',
        osError: OSError(
          'The remote computer refused the network connection',
          1225,
        ),
      );
    }
    if (failNetwork) throw http.ClientException('mất mạng');
    final path = req.url.path;
    calls.add('${req.method} $path');
    final dev = req.headers['x-device-id'] ?? '';
    final body = req.body.isEmpty
        ? <String, dynamic>{}
        : jsonDecode(req.body) as Map<String, dynamic>;
    switch (path) {
      case '/v1/auth/devices/register':
        lastRegister = body;
        final pub = base64Url.decode('${body['public_key']}=');
        publicKeys[dev] = pub;
        final code = body['enrollment_code'] as String;
        if (code != 'ABCDEFGH2345') {
          return _err(
            401,
            'AUTHENTICATION_REQUIRED',
            'Mã ghi danh không hợp lệ',
          );
        }
        if (!await _verify(
          dev,
          ProofPurpose.register,
          body['device_proof'] as Map<String, dynamic>,
          '$code\n${body['public_key']}',
        )) {
          return _err(401, 'AUTHENTICATION_REQUIRED', 'Chữ ký sai');
        }
        if (dropRegisterResponse) throw http.ClientException('mất phản hồi');
        return _ok({
          'device_id': dev,
          'status': 'PENDING',
          'pairing_code': 'ABCDE-FGHIJ',
          'registered_at': '2026-11-27T00:00:00Z',
        }, 201);
      case '/v1/auth/pin':
        if (deviceStatus == 'PENDING') {
          return _err(
            403,
            'DEVICE_NOT_ACTIVATED',
            'Thiết bị chưa được kích hoạt',
          );
        }
        if (deviceStatus == 'REVOKED') {
          return _err(
            403,
            'DEVICE_REVOKED',
            'Thiết bị đã bị thu hồi — đăng ký lại thiết bị',
          );
        }
        if (!await _verify(
          dev,
          ProofPurpose.pin,
          body['device_proof'] as Map<String, dynamic>,
          body['staff_code'] as String,
        )) {
          return _err(401, 'AUTHENTICATION_REQUIRED', 'Chữ ký sai');
        }
        if (body['staff_code'] != 'NV01' || body['pin'] != '246813') {
          return _err(
            401,
            'AUTHENTICATION_REQUIRED',
            'Sai mã nhân viên hoặc PIN',
          );
        }
        return _ok({
          'access_token': validAccess,
          'access_token_expires_at': '2026-11-27T00:15:00Z',
          'refresh_token': validRefresh,
          'session_id': '00000000-0000-4000-8000-0000000000aa',
          'amr': ['pin'],
          'device_id': dev,
          'staff': {
            'user_id': 'u1',
            'staff_code': 'NV01',
            'full_name': 'Nguyễn Văn A',
          },
        });
      case '/v1/auth/refresh':
        refreshCount++;
        final rt = body['refresh_token'] as String;
        if (refreshDelay > Duration.zero) {
          await Future<void>.delayed(refreshDelay);
        }
        // như server: chữ ký thiết bị kiểm TRƯỚC phát hiện dùng lại
        if (!await _verify(
          dev,
          ProofPurpose.refresh,
          body['device_proof'] as Map<String, dynamic>,
          await refreshBinding(rt),
        )) {
          return _err(
            401,
            'AUTHENTICATION_REQUIRED',
            'Thiếu/sai chữ ký thiết bị',
          );
        }
        if (usedRefresh.contains(rt)) {
          reuseDetected = true;
          return _err(401, 'SESSION_REVOKED', 'Phiên đã bị thu hồi');
        }
        if (rt != validRefresh) {
          return _err(
            401,
            'AUTHENTICATION_REQUIRED',
            'Refresh token không hợp lệ',
          );
        }
        usedRefresh.add(rt);
        tokenSeq++;
        validAccess = 'at-$tokenSeq';
        validRefresh = 'rt-$tokenSeq';
        return _ok({
          'access_token': validAccess,
          'access_token_expires_at': '2026-11-27T00:30:00Z',
          'refresh_token': validRefresh,
          'session_id': '00000000-0000-4000-8000-0000000000aa',
          'amr': ['pin'],
        });
      default:
        if (!publicKeys.containsKey(dev)) {
          return _err(
            401,
            'AUTHENTICATION_REQUIRED',
            'Token không thuộc thiết bị này',
          );
        }
        final auth = req.headers['authorization'];
        final tok = auth?.startsWith('Bearer ') == true
            ? auth!.substring(7)
            : '';
        if (path == '/v1/auth/sessions' && sessionsDelay > Duration.zero) {
          await Future<void>.delayed(sessionsDelay);
        }
        if (tok != validAccess && !acceptedAccess.contains(tok)) {
          return _err(401, 'AUTHENTICATION_REQUIRED', 'Cần đăng nhập');
        }
        if (path == '/v1/auth/logout') return _ok({'ok': true});
        if (path == '/v1/auth/sessions') {
          return _ok({
            'items': [
              {'id': 's1', 'current': true},
            ],
          });
        }
        return _err(404, 'RESOURCE_NOT_FOUND', 'Không có');
    }
  });
}
