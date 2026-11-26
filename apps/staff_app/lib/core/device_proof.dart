import 'dart:convert';
import 'dart:math';

import 'package:cryptography/cryptography.dart';

import 'device_identity.dart';

/// Bằng chứng thiết bị (SEC3) — khớp `apps/api/src/auth/device-proof.ts`. Thông điệp UTF-8 nối bằng "\n":
/// `fruit-device-proof/v1`, mục đích, X-Device-Id chữ thường, ts (epoch giây), nonce, ràng buộc.
const proofVersion = 'fruit-device-proof/v1';

enum ProofPurpose { register, pin, refresh }

List<int> proofMessage(
  ProofPurpose purpose,
  String deviceId,
  int ts,
  String nonce,
  String binding,
) => utf8.encode(
  [
    proofVersion,
    purpose.name,
    deviceId.toLowerCase(),
    '$ts',
    nonce,
    binding,
  ].join('\n'),
);

/// Mã ghi danh / mã NV dạng chuẩn để ký và gửi.
String normalizeEnrollmentCode(String c) =>
    c.toUpperCase().replaceAll(RegExp(r'[\s-]'), '');
String normalizeStaffCode(String c) => c.trim().toUpperCase();

final enrollmentCodeRe = RegExp(
  r'^[A-Za-z2-7]{4}-?[A-Za-z2-7]{4}-?[A-Za-z2-7]{4}$',
);
final staffCodeRe = RegExp(r'^[A-Za-z0-9_-]{1,32}$');
final pinRe = RegExp(r'^\d{6}$');

/// refresh ký trên SHA-256 của refresh token (không đưa token rõ vào thông điệp ký).
Future<String> refreshBinding(String refreshToken) async {
  final h = await Sha256().hash(utf8.encode(refreshToken));
  return b64url(h.bytes);
}

final _rng = Random.secure();

/// Đồng hồ thay được trong test.
typedef Clock = DateTime Function();

Future<Map<String, Object>> makeProof(
  DeviceIdentity id,
  ProofPurpose purpose,
  String binding, {
  Clock clock = DateTime.now,
}) async {
  final ts = clock().toUtc().millisecondsSinceEpoch ~/ 1000;
  final nonce = b64url(List<int>.generate(16, (_) => _rng.nextInt(256)));
  final signature = await id.sign(
    proofMessage(purpose, id.deviceId, ts, nonce, binding),
  );
  return {'ts': ts, 'nonce': nonce, 'signature': signature};
}
