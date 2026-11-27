/// Mã vạch theo quy tắc (§6.5, §21.3.8, Phụ lục B) — bản Dart, CÙNG vector
/// với bản TS (`vectors/barcode.vectors.json`). Xem chú thích ở
/// `packages/money_weight/ts/src/barcode.ts`.
library;

enum BarcodeErrorCode {
  invalidPattern('INVALID_PATTERN'),
  invalidValue('INVALID_VALUE');

  const BarcodeErrorCode(this.wireName);
  final String wireName;
}

class BarcodeError implements Exception {
  BarcodeError(BarcodeErrorCode c, this.message) : code = c.wireName;

  /// `INVALID_PATTERN` | `INVALID_VALUE` (khớp bản TS)
  final String code;
  final String message;

  @override
  String toString() => 'BarcodeError($code): $message';
}

/// Loại token trong mẫu
enum SegmentKind { lit, plu, w, p, c, id, code }

class Segment {
  Segment(this.kind, {this.text = '', this.len = 0});
  final SegmentKind kind;
  String text;
  final int len;
}

class BarcodeRuleDef {
  const BarcodeRuleDef({
    required this.code,
    required this.type,
    required this.pattern,
    required this.valueScale,
    required this.ean13Checksum,
  });

  factory BarcodeRuleDef.fromJson(Map<String, dynamic> j) => BarcodeRuleDef(
    code: j['code'] as String,
    type: j['type'] as String,
    pattern: j['pattern'] as String,
    valueScale: j['valueScale'] as int,
    ean13Checksum: j['ean13Checksum'] as bool,
  );

  final String code;

  /// WEIGHT | PRICE | PRODUCT | BATCH | ORDER | STAFF
  final String type;
  final String pattern;
  final int valueScale;
  final bool ean13Checksum;
}

class Decoded {
  Decoded(this.rule, this.type);
  final String rule;
  final String type;
  String? plu;

  /// gram (W × value_scale)
  int? grams;

  /// đồng (P × value_scale)
  int? amount;

  /// phần biến đổi {ID} / {CODE}
  String? value;
}

/// Kết quả giải mã: `decoded` khi khớp; ngược lại `reason` = NO_MATCH | CHECKSUM.
class DecodeResult {
  DecodeResult.ok(Decoded d) : decoded = d, reason = null, rule = null;
  DecodeResult.fail(this.reason, {this.rule}) : decoded = null;
  final Decoded? decoded;
  final String? reason;
  final String? rule;
  bool get ok => decoded != null;
}

final RegExp _token = RegExp(
  r'\{(PLU|W|P):([1-9])\}|\{C\}|\{ID\}|\{CODE\}|[0-9A-Z-]',
);
final RegExp _variable = RegExp(r'^[0-9A-Z-]{1,64}$');
final RegExp _digit = RegExp(r'^[0-9]$');

