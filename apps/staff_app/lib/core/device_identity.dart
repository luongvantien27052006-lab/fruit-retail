import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';

/// Chế độ làm việc của máy (ADR-008): Windows ⇒ quầy; Android ⇒ tablet hoặc shipper (chọn lúc đăng ký máy).
enum StaffMode {
  counter('Quầy thu ngân'),
  tablet('Tablet cửa hàng'),
  shipper('Giao hàng');

  const StaffMode(this.label);
  final String label;

  static StaffMode? parse(String? v) {
    for (final m in values) {
      if (m.name == v) return m;
    }
    return null;
  }
}

/// Danh tính thiết bị POS (SEC3, ADR-012/022/028): UUID do máy tự sinh + khóa riêng Ed25519 (seed 32 byte) chỉ nằm trong
/// kho bảo mật của hệ điều hành; server chỉ biết khóa công khai.
class DeviceIdentity {
  DeviceIdentity({
    required this.deviceId,
    required this.seed,
    required this.publicKey,
    required this.mode,
    required this.name,
    this.pairingCode,
  });

  final String deviceId;
  final Uint8List seed;
  final Uint8List publicKey;
  final StaffMode mode;
  final String name;

  /// mã ghép server trả lúc đăng ký — hiện lại trên màn chờ kích hoạt (không bí mật: suy ra từ khóa công khai)
  final String? pairingCode;

  String get publicKeyB64 => b64url(publicKey);

  /// Mã ghép tính tại máy — khớp `pairingCode` của server (apps/api/src/auth/device-proof.ts): 50 bit đầu của
  /// SHA-256(khóa công khai), base32 RFC 4648, dạng XXXXX-XXXXX. Dùng khi đăng ký mất phản hồi (server có thể đã nhận).
  Future<String> localPairingCode() async {
    final fp = (await Sha256().hash(publicKey)).bytes;
    var bits = BigInt.zero;
    for (var i = 0; i < 7; i++) {
      bits = (bits << 8) | BigInt.from(fp[i]);
    }
    bits = bits >> 6;
    const b32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    final out = StringBuffer();
    for (var i = 9; i >= 0; i--) {
      out.write(b32[((bits >> (i * 5)) & BigInt.from(31)).toInt()]);
    }
    final s = out.toString();
    return '${s.substring(0, 5)}-${s.substring(5)}';
  }

  DeviceIdentity withPairingCode(String code) => DeviceIdentity(
    deviceId: deviceId,
    seed: seed,
    publicKey: publicKey,
    mode: mode,
    name: name,
    pairingCode: code,
  );

  static final _ed = Ed25519();

  /// Sinh danh tính mới (chưa lưu). Seed từ bộ sinh ngẫu nhiên an toàn của nền tảng.
  static Future<DeviceIdentity> generate({
    required StaffMode mode,
    required String name,
  }) async {
    final kp = await _ed.newKeyPair();
    final seed = Uint8List.fromList(await kp.extractPrivateKeyBytes());
    final pub = await kp.extractPublicKey();
    return DeviceIdentity(
      deviceId: const Uuid().v4(),
      seed: seed,
      publicKey: Uint8List.fromList(pub.bytes),
      mode: mode,
      name: name,
    );
  }

  Future<String> sign(List<int> message) async {
    final kp = await _ed.newKeyPairFromSeed(seed);
    final sig = await _ed.sign(message, keyPair: kp);
    return b64url(sig.bytes);
  }

  Map<String, String> toJson() => {
    'v': '1',
    'device_id': deviceId,
    'seed': base64.encode(seed),
    'public_key': base64.encode(publicKey),
    'mode': mode.name,
    'name': name,
    'pairing_code': ?pairingCode,
  };

  /// Dữ liệu lưu hỏng / phiên bản lạ ⇒ null (máy coi như chưa đăng ký, không đoán).
  static DeviceIdentity? fromJson(Map<String, dynamic> j) {
    try {
      if (j['v'] != '1') return null;
      final mode = StaffMode.parse(j['mode'] as String?);
      final seed = base64.decode(j['seed'] as String);
      final pub = base64.decode(j['public_key'] as String);
      final id = j['device_id'] as String;
      if (mode == null ||
          seed.length != 32 ||
          pub.length != 32 ||
          !Uuid.isValidUUID(fromString: id)) {
        return null;
      }
      return DeviceIdentity(
        deviceId: id.toLowerCase(),
        seed: seed,
        publicKey: pub,
        mode: mode,
        name: j['name'] as String? ?? '',
        pairingCode: j['pairing_code'] as String?,
      );
    } catch (_) {
      return null;
    }
  }
}

String b64url(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');

/// Nơi lưu danh tính. Bản thật: [SecureDeviceStore]; test: [MemoryDeviceStore].
abstract class DeviceStore {
  Future<DeviceIdentity?> load();
  Future<void> save(DeviceIdentity id);
  Future<void> clear();
}

/// Windows: DPAPI (khóa theo tài khoản Windows của máy); Android: Keystore (AES bọc bằng khóa phần cứng khi có).
/// Token phiên KHÔNG lưu ở đây — chỉ giữ trong bộ nhớ (mở lại app ⇒ nhập PIN lại).
class SecureDeviceStore implements DeviceStore {
  /// [key] riêng cho test chạy thật (không đụng danh tính của app thật cài cùng tài khoản Windows)
  SecureDeviceStore({FlutterSecureStorage? storage, this.key = defaultKey})
    : _s = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _s;
  final String key;
  static const defaultKey = 'fruit.device_identity.v1';

  @override
  Future<DeviceIdentity?> load() async {
    final raw = await _s.read(key: key);
    if (raw == null) return null;
    try {
      return DeviceIdentity.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> save(DeviceIdentity id) =>
      _s.write(key: key, value: jsonEncode(id.toJson()));

  @override
  Future<void> clear() => _s.delete(key: key);
}

class MemoryDeviceStore implements DeviceStore {
  DeviceIdentity? value;

  @override
  Future<DeviceIdentity?> load() async => value;

  @override
  Future<void> save(DeviceIdentity id) async => value = id;

  @override
  Future<void> clear() async => value = null;
}
