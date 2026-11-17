import 'package:flutter/material.dart';
import 'package:money_weight/money_weight.dart';

/// Staff app — 1 codebase, 3 chế độ theo thiết bị đã kích hoạt + vai trò (ADR-008).
/// CP02: chỉ khung. Chọn chế độ, đăng nhập PIN, kích hoạt thiết bị làm ở CP03.
enum StaffMode { counter, tablet, shipper }

void main() => runApp(const StaffApp());

class StaffApp extends StatelessWidget {
  const StaffApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Ứng dụng nhân viên',
      theme: ThemeData(useMaterial3: true),
      home: const _ShellScreen(),
    );
  }
}

class _ShellScreen extends StatelessWidget {
  const _ShellScreen();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Ứng dụng nhân viên')),
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('Khung ứng dụng (CP02) — đăng nhập PIN có ở CP03.'),
            const SizedBox(height: 16),
            // Kiểm liên kết package money_weight (vector Phụ lục A2).
            Text(
              'Ví dụ tính tiền: ${formatKg(845)} × ${formatVnd(320000)}/kg = ${formatVnd(lineAmount(320000, 845))}',
            ),
          ],
        ),
      ),
    );
  }
}