/// Phân tích mẫu; sai ⇒ BarcodeError(INVALID_PATTERN).
List<Segment> parsePattern(
  String pattern, {
  String? type,
  bool ean13Checksum = false,
}) {
  BarcodeError bad(String m) =>
      BarcodeError(BarcodeErrorCode.invalidPattern, m);
  if (pattern.isEmpty || pattern.length > 64) throw bad('Mẫu dài 1–64 ký tự');
  final segs = <Segment>[];
  var consumed = 0;
  for (final m in _token.allMatches(pattern)) {
    if (m.start != consumed) {
      throw bad('Ký tự không hợp lệ ở vị trí ${consumed + 1}');
    }
    consumed = m.end;
    final t = m.group(0)!;
    final name = m.group(1);
    if (name != null) {
      final kind = name == 'PLU'
          ? SegmentKind.plu
          : (name == 'W' ? SegmentKind.w : SegmentKind.p);
      segs.add(Segment(kind, len: int.parse(m.group(2)!)));
    } else if (t == '{C}') {
      segs.add(Segment(SegmentKind.c));
    } else if (t == '{ID}') {
      segs.add(Segment(SegmentKind.id));
    } else if (t == '{CODE}') {
      segs.add(Segment(SegmentKind.code));
    } else if (segs.isNotEmpty && segs.last.kind == SegmentKind.lit) {
      segs.last.text += t;
    } else {
      segs.add(Segment(SegmentKind.lit, text: t));
    }
  }
  if (consumed != pattern.length) {
    throw bad('Ký tự không hợp lệ ở vị trí ${consumed + 1}');
  }
  int count(SegmentKind k) => segs.where((s) => s.kind == k).length;
  if (count(SegmentKind.plu) > 1 ||
      count(SegmentKind.w) > 1 ||
      count(SegmentKind.p) > 1 ||
      count(SegmentKind.c) > 1) {
    throw bad('Mỗi token tối đa một lần');
  }
  if (count(SegmentKind.w) > 0 && count(SegmentKind.p) > 0) {
    throw bad('Không nhúng cả khối lượng và tiền');
  }
  final variable = count(SegmentKind.id) + count(SegmentKind.code);
  if (variable > 1) throw bad('Tối đa một phần biến đổi {ID} / {CODE}');
  if (count(SegmentKind.c) > 0 && segs.last.kind != SegmentKind.c) {
    throw bad('{C} phải ở cuối mẫu');
  }
  if (variable > 0 && count(SegmentKind.c) > 0) {
    throw bad('Phần biến đổi không đi cùng số kiểm {C}');
  }
  if (type == 'WEIGHT' &&
      !(count(SegmentKind.plu) > 0 && count(SegmentKind.w) > 0)) {
    throw bad('Quy tắc WEIGHT cần {PLU:n} và {W:n}');
  }
  if (type == 'PRICE' &&
      !(count(SegmentKind.plu) > 0 && count(SegmentKind.p) > 0)) {
    throw bad('Quy tắc PRICE cần {PLU:n} và {P:n}');
  }
  if (ean13Checksum) {
    if (count(SegmentKind.c) == 0) throw bad('Kiểm số EAN-13 cần {C} ở cuối');
    if (_fixedLength(segs) != 13) {
      throw bad('Mẫu EAN-13 phải dài đúng 13 ký tự');
    }
    if (segs.any(
      (s) => s.kind == SegmentKind.lit && !RegExp(r'^[0-9]+$').hasMatch(s.text),
    )) {
      throw bad('Mẫu EAN-13 chỉ gồm chữ số');
    }
  }
  return segs;
}

int? _fixedLength(List<Segment> segs) {
  var n = 0;
  for (final s in segs) {
    switch (s.kind) {
      case SegmentKind.lit:
        n += s.text.length;
      case SegmentKind.c:
        n += 1;
      case SegmentKind.id:
      case SegmentKind.code:
        return null;
      default:
        n += s.len;
    }
  }
  return n;
}

int _partLength(Segment s) => switch (s.kind) {
  SegmentKind.lit => s.text.length,
  SegmentKind.c => 1,
  SegmentKind.id || SegmentKind.code => 0,
  _ => s.len,
};

/// Số kiểm EAN-13 cho 12 chữ số đầu (Phụ lục B).
int ean13CheckDigit(String first12) {
  if (!RegExp(r'^[0-9]{12}$').hasMatch(first12)) {
    throw BarcodeError(BarcodeErrorCode.invalidValue, 'Cần đúng 12 chữ số');
  }
  var s = 0;
  for (var i = 0; i < 12; i++) {
    s += int.parse(first12[i]) * (i.isEven ? 1 : 3);
  }
  return (10 - (s % 10)) % 10;
}

bool isValidEan13(String code) =>
    RegExp(r'^[0-9]{13}$').hasMatch(code) &&
    ean13CheckDigit(code.substring(0, 12)) == int.parse(code[12]);

