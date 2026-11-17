import 'package:flutter_libserialport/flutter_libserialport.dart';

/// Spike CP02 (ADR-008): liệt kê cổng COM để kết nối cân. Driver cân thật (ScaleDriver) làm ở CP07.
/// Lỗi thư viện native không bị nuốt — để nổi lên cho màn chẩn đoán thiết bị hiển thị.
List<String> listSerialPorts() => SerialPort.availablePorts;
