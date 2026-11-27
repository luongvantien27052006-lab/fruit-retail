import { Inject, Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { AuditOutboxService, type Tx } from '../common/audit-outbox.service';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { ipTiers, type Limit, RateLimiter } from '../infra/rate-limiter.service';
import { AuthAttempts } from './auth-attempts';
import type { TokenPair } from './auth.service';
import { OTP_PROVIDER, type OtpProvider } from './otp-provider';
import { PiiCipher } from './pii-cipher';
import { AccessTokens, CUSTOMER_SESSION_S, randomToken, sha256 } from './tokens';

/** OTP khách (SEC6, ADR-012, ADR-023): 6 số, hạn 5 phút, tối đa 5 lần nhập cho một mã */
export const OTP_TTL_S = 5 * 60;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_S = 60;

/** Giới hạn gửi (theo SĐT / thiết bị / IP / toàn hệ thống — chi phí SMS) và giới hạn nhập sai theo SĐT */
export const OTP_SEND_LIMITS = {
  phone: [
    { max: 1, windowS: OTP_RESEND_S },
    { max: 5, windowS: 3600 },
    { max: 10, windowS: 86400 },
  ],
  device: [
    { max: 5, windowS: 3600 },
    { max: 20, windowS: 86400 },
  ],
  /** IPv4 và IPv6 /64 (rộng vì CGNAT di động — L3); IPv6 thêm tầng /56, /48 (L2) */
  ip: [
    { max: 30, windowS: 3600 },
    { max: 300, windowS: 86400 },
  ],
  ip6p56: [
    { max: 100, windowS: 3600 },
    { max: 1000, windowS: 86400 },
  ],
  ip6p48: [
    { max: 300, windowS: 3600 },
    { max: 3000, windowS: 86400 },
  ],
  /** trần chi phí SMS toàn hệ thống theo giờ và theo ngày (L2) */
  global: [
    { max: 2000, windowS: 3600 },
    { max: 20000, windowS: 86400 },
  ],
} as const;
/** nhập sai theo SĐT (cộng dồn qua mọi mã): 10 lần / giờ ⇒ chặn xác minh đến hết giờ */
export const OTP_VERIFY_FAIL_PER_PHONE = { max: 10, windowS: 3600 } as const;
export const OTP_VERIFY_PER_DEVICE = { max: 30, windowS: 600 } as const;

const otpWrong = () =>
  new AppError('OTP_INVALID', 'Mã xác minh không đúng hoặc đã hết hạn — kiểm tra lại hoặc gửi mã mới');

/**
 * SĐT di động Việt Nam → E.164 `+84xxxxxxxxx` (9 số sau mã nước, đầu số 3/5/7/8/9). Nhận `0912…`, `84912…`, `+84912…`,
 * có thể kèm khoảng trắng/chấm/gạch. Không hợp lệ ⇒ `null`.
 */
export function normalizeVnPhone(raw: string): string | null {
  const s = raw.replace(/[\s.-]/g, '');
  const m = /^(?:\+84|84|0)([35789]\d{8})$/.exec(s);
  return m?.[1] ? `+84${m[1]}` : null;
}

/** HMAC tra cứu SĐT — `users.phone_hash`, `otp_challenges.phone_hash`, định danh login_logs (ADR-015, ADR-023) */
export const phoneHash = (cipher: PiiCipher, e164: string) => cipher.hmac(`phone:${e164}`);
export const phoneAad = (userId: string) => `users:phone_enc:${userId}`;

/**
 * Khách đăng nhập SĐT + OTP (SEC6). Không tra tài khoản trước khi kiểm mã: request/verify cư xử giống hệt nhau dù SĐT
 * đã có tài khoản hay chưa (không dò được ai là khách). Xác minh đúng lần đầu ⇒ tạo tài khoản CUSTOMER.
 */
@Injectable()
export class CustomerAuthService {
  private readonly log = new Logger('CustomerAuth');
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    @Inject(OTP_PROVIDER) private readonly provider: OtpProvider | null,
    private readonly cipher: PiiCipher,
    private readonly tokens: AccessTokens,
    private readonly limiter: RateLimiter,
    private readonly attempts: AuthAttempts,
    private readonly ao: AuditOutboxService,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  private get tx() {
    return this.txHost.tx;
  }

  async request(phoneRaw: string): Promise<{ expires_at: string; resend_after_s: number }> {
    const phone = this.phoneOf(phoneRaw);
    const device = this.deviceOf();
    if (!this.provider) throw new AppError('CONFIGURATION_NOT_READY', 'Chưa cấu hình nhà cung cấp OTP');
    const ph = phoneHash(this.cipher, phone);
    const phId = Buffer.from(ph).toString('base64url');
    const ip = this.cls.get('ip');
    // SĐT đang bị khóa xác minh (nhập sai nhiều) ⇒ không gửi SMS vô ích (L1)
    await this.limiter.apply([{ name: 'otp.verify_fail.phone', id: phId, ...OTP_VERIFY_FAIL_PER_PHONE }], {
      mode: 'check',
      failOpen: false,
      errorCode: 'OTP_RATE_LIMITED',
    });
    const tierLimits = {
      v4: OTP_SEND_LIMITS.ip,
      p64: OTP_SEND_LIMITS.ip,
      p56: OTP_SEND_LIMITS.ip6p56,
      p48: OTP_SEND_LIMITS.ip6p48,
    };
    const limits: Limit[] = [
      ...OTP_SEND_LIMITS.phone.map((l) => ({ name: 'otp.send.phone', id: phId, ...l })),
      ...OTP_SEND_LIMITS.device.map((l) => ({ name: 'otp.send.device', id: device, ...l })),
      ...ipTiers(ip).flatMap((t) => tierLimits[t.tier].map((l) => ({ name: `otp.send.${t.tier}`, id: t.id, ...l }))),
      ...OTP_SEND_LIMITS.global.map((l) => ({ name: 'otp.send.global', id: 'all', ...l })),
    ];
    // Redis lỗi ⇒ 503 (không gửi SMS khi không giới hạn được)
    await this.limiter.apply(limits, { failOpen: false, errorCode: 'OTP_RATE_LIMITED' });
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const id = uuidv7();
    const row = await this.txHost.withTransaction(async () => {
      // một SĐT chỉ có một mã còn dùng được: mã mới thay mã cũ (lượt nhập không cộng dồn qua nhiều mã)
      await this.tx.otpChallenge.deleteMany({
        where: { phoneHash: ph, OR: [{ consumedAt: null }, { createdAt: { lt: new Date(Date.now() - 86400_000) } }] },
      });
      // hạn theo đồng hồ DB (created_at do trigger đặt bằng now()) ⇒ khớp CHECK otp_ttl
      await this.tx.$executeRaw`
        INSERT INTO core.otp_challenges (id, phone_hash, device_id, ip_hash, code_hash, expires_at)
        VALUES (${id}::uuid, ${Buffer.from(ph)}, ${device}, ${ip ? Buffer.from(this.cipher.hmac(`ip:${ip}`)) : null},
                ${this.codeHash(id, code)}, now() + make_interval(secs => ${OTP_TTL_S}))`;
      return this.tx.otpChallenge.findUniqueOrThrow({ where: { id }, select: { expiresAt: true } });
    });
    try {
      await this.provider.send(phone, code);
    } catch (e) {
      // review cổng CP03: giữ nguyên nhân để vận hành (chỉ loại/mã lỗi — không SĐT, không mã OTP)
      const err = e as { name?: string; code?: unknown };
      this.log.error(`Nhà cung cấp OTP lỗi: ${err?.name ?? 'Error'}${err?.code ? ` (${String(err.code)})` : ''}`);
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'Không gửi được mã xác minh — thử lại sau');
    }
    await this.attempts.log(null, 'OTP_SENT', ph);
    return { expires_at: row.expiresAt.toISOString(), resend_after_s: OTP_RESEND_S };
  }

  async verify(
    phoneRaw: string,
    code: string,
  ): Promise<TokenPair & { customer: { user_id: string; is_new: boolean } }> {
    const phone = this.phoneOf(phoneRaw);
    const device = this.deviceOf();
    const ph = phoneHash(this.cipher, phone);
    const phId = Buffer.from(ph).toString('base64url');
    const failLimit: Limit = { name: 'otp.verify_fail.phone', id: phId, ...OTP_VERIFY_FAIL_PER_PHONE };
    await this.limiter.apply([failLimit], { mode: 'check', failOpen: false, errorCode: 'OTP_RATE_LIMITED' });
    await this.limiter.apply([{ name: 'otp.verify.device', id: device, ...OTP_VERIFY_PER_DEVICE }], {
      failOpen: false,
      errorCode: 'OTP_RATE_LIMITED',
    });
    type Out =
      | { kind: 'ok'; value: TokenPair & { customer: { user_id: string; is_new: boolean } } }
      | { kind: 'bad' }
      | { kind: 'none' }
      | { kind: 'forbidden'; userId: string };
    // một lần thử = một transaction: lượt nhập (attempts + 1) commit dù mã sai
    const out = await this.txHost.withTransaction(async (): Promise<Out> => {
      // tuần tự hóa theo SĐT: hai lần nhập song song không cùng dùng một lượt, hai lần tạo tài khoản không đua nhau
      await this.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('otp:' || ${phId}, 0))`;
      const [c] = await this.tx.$queryRaw<{ id: string; code_hash: string }[]>`
        SELECT id, code_hash FROM core.otp_challenges
        WHERE phone_hash = ${Buffer.from(ph)} AND consumed_at IS NULL AND expires_at > now() AND attempts < ${OTP_MAX_ATTEMPTS}
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
      // không có mã còn dùng được: lần thử không đoán được gì ⇒ KHÔNG cộng bộ đếm sai theo SĐT (L1: nếu cộng, ai cũng
      // khóa được SĐT người khác bằng 10 request rẻ, không cần gửi SMS)
      if (!c) return { kind: 'none' };
      await this.tx.otpChallenge.update({
        where: { id: c.id },
        data: { attempts: { increment: 1 } },
        select: { id: true },
      });
      if (!safeEqual(c.code_hash, this.codeHash(c.id, code))) return { kind: 'bad' };
      await this.tx.otpChallenge.update({
        where: { id: c.id },
        data: { consumedAt: new Date() },
        select: { id: true },
      });
      const existing = await this.tx.user.findUnique({
        where: { phoneHash: ph },
        select: { id: true, type: true, status: true },
      });
      if (existing && (existing.type !== 'CUSTOMER' || existing.status !== 'ACTIVE'))
        return { kind: 'forbidden', userId: existing.id };
      const userId = existing?.id ?? (await this.createCustomer(phone, ph));
      const pair = await this.createSession(userId);
      await this.attempts.log(userId, 'SUCCESS', ph); // trước commit: không ghi được nhật ký ⇒ không ra phiên
      return { kind: 'ok', value: { ...pair, customer: { user_id: userId, is_new: !existing } } };
    });
    switch (out.kind) {
      case 'ok':
        return out.value;
      case 'forbidden':
        await this.attempts.log(out.userId, 'DISABLED', ph);
        throw new AppError('ACTION_FORBIDDEN', 'SĐT này không đăng nhập được ứng dụng khách — liên hệ cửa hàng');
      case 'bad':
        // chỉ lần nhập thật sự tiêu một lượt của mã (mã do SĐT đó xin — đã bị giới hạn gửi) mới cộng
        await this.limiter.apply([failLimit], { mode: 'add', failOpen: true });
        await this.attempts.log(null, 'BAD_OTP', ph);
        throw otpWrong();
      case 'none':
        // không ghi login_logs (request rẻ, chỉ bị guard IP chặn) — cùng lỗi với sai mã
        throw otpWrong();
    }
  }

  private async createCustomer(phone: string, ph: Uint8Array<ArrayBuffer>): Promise<string> {
    const id = uuidv7();
    await this.tx.user.create({
      data: { id, type: 'CUSTOMER', phoneHash: ph, phoneEnc: this.cipher.encrypt(phone, phoneAad(id)) },
      select: { id: true },
    });
    await this.tx.userRoleAssignment.create({
      data: { id: uuidv7(), userId: id, role: 'CUSTOMER', scopeType: 'ALL' },
      select: { id: true },
    });
    await this.ao.recordAudit({
      action: 'customer.register',
      resourceType: 'user',
      resourceId: id,
      actor: { userId: id, userType: 'CUSTOMER' },
      after: { type: 'CUSTOMER', via: 'otp' },
    });
    return id;
  }

  private async createSession(userId: string): Promise<TokenPair> {
    const now = new Date();
    const id = uuidv7();
    const ip = this.cls.get('ip');
    // hạn theo đồng hồ DB: CHECK sessions_times (≤ created_at + 60 ngày, created_at = now() do trigger) không lệch đồng hồ app
    await this.tx.$executeRaw`
      INSERT INTO core.sessions (id, user_id, user_type, amr, expires_at, ip_hash, user_agent)
      VALUES (${id}::uuid, ${userId}::uuid, 'CUSTOMER'::core."UserType", ARRAY['otp']::text[],
              now() + make_interval(secs => ${CUSTOMER_SESSION_S}),
              ${ip ? Buffer.from(this.cipher.hmac(`ip:${ip}`)) : null}, ${this.cls.get('userAgent')?.slice(0, 512) ?? null})`;
    const refresh = randomToken();
    await this.tx.refreshToken.create({
      data: { id: uuidv7(), sessionId: id, tokenHash: sha256(refresh) },
      select: { id: true },
    });
    const access = await this.tokens.sign({ sub: userId, typ: 'customer', sid: id, amr: ['otp'] }, now);
    return {
      access_token: access.token,
      access_token_expires_at: access.expiresAt.toISOString(),
      refresh_token: refresh,
      session_id: id,
      amr: ['otp'],
    };
  }

  /** HMAC(pepper, id:mã) — mã 6 số không dò ngược được từ DB nếu không có pepper; gắn id ⇒ không chép sang mã khác */
  private codeHash(id: string, code: string): string {
    return Buffer.from(this.cipher.hmac(`otp:${id}:${code}`)).toString('hex');
  }

  private phoneOf(raw: string): string {
    const p = normalizeVnPhone(raw);
    if (!p) throw new AppError('INVALID_REQUEST', 'Số điện thoại di động không hợp lệ', { field: 'phone' });
    return p;
  }

  private deviceOf(): string {
    const d = this.cls.get('deviceId');
    if (!d) throw new AppError('INVALID_REQUEST', 'Thiếu X-Device-Id');
    return d;
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
