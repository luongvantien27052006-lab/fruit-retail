import 'package:money_weight/money_weight.dart';
import 'package:shared_models/generated/export.dart';
import 'package:test/test.dart';

// Spike sinh client Dart (ADR-017): tiền trên dây là String, chuyển tường minh qua money_weight.
void main() {
  test('VndAmount là String; chuyển sang int bằng money_weight', () {
    const VndAmount wire = '114950';
    expect(wire, isA<String>());
    expect(fromWire(wire), 114950);
    expect(toWire(270400), '270400');
  });

  test('HealthStatus.fromJson đọc đúng response /v1/health', () {
    final h = HealthStatus.fromJson({'status': 'ok', 'checks': {'db': 'ok', 'redis': 'down'}});
    expect(h.checks.db.toJson(), 'ok');
    expect(h.checks.redis.toJson(), 'down');
  });

  test('ErrorCode có DEPENDENCY_UNAVAILABLE', () {
    expect(ErrorCode.values.map((e) => e.toJson()), contains('DEPENDENCY_UNAVAILABLE'));
  });
}
