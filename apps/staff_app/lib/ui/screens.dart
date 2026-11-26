import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app_controller.dart';
import '../core/api_client.dart';
import '../core/device_identity.dart';
import '../core/device_proof.dart';

/// Khung chung: căn giữa, rộng tối đa 420 — dùng được cả màn quầy lẫn tablet/điện thoại.
class _Panel extends StatelessWidget {
  const _Panel({required this.title, required this.children});
  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: children,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ErrorText extends StatelessWidget {
  const _ErrorText(this.text);
  final String? text;

  @override
  Widget build(BuildContext context) {
    if (text == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Semantics(
        liveRegion: true,
        child: Text(
          text!,
          key: const Key('error'),
          style: TextStyle(color: Theme.of(context).colorScheme.error),
        ),
      ),
    );
  }
}

// ───────────────────────────── đăng ký máy ─────────────────────────────

class SetupScreen extends StatefulWidget {
  const SetupScreen({super.key, required this.c});
  final AppController c;

  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  final _form = GlobalKey<FormState>();
  final _code = TextEditingController();
  final _name = TextEditingController();
  late StaffMode _mode = widget.c.allowedModes.first;

  @override
  void dispose() {
    _code.dispose();
    _name.dispose();
    super.dispose();
  }

  void _submit() {
    if (!(_form.currentState?.validate() ?? false)) return;
    widget.c.register(
      enrollmentCode: _code.text,
      mode: _mode,
      name: _name.text,
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.c;
    return _Panel(
      title: 'Đăng ký máy',
      children: [
        const Text(
          'Máy này chưa đăng ký. Nhờ quản lý tạo mã ghi danh cho cửa hàng (hiệu lực 30 phút) rồi nhập vào đây.',
        ),
        const SizedBox(height: 16),
        Form(
          key: _form,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (c.allowedModes.length > 1)
                DropdownButtonFormField<StaffMode>(
                  key: const Key('mode'),
                  initialValue: _mode,
                  decoration: const InputDecoration(labelText: 'Chế độ máy'),
                  items: [
                    for (final m in c.allowedModes)
                      DropdownMenuItem(value: m, child: Text(m.label)),
                  ],
                  onChanged: (m) => setState(() => _mode = m ?? _mode),
                )
              else
                InputDecorator(
                  decoration: const InputDecoration(labelText: 'Chế độ máy'),
                  child: Text(_mode.label),
                ),
              const SizedBox(height: 12),
              TextFormField(
                key: const Key('device_name'),
                controller: _name,
                decoration: const InputDecoration(
                  labelText: 'Tên máy (vd Quầy 1)',
                ),
                maxLength: 100,
                validator: (v) =>
                    (v ?? '').trim().isEmpty ? 'Nhập tên máy' : null,
              ),
              TextFormField(
                key: const Key('enrollment_code'),
                controller: _code,
                decoration: const InputDecoration(
                  labelText: 'Mã ghi danh (XXXX-XXXX-XXXX)',
                ),
                textCapitalization: TextCapitalization.characters,
                autocorrect: false,
                enableSuggestions: false,
                validator: (v) => enrollmentCodeRe.hasMatch((v ?? '').trim())
                    ? null
                    : 'Mã ghi danh gồm 12 ký tự A–Z, 2–7',
                onFieldSubmitted: (_) => _submit(),
              ),
            ],
          ),
        ),
        _ErrorText(c.error),
        const SizedBox(height: 8),
        FilledButton(
          key: const Key('register'),
          onPressed: c.busy ? null : _submit,
          child: Text(c.busy ? 'Đang đăng ký…' : 'Đăng ký máy'),
        ),
      ],
    );
  }
}

class PendingScreen extends StatelessWidget {
  const PendingScreen({super.key, required this.c});
  final AppController c;

