import 'package:flutter/material.dart';

/// App người dùng (A1): thông báo + mặt hàng đẩy, chỉ giao trong vùng giao (§7).
/// CP02: chỉ khung. Màn U01–U14 làm ở CP14.
void main() => runApp(const CustomerApp());

class CustomerApp extends StatelessWidget {
  const CustomerApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Hoa quả',
      theme: ThemeData(useMaterial3: true),
      home: const Scaffold(
        body: Center(
          child: Text('Khung ứng dụng (CP02) — các màn hình có ở CP14.'),
        ),
      ),
    );
  }
}
