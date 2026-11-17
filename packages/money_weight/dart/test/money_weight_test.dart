import 'dart:convert';
import 'dart:io';

import 'package:money_weight/money_weight.dart';
import 'package:test/test.dart';

/// Chạy CÙNG bộ vector với bản TS (FR-INV-03, Phụ lục A).
Map<String, dynamic> _vectors() {
  final file = File.fromUri(
    Directory.current.uri.resolve('../vectors/money_weight.vectors.json'),
  );
  return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
}

void main() {
  final v = _vectors();
  List<Map<String, dynamic>> list(String k) =>
      (v[k] as List<dynamic>).cast<Map<String, dynamic>>();

  group('lineAmount', () {
    for (final c in list('lineAmount')) {
      test(
        '${c['id']}: ${c['pricePerKg']} đ/kg × ${c['grams']} g = ${c['expected']}',
        () {
          expect(
            lineAmount(fromWire(c['pricePerKg'] as String), c['grams'] as int),
            fromWire(c['expected'] as String),
          );
        },
      );
    }
    for (final c in list('lineAmountRejects')) {
      test('${c['id']} từ chối (${c['error']})', () {
        final grams = c['grams'] as num;
        expect(
          () => lineAmount(fromWire(c['pricePerKg'] as String), grams),
          throwsA(
            isA<MoneyWeightError>().having((e) => e.code, 'code', c['error']),
          ),
        );
      });
    }
  });

  group('unitsAmount', () {
    for (final c in list('unitsAmount')) {
      test('${c['id']}', () {
        expect(
          unitsAmount(fromWire(c['pricePerUnit'] as String), c['units'] as int),
          fromWire(c['expected'] as String),
        );
      });
    }
  });

  group('unitsAmount rejects', () {
    for (final c in list('unitsAmountRejects')) {
      test('${c['id']} từ chối (${c['error']})', () {
        expect(
          () => unitsAmount(
            fromWire(c['pricePerUnit'] as String),
            c['units'] as int,
          ),
          throwsA(
            isA<MoneyWeightError>().having((e) => e.code, 'code', c['error']),
          ),
        );
      });
    }
  });

  group('format', () {
    for (final c in list('formatVnd')) {
      test(
        '${c['amount']} → ${c['expected']}',
        () => expect(formatVnd(fromWire(c['amount'] as String)), c['expected']),
      );
    }
    for (final c in list('formatKg')) {
      test(
        '${c['grams']} g → ${c['expected']}',
        () => expect(formatKg(c['grams'] as int), c['expected']),
      );
    }
  });

  group('wire codec', () {
    for (final c in list('wire')) {
      test('"${c['wire']}" hợp lệ = ${c['ok']}', () {
        final w = c['wire'] as String;
        if (c['ok'] as bool) {
          expect(toWire(fromWire(w)), w);
        } else {
          expect(() => fromWire(w), throwsA(isA<MoneyWeightError>()));
        }
      });
    }
  });
}