  @override
  Widget build(BuildContext context) {
    final code = c.identity?.pairingCode ?? '—';
    return _Panel(
      title: 'Chờ kích hoạt',
      children: [
        const Text(
          'Quản lý mở trang quản lý → Thiết bị POS → Kích hoạt, và nhập mã ghép dưới đây (đọc từ màn hình máy này):',
        ),
        const SizedBox(height: 16),
        SelectableText(
          code,
          key: const Key('pairing_code'),
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.displaySmall?.copyWith(
            letterSpacing: 4,
            fontFamily: 'monospace',
          ),
        ),
        const SizedBox(height: 8),
        Text(
          'Máy: ${c.identity?.name ?? ''} · ${c.identity?.mode.label ?? ''}',
          textAlign: TextAlign.center,
        ),
        _ErrorText(c.error),
        const SizedBox(height: 16),
        FilledButton(
          key: const Key('to_pin'),
          onPressed: c.goToPin,
          child: const Text('Đã kích hoạt — đăng nhập'),
        ),
        const SizedBox(height: 8),
        _ReRegisterButton(c: c),
      ],
    );
  }
}

class RevokedScreen extends StatelessWidget {
  const RevokedScreen({super.key, required this.c});
  final AppController c;

  @override
  Widget build(BuildContext context) {
    return _Panel(
      title: 'Máy đã bị thu hồi',
      children: [
        const Text(
          'Quản lý đã thu hồi máy này. Muốn dùng lại phải đăng ký máy mới với mã ghi danh mới.',
        ),
        _ErrorText(c.error),
        const SizedBox(height: 16),
        FilledButton(
          key: const Key('reset_device'),
          onPressed: c.resetDevice,
          child: const Text('Đăng ký lại máy'),
        ),
      ],
    );
  }
}

// ───────────────────────────── đăng nhập PIN ─────────────────────────────

class PinScreen extends StatefulWidget {
  const PinScreen({super.key, required this.c});
  final AppController c;

  @override
  State<PinScreen> createState() => _PinScreenState();
}

class _PinScreenState extends State<PinScreen> {
  final _form = GlobalKey<FormState>();
  final _code = TextEditingController();
  final _pin = TextEditingController();

  @override
  void dispose() {
    _code.dispose();
    _pin.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    final pin = _pin.text;
    _pin.clear(); // PIN không ở lại trên màn hình / trong bộ nhớ ô nhập sau khi gửi
    await widget.c.login(_code.text, pin);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.c;
    return _Panel(
      title: 'Đăng nhập nhân viên',
      children: [
        Text(
          '${c.identity?.name ?? ''} · ${c.identity?.mode.label ?? ''}',
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 16),
        Form(
          key: _form,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextFormField(
                key: const Key('staff_code'),
                controller: _code,
                decoration: const InputDecoration(labelText: 'Mã nhân viên'),
                textCapitalization: TextCapitalization.characters,
                autocorrect: false,
                enableSuggestions: false,
                autofocus: true,
                validator: (v) => staffCodeRe.hasMatch((v ?? '').trim())
                    ? null
                    : 'Mã nhân viên không hợp lệ',
              ),
              TextFormField(
                key: const Key('pin'),
                controller: _pin,
                decoration: const InputDecoration(labelText: 'PIN 6 số'),
                obscureText: true,
                keyboardType: TextInputType.number,
                inputFormatters: [
                  FilteringTextInputFormatter.digitsOnly,
                  LengthLimitingTextInputFormatter(6),
                ],
                autocorrect: false,
                enableSuggestions: false,
                validator: (v) =>
                    pinRe.hasMatch(v ?? '') ? null : 'PIN gồm đúng 6 số',
                onFieldSubmitted: (_) => _submit(),
              ),
            ],
          ),
        ),
        _ErrorText(c.error),
        const SizedBox(height: 8),
        FilledButton(
          key: const Key('login'),
          onPressed: c.busy ? null : _submit,
          child: Text(c.busy ? 'Đang kiểm tra…' : 'Đăng nhập'),
        ),
        const SizedBox(height: 8),
        _ReRegisterButton(c: c),
      ],
    );
  }
}

// ───────────────────────────── làm việc ─────────────────────────────

