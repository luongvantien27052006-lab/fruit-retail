/// Tiền và cân — helper DUY NHẤT của dự án (ADR-004, ADR-016, FR-INV-01…03).
///
/// Tiền: `int` VND 64-bit (đồng) — không chạy trên web nên `int` là 64-bit.
/// Khối lượng: `int` gram. Phép nhân dùng BigInt để không tràn âm thầm.
library;

enum MoneyWeightErrorCode {
  negative('NEGATIVE'),
  notInteger('NOT_INTEGER'),
  invalidWire('INVALID_WIRE'),
  outOfRange('OUT_OF_RANGE');

  const MoneyWeightErrorCode(this.wireName);
  final String wireName;
}

class MoneyWeightError implements Exception {
  MoneyWeightError(MoneyWeightErrorCode c, this.message) : code = c.wireName;

  /// Tên mã lỗi, khớp bản TS (`NEGATIVE`, `NOT_INTEGER`, …).
  final String code;
  final String message;

  @override
  String toString() => 'MoneyWeightError($code): $message';
}

final BigInt _int64Max = BigInt.parse('9223372036854775807');
final BigInt _int64Min = BigInt.parse('-9223372036854775808');
final RegExp _wireRe = RegExp(r'^-?(0|[1-9][0-9]{0,17})$');

int _assertGrams(num grams) {
  if (grams is! int) {
    throw MoneyWeightError(
      MoneyWeightErrorCode.notInteger,
      'Khối lượng phải là số nguyên gram: $grams',
    );
  }
  if (grams < 0) {
    throw MoneyWeightError(
      MoneyWeightErrorCode.negative,
      'Khối lượng âm: $grams',
    );
  }
  return grams;
}

void _assertNonNegative(int amount, String label) {
  if (amount < 0) {
    throw MoneyWeightError(MoneyWeightErrorCode.negative, '$label âm: $amount');
  }
}

int _toInt64(BigInt v) {
  if (v > _int64Max || v < _int64Min) {
    throw MoneyWeightError(MoneyWeightErrorCode.outOfRange, 'Vượt int64: $v');
  }
  return v.toInt();
}

/// Thành tiền hàng cân = round_half_up(pricePerKg × grams / 1000), chính xác 1 đồng (FR-INV-03).
int lineAmount(int pricePerKg, num grams) {
  _assertNonNegative(pricePerKg, 'Đơn giá/kg');
  final g = _assertGrams(grams);
  final x = BigInt.from(pricePerKg) * BigInt.from(g) + BigInt.from(500);
  return _toInt64(x ~/ BigInt.from(1000));
}

/// Thành tiền hàng đếm = đơn giá × số lượng.
int unitsAmount(int pricePerUnit, num units) {
  _assertNonNegative(pricePerUnit, 'Đơn giá');
  final u = _assertGrams(units);
  return _toInt64(BigInt.from(pricePerUnit) * BigInt.from(u));
}

String _groupThousands(String digits) =>
    digits.replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => '.');

/// Hiển thị VND kiểu Việt Nam: 1.250.000đ (§15).
String formatVnd(int amount) {
  final neg = amount < 0;
  final abs = neg ? -BigInt.from(amount) : BigInt.from(amount);
  return '${neg ? '-' : ''}${_groupThousands(abs.toString())}đ';
}

/// Hiển thị khối lượng: 0,845 kg — luôn 3 chữ số thập phân, dấu phẩy (§15).
String formatKg(num grams) {
  final g = _assertGrams(grams);
  final kg = g ~/ 1000;
  final rest = (g % 1000).toString().padLeft(3, '0');
  return '${_groupThousands(kg.toString())},$rest kg';
}

/// Chuỗi API → int (ADR-016). Từ chối số thực, mũ, khoảng trắng, quá 18 chữ số.
int fromWire(String wire) {
  if (!_wireRe.hasMatch(wire)) {
    throw MoneyWeightError(
      MoneyWeightErrorCode.invalidWire,
      'Chuỗi tiền không hợp lệ: "$wire"',
    );
  }
  return int.parse(wire);
}

/// int → chuỗi API (ADR-016).
String toWire(int amount) {
  final s = amount.toString();
  if (!_wireRe.hasMatch(s)) {
    throw MoneyWeightError(
      MoneyWeightErrorCode.outOfRange,
      'Quá 18 chữ số: $s',
    );
  }
  return s;
}
