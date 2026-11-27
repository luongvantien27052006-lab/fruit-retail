import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app_controller.dart';
import 'core/api_client.dart';
import 'core/config.dart';
import 'core/device_identity.dart';
import 'ui/screens.dart';

/// Staff app — một codebase, ba chế độ theo máy đã đăng ký (ADR-008, ADR-028): quầy (Windows), tablet, shipper (Android).
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  AppConfig config;
  try {
    config = AppConfig.fromEnvironment();
  } on FormatException catch (e) {
    runApp(ConfigErrorApp(message: e.message));
    return;
  }
  final controller = AppController(
    api: ApiClient(base: config.apiBase),
    store: SecureDeviceStore(),
    platform: Platform.isWindows ? 'windows' : 'android',
    idleLock: config.idleLock,
  );
  runApp(StaffApp(controller: controller));
  controller.init();
}

/// Bắt MỌI thao tác ở cấp app (review lát 9): chạm cả trong dialog/menu (overlay của Navigator nằm dưới builder), phím
/// cứng kể cả phím mà ô nhập đã xử lý (HardwareKeyboard thấy trước Shortcuts), app quay lại từ nền (so mốc thời gian).
class StaffApp extends StatefulWidget {
  const StaffApp({super.key, required this.controller});
  final AppController controller;

  @override
  State<StaffApp> createState() => _StaffAppState();
}

class _StaffAppState extends State<StaffApp> {
  late final AppLifecycleListener _life;

  bool _onKey(KeyEvent _) {
    widget.controller.touch();
    return false; // không nuốt phím
  }

  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_onKey);
    _life = AppLifecycleListener(onResume: widget.controller.resumed);
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onKey);
    _life.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    const seed = Color(0xFF2F7D4F);
    return MaterialApp(
      title: 'Ứng dụng nhân viên',
      theme: ThemeData(useMaterial3: true, colorSchemeSeed: seed),
      darkTheme: ThemeData(
        useMaterial3: true,
        colorSchemeSeed: seed,
        brightness: Brightness.dark,
      ),
      builder: (context, child) => Listener(
        behavior: HitTestBehavior.translucent,
        onPointerDown: (_) => controller.touch(),
        child: child,
      ),
      home: ListenableBuilder(
        listenable: controller,
        builder: (context, _) => switch (controller.stage) {
          Stage.loading => const Scaffold(
            body: Center(child: CircularProgressIndicator()),
          ),
          Stage.failed => FailedScreen(c: controller),
          Stage.setup => SetupScreen(c: controller),
          Stage.pending => PendingScreen(c: controller),
          Stage.pin => PinScreen(c: controller),
          Stage.revoked => RevokedScreen(c: controller),
          Stage.home => HomeScreen(c: controller),
        },
      ),
    );
  }
}

/// Cấu hình build sai (thiếu/sai API_BASE_URL) ⇒ báo rõ, không chạy tiếp.
class ConfigErrorApp extends StatelessWidget {
  const ConfigErrorApp({super.key, required this.message});
  final String message;

  @override
  Widget build(BuildContext context) => MaterialApp(
    home: Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text('Cấu hình sai: $message'),
        ),
      ),
    ),
  );
}