/// Màn làm việc theo chế độ. Nghiệp vụ (bán hàng CP07, soạn hàng, giao hàng CP15) chưa có ở CP03 — chỉ khung + khóa
/// màn hình. Mọi thao tác chạm/phím đặt lại đồng hồ tự khóa.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.c});
  final AppController c;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  String? _check;
  bool _checking = false;

  Future<void> _ping() async {
    final c = widget.c;
    final id = c.identity;
    final s = c.session;
    if (id == null || s == null || _checking) return;
    setState(() => _checking = true);
    try {
      final r = await c.api.authed(id, s, 'GET', '/auth/sessions');
      final n = (r['items'] as List?)?.length ?? 0;
      if (mounted) {
        setState(() => _check = 'Kết nối tốt — $n phiên đang mở của bạn.');
      }
    } on ApiException catch (e) {
      if (e.sessionEnded || e.deviceGone || e.code == 'CLOCK_SKEW') {
        c.sessionLost(e);
        return;
      }
      if (mounted) setState(() => _check = e.message);
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.c;
    final staff = c.session?.staff;
    // chạm/phím đặt lại đồng hồ tự khóa ở cấp app (main.dart: MaterialApp.builder + HardwareKeyboard)
    return Scaffold(
      appBar: AppBar(
        title: Text(c.identity?.mode.label ?? ''),
        actions: [
          TextButton.icon(
            key: const Key('lock'),
            onPressed: () => c.lock(),
            icon: const Icon(Icons.lock_outline),
            label: const Text('Khóa màn hình'),
          ),
        ],
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Xin chào ${staff?.fullName ?? ''}',
                key: const Key('greeting'),
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              Text(
                'Mã NV ${staff?.staffCode ?? ''} · ${c.identity?.name ?? ''}',
              ),
              const SizedBox(height: 16),
              Text(switch (c.identity?.mode) {
                StaffMode.counter => 'Màn bán hàng có ở CP07.',
                StaffMode.tablet => 'Soạn đơn, kiểm kho có ở CP06/CP14.',
                StaffMode.shipper => 'Danh sách giao hàng có ở CP15.',
                null => '',
              }),
              const SizedBox(height: 16),
              OutlinedButton(
                key: const Key('ping'),
                onPressed: _checking ? null : _ping,
                child: const Text('Kiểm tra kết nối'),
              ),
              if (_check != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(_check!, key: const Key('ping_result')),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Đăng ký lại máy (xóa khóa hiện tại) — lối ra khi máy kẹt chờ kích hoạt quá 7 ngày hoặc đăng ký mất phản hồi.
class _ReRegisterButton extends StatelessWidget {
  const _ReRegisterButton({required this.c});
  final AppController c;

  @override
  Widget build(BuildContext context) {
    return TextButton(
      key: const Key('re_register'),
      onPressed: c.busy
          ? null
          : () async {
              final ok = await showDialog<bool>(
                context: context,
                builder: (ctx) => AlertDialog(
                  title: const Text('Đăng ký lại máy?'),
                  content: const Text(
                    'Khóa hiện tại của máy sẽ bị xóa. Cần mã ghi danh MỚI từ quản lý; nếu máy cũ đã được kích hoạt, nhờ quản lý thu hồi nó.',
                  ),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.pop(ctx, false),
                      child: const Text('Hủy'),
                    ),
                    FilledButton(
                      key: const Key('re_register_confirm'),
                      onPressed: () => Navigator.pop(ctx, true),
                      child: const Text('Đăng ký lại'),
                    ),
                  ],
                ),
              );
              if (ok == true) await c.resetDevice();
            },
      child: const Text('Đăng ký lại máy'),
    );
  }
}

class FailedScreen extends StatelessWidget {
  const FailedScreen({super.key, required this.c});
  final AppController c;

  @override
  Widget build(BuildContext context) {
    return _Panel(
      title: 'Không khởi động được',
      children: [
        _ErrorText(c.error),
        const SizedBox(height: 16),
        FilledButton(
          key: const Key('retry_init'),
          onPressed: c.init,
          child: const Text('Thử lại'),
        ),
      ],
    );
  }
}
