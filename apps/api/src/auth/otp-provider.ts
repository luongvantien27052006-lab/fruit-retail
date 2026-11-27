import { Logger } from '@nestjs/common';
import type { Env } from '../config/env';

/** Gửi mã OTP tới SĐT khách (SEC6). Nhà cung cấp thật (SMS brandname / Zalo ZNS) làm ở CP14. */
export interface OtpProvider {
  readonly kind: 'TEST_DOUBLE' | 'SMS_BRANDNAME' | 'ZALO_ZNS';
  /** `phone` dạng E.164 (+84…). Lỗi ⇒ ném (route trả 503, không để khách chờ mã không bao giờ tới). */
  send(phone: string, code: string): Promise<void>;
}

export const OTP_PROVIDER = Symbol('OTP_PROVIDER');

/** Tin nhắn TEST_DOUBLE giữ trong bộ nhớ (tối đa 200) — test đọc mã qua `last()`. */
export interface TestDoubleMessage {
  phone: string;
  code: string;
  at: Date;
}

/**
 * Nhà cung cấp GIẢ có nhãn (KẾ HOẠCH: được dùng đến CP14): không gửi gì ra ngoài. Không bao giờ chạy ở production
 * (`createOtpProvider` từ chối khởi động). development/staging: ghi mã vào log có nhãn TEST_DOUBLE để người thử đăng
 * nhập được; test: không log, đọc qua `last()`.
 */
export class TestDoubleOtpProvider implements OtpProvider {
  readonly kind = 'TEST_DOUBLE' as const;
  private readonly log = new Logger('OtpProvider[TEST_DOUBLE]');
  private readonly sent: TestDoubleMessage[] = [];

  constructor(private readonly logCode: boolean) {}

  send(phone: string, code: string): Promise<void> {
    this.sent.push({ phone, code, at: new Date() });
    if (this.sent.length > 200) this.sent.shift();
    if (this.logCode)
      this.log.warn(`[TEST_DOUBLE — KHÔNG GỬI THẬT] OTP ${phone.slice(0, 3)}…${phone.slice(-3)}: ${code}`);
    return Promise.resolve();
  }

  last(phone: string): TestDoubleMessage | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i]?.phone === phone) return this.sent[i];
    return undefined;
  }

  count(phone: string): number {
    return this.sent.filter((m) => m.phone === phone).length;
  }
}

/**
 * Chọn nhà cung cấp lúc API khởi động. Ném lỗi ⇒ API không khởi động (FR-INV-17):
 * - production: phải có nhà cung cấp thật — chưa hiện thực (CP14) nên production chưa khởi động được với OTP; TEST_DOUBLE
 *   ở production bị từ chối.
 * - SMS_BRANDNAME / ZALO_ZNS ở mọi môi trường: chưa hiện thực ⇒ từ chối (không âm thầm rơi về giả).
 * - không đặt (không phải production) ⇒ `null`: route OTP trả 503 CONFIGURATION_NOT_READY.
 */
export function createOtpProvider(env: Env): OtpProvider | null {
  const kind = env.OTP_PROVIDER;
  if (env.NODE_ENV === 'production') {
    if (!kind) throw new Error('Thiếu OTP_PROVIDER — production cần nhà cung cấp OTP thật (SMS brandname / Zalo ZNS)');
    if (kind === 'TEST_DOUBLE') throw new Error('OTP_PROVIDER=TEST_DOUBLE bị cấm ở production');
  }
  if (kind === 'SMS_BRANDNAME' || kind === 'ZALO_ZNS')
    throw new Error(`OTP_PROVIDER=${kind} chưa được hiện thực (CP14) — không khởi động`);
  if (kind === 'TEST_DOUBLE') return new TestDoubleOtpProvider(env.NODE_ENV !== 'test');
  return null;
}
