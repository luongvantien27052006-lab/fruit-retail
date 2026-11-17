import 'package:flutter_test/flutter_test.dart';
import 'package:customer_app/main.dart';

void main() {
  testWidgets('khung hiển thị', (tester) async {
    await tester.pumpWidget(const CustomerApp());
    expect(find.textContaining('Khung ứng dụng (CP02)'), findsOneWidget);
  });
}