DecodeResult decodeWith(BarcodeRuleDef rule, String barcode) {
  final segs = parsePattern(
    rule.pattern,
    type: rule.type,
    ean13Checksum: rule.ean13Checksum,
  );
  final fixed = _fixedLength(segs);
  if (fixed != null && barcode.length != fixed) {
    return DecodeResult.fail('NO_MATCH');
  }
  final fixedPart = segs.fold<int>(0, (n, s) => n + _partLength(s));
  final varLen = barcode.length - fixedPart;
  if (fixed == null && varLen < 1) return DecodeResult.fail('NO_MATCH');
  final d = Decoded(rule.code, rule.type);
  var i = 0;
  String take(int n) =>
      i + n <= barcode.length ? barcode.substring(i, i + n) : '';
  for (final s in segs) {
    switch (s.kind) {
      case SegmentKind.lit:
        if (take(s.text.length) != s.text) return DecodeResult.fail('NO_MATCH');
        i += s.text.length;
      case SegmentKind.c:
        if (!_digit.hasMatch(take(1))) return DecodeResult.fail('NO_MATCH');
        i += 1;
      case SegmentKind.id:
      case SegmentKind.code:
        final v = take(varLen);
        if (!_variable.hasMatch(v)) return DecodeResult.fail('NO_MATCH');
        d.value = v;
        i += varLen;
      default:
        final v = take(s.len);
        if (!RegExp('^[0-9]{${s.len}}\$').hasMatch(v)) {
          return DecodeResult.fail('NO_MATCH');
        }
        if (s.kind == SegmentKind.plu) {
          d.plu = v;
        } else if (s.kind == SegmentKind.w) {
          d.grams = int.parse(v) * rule.valueScale;
        } else {
          d.amount = int.parse(v) * rule.valueScale;
        }
        i += s.len;
    }
  }
  if (rule.ean13Checksum && !isValidEan13(barcode)) {
    return DecodeResult.fail('CHECKSUM', rule: rule.code);
  }
  return DecodeResult.ok(d);
}

/// Thử theo thứ tự; khớp cấu trúc mà sai số kiểm ⇒ dừng, CHECKSUM.
DecodeResult decodeBarcode(List<BarcodeRuleDef> rules, String barcode) {
  for (final r in rules) {
    final res = decodeWith(r, barcode);
    if (res.ok || res.reason == 'CHECKSUM') return res;
  }
  return DecodeResult.fail('NO_MATCH');
}

/// Tạo mã theo quy tắc; sai giá trị ⇒ BarcodeError(INVALID_VALUE).
String encodeWith(
  BarcodeRuleDef rule, {
  String? plu,
  int? grams,
  int? amount,
  String? value,
}) {
  final segs = parsePattern(
    rule.pattern,
    type: rule.type,
    ean13Checksum: rule.ean13Checksum,
  );
  BarcodeError bad(String m) => BarcodeError(BarcodeErrorCode.invalidValue, m);
  String numStr(int x, int len, String what) {
    if (x < 0) throw bad('$what âm');
    final s = x.toString();
    if (s.length > len) throw bad('$what vượt $len chữ số');
    return s.padLeft(len, '0');
  }

  int scaled(int x, String what) {
    if (x % rule.valueScale != 0) {
      throw bad('$what phải là bội của ${rule.valueScale}');
    }
    return x ~/ rule.valueScale;
  }

  final out = StringBuffer();
  for (final s in segs) {
    switch (s.kind) {
      case SegmentKind.lit:
        out.write(s.text);
      case SegmentKind.c:
        out.write(ean13CheckDigit(out.toString()));
      case SegmentKind.id:
      case SegmentKind.code:
        if (value == null || !_variable.hasMatch(value)) {
          throw bad('Phần biến đổi: 1–64 ký tự số / chữ HOA / -');
        }
        out.write(value);
      case SegmentKind.plu:
        if (plu == null ||
            !RegExp(r'^[0-9]+$').hasMatch(plu) ||
            plu.length > s.len) {
          throw bad('PLU tối đa ${s.len} chữ số');
        }
        out.write(plu.padLeft(s.len, '0'));
      case SegmentKind.w:
        if (grams == null) throw bad('Khối lượng phải là số nguyên gram');
        if (grams < 0) throw bad('Khối lượng âm');
        out.write(numStr(scaled(grams, 'Khối lượng'), s.len, 'Khối lượng'));
      case SegmentKind.p:
        if (amount == null) throw bad('Thiếu tiền');
        if (amount < 0) throw bad('Tiền âm');
        out.write(numStr(scaled(amount, 'Tiền'), s.len, 'Tiền'));
    }
  }
  return out.toString();
}
