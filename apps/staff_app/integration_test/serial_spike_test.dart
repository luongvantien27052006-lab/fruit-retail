import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:staff_app/devices/serial_ports.dart';

// Chạy trên Windows thật: flutter test integration_test -d windows
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('libserialport nạp được trên Windows và liệt kê cổng COM', (
    tester,
  ) async {
    final ports = listSerialPorts();
    // Máy dev có thể không có cổng COM nào; điều cần chứng minh là thư viện native chạy, không ném lỗi.
    expect(ports, isA<List<String>>());
    // ignore: avoid_print
    print(
      'Cổng COM tìm thấy: ${ports.isEmpty ? '(không có)' : ports.join(', ')}',
    );
  });
}
