import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:money_weight/money_weight.dart';
import 'package:staff_app/core/config.dart';
import 'package:staff_app/core/device_identity.dart';
import 'package:staff_app/core/device_proof.dart';

// Vector sinh bằng Node `node:crypto` (cùng thuật toán API dùng kiểm chữ ký — apps/api/src/auth/device-proof.ts):
// seed = 00 01 … 1f, thông điệp pin cho thiết bị …0001, ts 1700000000, nonce 22×'A', mã NV NV01. Ed25519 tất định ⇒
// chữ ký Dart phải trùng từng byte.
const _vecPub = 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg';
const _vecSig =
    'kl82GRB9i7vRvM2aTc1p6kILsWI6pB1bKy7kQUeEdA2eT7HyySrffsYIjl75H0UJF7F0ar4BcdCCm74rL6TSAw';
const _vecRefreshAbc = 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0';

Future<DeviceIdentity> vectorIdentity() async {
  final seed = Uint8List.fromList(List<int>.generate(32, (i) => i));
  final kp = await Ed25519().newKeyPairFromSeed(seed);
  final pub = await kp.extractPublicKey();
  return DeviceIdentity(
    deviceId: '00000000-0000-4000-8000-000000000001',
    seed: seed,
    publicKey: Uint8List.fromList(pub.bytes),
    mode: StaffMode.counter,
    name: 'Quầy 1',
  );
}

void main() {
  group('chữ ký thiết bị khớp API (SEC3)', () {
    test('Ed25519: khóa công khai và chữ ký trùng vector Node', () async {
      final id = await vectorIdentity();
      expect(id.publicKeyB64, _vecPub);
      final sig = await id.sign(
        proofMessage(
          ProofPurpose.pin,
          id.deviceId,
          1700000000,
          'A' * 22,
          'NV01',
        ),
      );
      expect(sig, _vecSig);
    });

    test(
      'mã ghép tính tại máy trùng pairingCode của server (vector Node)',
      () async {
        final id = await vectorIdentity();
        expect(await id.localPairingCode(), 'KZDVV-J2UMN');
      },
    );

    test('ràng buộc refresh = base64url(SHA-256) không đệm', () async {
      expect(await refreshBinding('abc'), _vecRefreshAbc);
    });

    test(
      'proof: ts theo giây UTC, nonce 16 byte base64url, chữ ký kiểm được',
      () async {
        final id = await vectorIdentity();
        final p = await makeProof(
          id,
          ProofPurpose.refresh,
          'x',
          clock: () => DateTime.utc(2026, 11, 27, 1, 2, 3),
        );
        expect(
          p['ts'],
          DateTime.utc(2026, 11, 27, 1, 2, 3).millisecondsSinceEpoch ~/ 1000,
        );
        expect(p['nonce'], matches(RegExp(r'^[A-Za-z0-9_-]{22}$')));
        expect(p['signature'], matches(RegExp(r'^[A-Za-z0-9_-]{86}$')));
        final ok = await Ed25519().verify(
          proofMessage(
            ProofPurpose.refresh,
            id.deviceId,
            p['ts'] as int,
            p['nonce'] as String,
            'x',
          ),
          signature: Signature(
            base64Url.decode('${p['signature']}=='),
            publicKey: SimplePublicKey(id.publicKey, type: KeyPairType.ed25519),
          ),
        );
        expect(ok, isTrue);
      },
    );

    test('chuẩn hóa mã ghi danh / mã NV', () {
      expect(normalizeEnrollmentCode('abcd-efgh-2345'), 'ABCDEFGH2345');
      expect(normalizeStaffCode('  nv01 '), 'NV01');
      expect(enrollmentCodeRe.hasMatch('ABCD-EFGH-2345'), isTrue);
      expect(
        enrollmentCodeRe.hasMatch('ABCD-EFGH-2349'),
        isFalse,
      ); // 9 không thuộc base32
      expect(pinRe.hasMatch('12345'), isFalse);
    });
  });

  group('danh tính thiết bị', () {
    test('sinh mới: UUID, khóa 32 byte, lưu/đọc lại nguyên vẹn', () async {
      final id = await DeviceIdentity.generate(
        mode: StaffMode.tablet,
        name: 'Tab 1',
      );
      final back = DeviceIdentity.fromJson(
        jsonDecode(jsonEncode(id.withPairingCode('ABCDE-FGHIJ').toJson()))
            as Map<String, dynamic>,
      )!;
      expect(back.deviceId, id.deviceId);
      expect(back.seed, id.seed);
      expect(back.publicKey, id.publicKey);
      expect(back.mode, StaffMode.tablet);
      expect(back.pairingCode, 'ABCDE-FGHIJ');
      expect(await back.sign([1, 2, 3]), await id.sign([1, 2, 3]));
    });

    test('dữ liệu lưu hỏng / phiên bản lạ ⇒ coi như chưa đăng ký', () async {
      final good = (await DeviceIdentity.generate(
        mode: StaffMode.counter,
        name: 'Q',
      )).toJson();
      expect(DeviceIdentity.fromJson({...good, 'v': '2'}), isNull);
      expect(
        DeviceIdentity.fromJson({
          ...good,
          'seed': base64.encode([1, 2]),
        }),
        isNull,
      );
      expect(DeviceIdentity.fromJson({...good, 'mode': 'admin'}), isNull);
      expect(DeviceIdentity.fromJson({...good, 'device_id': 'abc'}), isNull);
      expect(DeviceIdentity.fromJson({'v': '1'}), isNull);
    });
  });

  group('cấu hình API', () {
    test('https bất kỳ; http chỉ localhost; bỏ / cuối', () {
      expect(
        AppConfig.parseApiBase('https://stg.example.vn/').toString(),
        'https://stg.example.vn',
      );
      expect(AppConfig.parseApiBase('http://localhost:8080').port, 8080);
      expect(AppConfig.parseApiBase('http://10.0.2.2:8080').host, '10.0.2.2');
      expect(
        () => AppConfig.parseApiBase('http://192.168.1.5:8080'),
        throwsFormatException,
      );
      expect(() => AppConfig.parseApiBase('ftp://x'), throwsFormatException);
      expect(
        () => AppConfig.parseApiBase('https://u:p@x.vn'),
        throwsFormatException,
      );
      expect(
        () => AppConfig.parseApiBase('https://x.vn/?a=1'),
        throwsFormatException,
      );
    });
  });

  test('liên kết package money_weight (vector Phụ lục A2)', () {
    expect(formatVnd(lineAmount(320000, 845)), '270.400đ');
  });
}
