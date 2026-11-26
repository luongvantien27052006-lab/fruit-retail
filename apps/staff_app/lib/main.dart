import 'dart:io' show Platform;

import 'package:flutter/material.dart';

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
    runApp(_ConfigError(e.message));
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

class StaffApp extends StatelessWidget {
  const StaffApp({super.key, required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    const seed = Color(0xFF2F7D4F);
    return MaterialApp(
      title: 'Ứng dụng nhân viên',
      theme: ThemeData(useMaterial3: true, colorSchemeSeed: seed),
      darkTheme: ThemeData(
        useMaterial3: true,
        colorSchemeSeed: seed,
        brightness: Brightness.dark,
      ),
      home: ListenableBuilder(
        listenable: controller,
        builder: (context, _) => switch (controller.stage) {
          Stage.loading => const Scaffold(
            body: Center(child: CircularProgressIndicator()),
          ),
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

class _ConfigError extends StatelessWidget {
  const _ConfigError(this.message);
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
