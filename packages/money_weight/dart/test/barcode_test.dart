import 'dart:convert';
import 'dart:io';

import 'package:money_weight/money_weight.dart';
import 'package:test/test.dart';

/// Chạy CÙNG bộ vector mã vạch với bản TS (§6.5, §21.3.8, Phụ lục B).
void main() {
  final v =
      jsonDecode(
            File.fromUri(
              Directory.current.uri.resolve('../vectors/barcode.vectors.json'),
            ).readAsStringSync(),
          )
          as Map<String, dynamic>;
  List<Map<String, dynamic>> list(String k) =>
      (v[k] as List<dynamic>).cast<Map<String, dynamic>>();
  final rules = (v['rules'] as Map<String, dynamic>).map(
    (k, r) => MapEntry(k, BarcodeRuleDef.fromJson(r as Map<String, dynamic>)),
  );
  BarcodeRuleDef rule(Object? k) => rules[k as String]!;
  int? amountOf(Map<String, dynamic> m) =>
      m['amount'] == null ? null : int.parse(m['amount'] as String);

  group('EAN-13', () {
    for (final c in list('ean13')) {
      test(
        '${c['code']} ⇒ ${c['valid']}',
        () => expect(isValidEan13(c['code'] as String), c['valid']),
      );
    }
  });

  group('giải mã theo một quy tắc', () {
    for (final c in list('decode')) {
      test('${c['id']}: ${c['rule']} ${c['barcode']}', () {
        final r = decodeWith(rule(c['rule']), c['barcode'] as String);
        expect(r.ok, c['ok']);
        if (r.ok) {
          final d = r.decoded!;
          final got = <String, dynamic>{
            if (d.plu != null) 'plu': d.plu,
            if (d.grams != null) 'grams': d.grams,
            if (d.amount != null) 'amount': d.amount.toString(),
            if (d.value != null) 'value': d.value,
          };
          expect(got, c['expected']);
          expect(d.rule, c['rule']);
        } else {
          expect(r.reason, c['reason']);
        }
      });
    }
  });

  group('giải mã theo thứ tự quy tắc', () {
    for (final c in list('decodeFirst')) {
      test('${c['id']}: ${c['barcode']}', () {
        final rs = (c['rules'] as List<dynamic>).map(rule).toList();
        final r = decodeBarcode(rs, c['barcode'] as String);
        expect(r.ok, c['ok']);
        if (r.ok) {
          expect(r.decoded!.rule, c['rule']);
        } else {
          expect(r.reason, c['reason']);
        }
      });
    }
  });

  group('tạo mã', () {
    String enc(Map<String, dynamic> c) {
      final i = c['input'] as Map<String, dynamic>;
      return encodeWith(
        rule(c['rule']),
        plu: i['plu'] as String?,
        grams: i['grams'] as int?,
        amount: amountOf(i),
        value: i['value'] as String?,
      );
    }

    for (final c in list('encode')) {
      test(
        '${c['id']}: ${c['rule']} ⇒ ${c['expected']}',
        () => expect(enc(c), c['expected']),
      );
    }
    for (final c in list('encodeRejects')) {
      test('${c['id']}: ${c['rule']} từ chối', () {
        expect(
          () => enc(c),
          throwsA(
            isA<BarcodeError>().having((e) => e.code, 'code', c['error']),
          ),
        );
      });
    }
  });

  group('mẫu không hợp lệ', () {
    for (final c in list('patternRejects')) {
      test('${c['id']}: "${c['pattern']}"', () {
        expect(
          () => parsePattern(
            c['pattern'] as String,
            type: c['type'] as String,
            ean13Checksum: c['ean13Checksum'] as bool,
          ),
          throwsA(isA<BarcodeError>()),
        );
      });
    }
  });
}
