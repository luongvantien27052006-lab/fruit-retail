import 'package:flutter_test/flutter_test.dart';
import 'package:staff_app/main.dart';

void main() {
  testWidgets('khung hiển thị và tính tiền qua money_weight đúng vector A2', (
    tester,
  ) async {
    await tester.pumpWidget(const StaffApp());
    expect(find.text('Ứng dụng nhân viên'), findsOneWidget);
    expect(find.textContaining('= 270.400đ'), findsOneWidget);
    expect(find.textContaining('0,845 kg'), findsOneWidget);
  });
}
