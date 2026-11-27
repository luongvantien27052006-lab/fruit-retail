import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import type { Tx } from '../common/audit-outbox.service';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { AuditWriterService, type LoginResult } from '../infra/audit-writer.service';
import { ipTiers } from '../infra/rate-limiter.service';
import { withArgonSlot } from './password';
import { MFA_CHALLENGE_MAX_ATTEMPTS } from './tokens';

/**
 * SEC5 (ADR-012/021, sửa theo ADR-030): 5 lần sai liên tiếp từ MỘT nguồn ⇒ khóa cặp (tài khoản, nguồn) 15 phút, mỗi lần
 * khóa sau gấp đôi, trần 24 giờ; mức khóa tự về 0 sau 24 giờ không có lần sai. Nguồn = mạng IP (/64 với IPv6) cho
 * login/2FA/mã khôi phục, = máy POS cho PIN ⇒ kẻ ẩn danh chỉ khóa được chính nguồn của mình.
 * ≥ 10 nguồn cùng đang bị khóa ⇒ khóa TOÀN tài khoản 1 giờ (tấn công phân tán) + log LOCKED_GLOBAL.
 * Xác thực lại TRONG phiên đã đăng nhập (step-up, mật khẩu hiện tại) đếm theo phiên: sai 5 lần ⇒ thu hồi phiên đó;
 * không bị khóa đăng nhập chặn (kẻ ẩn danh không làm tê liệt được Master đang làm việc).
 */
export const MAX_FAILED = 5;
const LOCK_BASE_MIN = 15;
const LOCK_MAX_MIN = 24 * 60;
export const GLOBAL_LOCK_SOURCES = 10;
const GLOBAL_LOCK_MIN = 60;
/**
 * Review cổng CP03 lần 2 (TB-3): kẻ xoay vòng nhiều mạng (giữ < 10 nguồn bị khóa cùng lúc) từng thử được ~4.300 lần/ngày.
 * Ngân sách theo TÀI KHOẢN: ≥ 50 lần sai trong 24 giờ (mọi nguồn cộng lại) ⇒ khóa toàn tài khoản tới hết cửa sổ + log
 * LOCKED_GLOBAL. Phiên đang mở / step-up không bị ảnh hưởng; Master khác gỡ được.
 */
export const ACCOUNT_DAILY_BUDGET = 50;
/** bước 2FA (sau khi mật khẩu đã đúng) đếm theo TÀI KHOẢN — chỉ người biết mật khẩu tới được, không là bề mặt DoS ẩn danh */
export const MFA_SOURCE = 'mfa';
/** "quen" hết hạn sau 90 ngày không có phiên mới qua 2FA trên trình duyệt / máy đó */
const TRUSTED_DAYS = 90;
/** phiên bị thu hồi vì các lý do này KHÔNG chứng minh trình duyệt / máy đáng tin */
const UNTRUSTING_REVOKES = [
  'ADMIN_REVOKED',
  'REFRESH_REUSE',
  'TWO_FACTOR_RESET',
  'PASSWORD_CHANGED',
  'REAUTH_FAILED',
  'PIN_RESET',
  'DEVICE_REVOKED',
  'USER_LOCKED',
  'USER_REVOKED',
  'USER_DISABLED',
];

/**
 * Master mở khóa / đặt lại PIN: xóa mọi khóa tạm của tài khoản (theo nguồn + toàn tài khoản). Người gọi đã giữ khóa
 * `auth:<id>` trong transaction.
 */
/** Sự kiện an ninh ⇒ mọi trình duyệt / máy "quen" trước đó hết quen (review cổng lần 4 T-7). */
export async function bumpTrust(
  tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<number> },
  userId: string,
): Promise<void> {
  await tx.$executeRaw`UPDATE core.users SET trust_epoch = now() WHERE id = ${userId}::uuid`;
}

// clearAllLocks đặt ngân sách về 0: kẻ tấn công phải làm đầy lại từ đầu (nhiều giờ với ít nguồn) — gỡ khóa có tác dụng thật
export async function clearAllLocks(
  tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<number> },
  userId: string,
): Promise<void> {
  await tx.$executeRaw`DELETE FROM core.auth_lockouts WHERE user_id = ${userId}::uuid`;
  await tx.$executeRaw`
    UPDATE core.users SET locked_until = NULL, lock_count = 0, failed_login_count = 0, fail_window_count = 0,
      fail_window_start = NULL
    WHERE id = ${userId}::uuid`;
}

/** Đang có khóa tạm nào (theo nguồn hoặc toàn tài khoản)? */
export async function hasTempLock(
  tx: { $queryRaw: <T>(q: TemplateStringsArray, ...v: unknown[]) => Promise<T> },
  userId: string,
): Promise<boolean> {
  const [r] = await tx.$queryRaw<{ locked: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM core.auth_lockouts WHERE user_id = ${userId}::uuid AND locked_until > now())
        OR EXISTS (SELECT 1 FROM core.users WHERE id = ${userId}::uuid AND locked_until > now()) AS locked`;
  return !!r?.locked;
}

/**
 * Phạm vi đếm sai: theo nguồn (luồng đăng nhập) hoặc theo phiên (xác thực lại khi đã đăng nhập). `trusted` = trình duyệt
 * QUEN (đã từng đăng nhập trọn vẹn) ⇒ không bị khóa toàn tài khoản (NC-25, Tiến duyệt 2026-11-27).
 */
export type AttemptScope = { source: string; trusted?: boolean } | { sessionId: string };

const h22 = (v: string) => createHash('sha256').update(v, 'utf8').digest('base64url').slice(0, 22);
/**
 * Nguồn IP băm (không lưu IP thô): IPv4 nguyên địa chỉ; IPv6 gộp theo /48 (review cổng lần 2: một VPS có /48 = 65.536 dải
 * /64 — không được thành 65.536 nguồn).
 */
export const ipSource = (ip: string | undefined) => {
  const tiers = ipTiers(ip);
  return `ip:${h22(tiers[tiers.length - 1]?.id ?? 'ip:?')}`;
};
export const deviceSource = (deviceId: string) => `dev:${deviceId.toLowerCase()}`;
/** trình duyệt / app quen (X-Device-Id khớp một phiên đã qua 2FA trước đó) */
export const clientSource = (clientDevice: string) => `cli:${h22(clientDevice)}`;

export const challengeInvalid = () =>
  new AppError('MFA_CHALLENGE_INVALID', 'Phiên xác minh 2FA không hợp lệ hoặc đã hết hạn — đăng nhập lại');
export const otpInvalid = () => new AppError('OTP_INVALID', 'Mã xác minh không đúng');

export interface AttemptGuard {
  userId: string;
  identifierHash: Uint8Array | null;
  challengeId?: string;
  /** cần suất Argon2 (mật khẩu, PIN, mã khôi phục) */
  argon: boolean;
  /**
   * Luồng đăng nhập công khai (/auth/login, /auth/pin): MỌI từ chối (sai, khóa, vô hiệu, bận) trả cùng lỗi này —
   * không liệt kê được tài khoản (S3, T1). Không đặt ⇒ khóa trả ACCOUNT_LOCKED, sai trả OTP_INVALID.
   */
  publicError?: () => AppError;
  /** chỉ cho nhánh SAI (không đổi lỗi khóa/bận) — vd đổi mật khẩu: sai mật khẩu hiện tại ≠ phiên hết hạn */
  failError?: () => AppError;
  failResult: LoginResult;
  /** cân thời gian nhánh bị từ chối của luồng công khai */
  dummy?: () => Promise<void>;
  /** khóa giới hạn suất Argon2; mặc định theo IP */
  slot?: string;
  /** mặc định: nguồn IP của request */
  scope?: AttemptScope;
}

/**
 * Một lần thử xác thực = MỘT transaction (ADR-021 mục 7; dùng chung cho Master/Viewer và nhân viên POS — ADR-022).
 * 1. lấy suất Argon2 (nếu cần) TRƯỚC khi mở transaction — hàng đợi đầy ⇒ 429, chưa động vào DB;
 * 2. `pg_try_advisory_xact_lock` theo tài khoản — lần thử khác của cùng tài khoản đang chạy ⇒ 429 ngay (không chờ, không
 *    giữ kết nối), nên mọi lần thử của một tài khoản chạy TUẦN TỰ;
 * 3. đọc trạng thái khóa MỚI NHẤT; khóa/vô hiệu ⇒ từ chối không kiểm thật; có challenge ⇒ tính một lượt (attempts + 1);
 * 4. kiểm; sai ⇒ cộng bộ đếm (đủ 5 ⇒ khóa có hạn) và COMMIT; đúng ⇒ `onSuccess` trong cùng transaction.
 * Không có "chỗ giữ" nào tồn tại ngoài transaction: request chết giữa chừng ⇒ rollback, không rò, không khóa vĩnh viễn.
 * login_logs của lần bị từ chối/sai ghi SAU khi commit (pool audit_writer lỗi không làm mất lần đếm — S4).
 */
@Injectable()
export class AuthAttempts {
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly auditWriter: AuditWriterService,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  private get tx() {
    return this.txHost.tx;
  }

  async run<T>(g: AttemptGuard, check: () => Promise<boolean>, onSuccess: () => Promise<T>): Promise<T> {
    const scope = g.scope ?? { source: this.ipSource() };
    let globalLocked = false;
    type Out =
      | { kind: 'ok'; value: T }
      | { kind: 'busy' | 'challenge' | 'fail' | 'reauth_revoked' }
      | { kind: 'locked'; status: string; until: Date | null };
    const run = (): Promise<Out> =>
      this.txHost.withTransaction(async (): Promise<Out> => {
        // review cổng lần 2 (TB-A): khóa tài khoản dạng CHIA SẺ (thao tác quản trị — đổi PIN/khóa/reset 2FA — vẫn lấy khóa
        // độc quyền `auth:<id>` nên chờ hết lần thử đang chạy) + khóa ĐỘC QUYỀN theo (tài khoản, nguồn | phiên): lần thử
        // của nguồn A đang chạy không chặn nguồn B hay step-up của phiên đang mở
        const key = 'source' in scope ? `s:${scope.source}` : `p:${scope.sessionId}`;
        const [lk] = await this.tx.$queryRaw<{ ok: boolean }[]>`
          SELECT pg_try_advisory_xact_lock_shared(hashtextextended('auth:' || ${g.userId}::uuid::text, 0))
             AND pg_try_advisory_xact_lock(hashtextextended('auth:' || ${g.userId}::uuid::text || ':' || ${key}, 0)) AS ok`;
        if (!lk?.ok) {
          // luồng công khai: nhánh bận phải giống hệt sai mật khẩu (thời gian + mã lỗi) — không lộ tài khoản có thật (T1)
          if (g.dummy) await g.dummy();
          return { kind: 'busy' };
        }
        const [st] = await this.tx.$queryRaw<
          { status: string; locked_until: Date | null; locked: boolean; temp_pw: boolean }[]
        >`
          SELECT status::text AS status, locked_until, (locked_until IS NOT NULL AND locked_until > now()) AS locked,
                 (must_change_password AND totp_enabled_at IS NULL) AS temp_pw
          FROM core.users WHERE id = ${g.userId}::uuid`;
        // trạng thái LOCKED/DISABLED chặn mọi luồng; khóa TẠM toàn tài khoản chỉ chặn luồng đăng nhập (không chặn phiên)
        // trình duyệt quen (trusted) không bị khóa toàn tài khoản — kẻ tấn công không biết định danh của nó (NC-25)
        // tài khoản chưa kích hoạt (mật khẩu tạm 120 bit — không dò nổi) cũng không bị: kẻ biết email không chặn được việc
        // kích hoạt bằng trình duyệt mới (review cổng lần 3 TB-4)
        const tempLocked = 'source' in scope && !scope.trusted && !st?.temp_pw && !!st?.locked;
        if (!st || st.status !== 'ACTIVE' || tempLocked) {
          if (g.dummy) await g.dummy();
          return { kind: 'locked', status: st?.status ?? 'DISABLED', until: tempLocked ? st.locked_until : null };
        }
        if ('source' in scope) {
          const [lo] = await this.tx.$queryRaw<{ locked_until: Date | null; locked: boolean }[]>`
            SELECT locked_until, (locked_until IS NOT NULL AND locked_until > now()) AS locked
            FROM core.auth_lockouts WHERE user_id = ${g.userId}::uuid AND source = ${scope.source} FOR UPDATE`;
          if (lo?.locked) {
            if (g.dummy) await g.dummy();
            return { kind: 'locked', status: 'ACTIVE', until: lo.locked_until };
          }
        }
        if (g.challengeId) {
          const c = await this.tx.authChallenge.updateMany({
            where: {
              id: g.challengeId,
              usedAt: null,
              attempts: { lt: MFA_CHALLENGE_MAX_ATTEMPTS },
              expiresAt: { gt: new Date() },
            },
            data: { attempts: { increment: 1 } },
          });
          if (c.count !== 1) return { kind: 'challenge' };
        }
        if (!(await check())) {
          if ('sessionId' in scope) {
            const [r] = await this.tx.$queryRaw<{ n: number }[]>`
              UPDATE core.sessions SET reauth_failed_count = reauth_failed_count + 1
              WHERE id = ${scope.sessionId}::uuid AND revoked_at IS NULL RETURNING reauth_failed_count AS n`;
            if ((r?.n ?? MAX_FAILED) >= MAX_FAILED) {
              await this.tx.$executeRaw`
                UPDATE core.sessions SET revoked_at = now(), revoke_reason = 'REAUTH_FAILED'
                WHERE id = ${scope.sessionId}::uuid AND revoked_at IS NULL`;
              return { kind: 'reauth_revoked' };
            }
            return { kind: 'fail' };
          }
          // một nguồn: mức khóa/bộ đếm về 0 sau 24 giờ không có lần sai
          const [lo] = await this.tx.$queryRaw<{ failed: number; locks: number }[]>`
            INSERT INTO core.auth_lockouts AS l (user_id, source, failed_count, lock_count, updated_at)
            VALUES (${g.userId}::uuid, ${scope.source}, 0, 0, now())
            ON CONFLICT (user_id, source) DO UPDATE SET
              -- 24 giờ YÊN LẶNG tính từ mốc muộn hơn của lần sai cuối và hết khóa (khóa trần 24 giờ không tự reset ngay)
              failed_count = CASE WHEN GREATEST(l.updated_at, COALESCE(l.locked_until, l.updated_at)) < now() - interval '24 hours'
                THEN 0 ELSE l.failed_count END,
              lock_count = CASE WHEN GREATEST(l.updated_at, COALESCE(l.locked_until, l.updated_at)) < now() - interval '24 hours'
                THEN 0 ELSE l.lock_count END
            RETURNING failed_count AS failed, lock_count AS locks`;
          const failed = (lo?.failed ?? 0) + 1;
          const locks = lo?.locks ?? 0;
          // ngân sách theo tài khoản (cửa sổ 24 giờ, mọi nguồn)
          const [w] = await this.tx.$queryRaw<{ n: number }[]>`
            UPDATE core.users SET
              fail_window_count = CASE WHEN fail_window_start IS NULL OR fail_window_start < now() - interval '24 hours'
                THEN 1 ELSE fail_window_count + 1 END,
              fail_window_start = CASE WHEN fail_window_start IS NULL OR fail_window_start < now() - interval '24 hours'
                THEN now() ELSE fail_window_start END
            WHERE id = ${g.userId}::uuid RETURNING fail_window_count AS n`;
          if ((w?.n ?? 0) >= ACCOUNT_DAILY_BUDGET) {
            await this.tx.$executeRaw`
              UPDATE core.users SET locked_until = GREATEST(COALESCE(locked_until, now()),
                fail_window_start + interval '24 hours', now() + make_interval(mins => ${GLOBAL_LOCK_MIN}::int))
              WHERE id = ${g.userId}::uuid`;
            globalLocked = true;
          }
          if (failed >= MAX_FAILED) {
            const mins = Math.min(LOCK_BASE_MIN * 2 ** Math.min(locks, 7), LOCK_MAX_MIN);
            await this.tx.$executeRaw`
              UPDATE core.auth_lockouts SET failed_count = 0, lock_count = lock_count + 1,
                locked_until = now() + make_interval(mins => ${mins}::int), updated_at = now()
              WHERE user_id = ${g.userId}::uuid AND source = ${scope.source}`;
            const [c] = await this.tx.$queryRaw<{ n: number }[]>`
              SELECT count(*)::int AS n FROM core.auth_lockouts
              WHERE user_id = ${g.userId}::uuid AND locked_until > now()`;
            if ((c?.n ?? 0) >= GLOBAL_LOCK_SOURCES) {
              await this.tx.$executeRaw`
                UPDATE core.users SET locked_until = GREATEST(COALESCE(locked_until, now()),
                  now() + make_interval(mins => ${GLOBAL_LOCK_MIN}::int))
                WHERE id = ${g.userId}::uuid`;
              globalLocked = true;
            }
          } else {
            await this.tx.$executeRaw`
              UPDATE core.auth_lockouts SET failed_count = ${failed}::int, updated_at = now()
              WHERE user_id = ${g.userId}::uuid AND source = ${scope.source}`;
          }
          return { kind: 'fail' };
        }
        return { kind: 'ok', value: await onSuccess() };
      });
    let out: Out;
    try {
      out = g.argon ? await withArgonSlot(g.slot ?? this.ipSlot(), run) : await run();
    } catch (e) {
      if (e instanceof AppError && e.code === 'RATE_LIMITED')
        await this.log(g.userId, 'RATE_LIMITED', g.identifierHash);
      throw e;
    }
    switch (out.kind) {
      case 'ok':
        return out.value;
      case 'busy':
        await this.log(g.userId, 'RATE_LIMITED', g.identifierHash);
        if (g.publicError) throw g.publicError();
        throw new AppError(
          'RATE_LIMITED',
          'Đang xử lý một lần đăng nhập khác của tài khoản này — thử lại sau giây lát',
        );
      case 'challenge':
        await this.log(g.userId, 'CHALLENGE_INVALID', null);
        throw challengeInvalid();
      case 'locked':
        await this.log(g.userId, out.status === 'DISABLED' ? 'DISABLED' : 'LOCKED', g.identifierHash);
        throw g.publicError ? g.publicError() : this.lockedError(out.until);
      case 'reauth_revoked':
        await this.log(g.userId, 'REAUTH_REVOKED', g.identifierHash);
        throw new AppError('SESSION_REVOKED', 'Xác thực lại sai quá 5 lần — phiên đã bị thu hồi, đăng nhập lại');
      case 'fail':
        await this.log(g.userId, g.failResult, g.identifierHash);
        if (globalLocked) await this.log(g.userId, 'LOCKED_GLOBAL', g.identifierHash);
        throw g.publicError ? g.publicError() : g.failError ? g.failError() : otpInvalid();
    }
  }

  /** Khóa giới hạn suất Argon2 theo nguồn (IP đã qua trust proxy) */
  ipSlot(): string {
    return `ip:${this.cls.get('ip') ?? '?'}`;
  }

  /** nguồn khóa của request hiện tại (mạng IP) */
  ipSource(): string {
    return ipSource(this.cls.get('ip'));
  }

  /**
   * Nguồn của lần đăng nhập (login / 2FA): X-Device-Id khớp `client_device` của một phiên ĐÃ QUA 2FA trước đó ⇒ trình
   * duyệt quen: nguồn riêng `cli:` + trusted (không bị khóa toàn tài khoản, không chung khóa với IP của kẻ khác). Còn lại
   * ⇒ nguồn IP.
   */
  /**
   * Phạm vi bước 2FA (verify / recover): trình duyệt QUEN ⇒ nguồn riêng của nó (kẻ lộ mật khẩu khóa bước 2FA của tài
   * khoản không chặn được trình duyệt quen — review cổng lần 3 TB-1); còn lại ⇒ đếm theo TÀI KHOẢN (nguồn `mfa`).
   */
  async mfaScope(userId: string): Promise<{ source: string; trusted: boolean }> {
    const l = await this.loginSource(userId);
    return l.trusted ? l : { source: MFA_SOURCE, trusted: false };
  }

  /**
   * Phạm vi PIN: máy POS mà nhân viên đã từng đăng nhập PIN thành công (phiên không bị thu hồi vì lý do an ninh, 90 ngày)
   * ⇒ quen: không bị khóa toàn tài khoản (review cổng lần 3 TB-4: thu ngân ở 2 máy khác không khóa được cửa hàng trưởng
   * trên máy của chính họ). Khóa theo máy vẫn chặn dò PIN.
   */
  async pinScope(userId: string, deviceId: string): Promise<{ source: string; trusted: boolean }> {
    const seen = await this.tx.session.count({
      where: {
        userId,
        posDeviceId: deviceId,
        createdAt: { gt: await this.trustSince(userId) },
        OR: [{ revokeReason: null }, { revokeReason: { notIn: [...UNTRUSTING_REVOKES] } }],
      },
    });
    return { source: deviceSource(deviceId), trusted: seen > 0 };
  }

  /** "quen" chỉ tính phiên tạo sau max(90 ngày trước, mốc an ninh gần nhất của tài khoản) */
  private async trustSince(userId: string): Promise<Date> {
    const u = await this.tx.user.findUnique({ where: { id: userId }, select: { trustEpoch: true } });
    const floor = Date.now() - TRUSTED_DAYS * 24 * 3600 * 1000;
    return new Date(Math.max(floor, u?.trustEpoch?.getTime() ?? 0));
  }

  async loginSource(userId: string): Promise<{ source: string; trusted: boolean }> {
    const dev = this.cls.get('deviceId');
    if (dev) {
      const seen = await this.tx.session.count({
        // T-5 (review cổng lần 3): phiên bị thu hồi vì lý do an ninh không làm trình duyệt thành "quen"; chỉ 90 ngày gần đây
        where: {
          userId,
          clientDevice: dev,
          amr: { hasSome: ['otp', 'rcv'] },
          createdAt: { gt: await this.trustSince(userId) },
          OR: [{ revokeReason: null }, { revokeReason: { notIn: [...UNTRUSTING_REVOKES] } }],
        },
      });
      if (seen > 0) return { source: clientSource(dev), trusted: true };
    }
    return { source: this.ipSource(), trusted: false };
  }

  lockedError(until?: Date | null): AppError {
    return new AppError(
      'ACCOUNT_LOCKED',
      'Tài khoản đang bị khóa',
      until ? { retry_after_s: Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000)) } : undefined,
    );
  }

  /**
   * Lần thử đúng (trong transaction của `run`, đã giữ khóa tài khoản). Theo nguồn: full = đăng nhập trọn vẹn ⇒ xóa dòng
   * khóa của nguồn đó (cả mức tăng dần) + ghi lastLoginAt; không full (mật khẩu đúng nhưng chưa có 2FA) ⇒ chỉ xóa bộ đếm.
   * Theo phiên: xóa bộ đếm xác thực lại của phiên.
   */
  async clearFailures(userId: string, full: boolean, scope?: AttemptScope): Promise<void> {
    const sc = scope ?? { source: this.ipSource() };
    if ('sessionId' in sc) {
      await this.tx.$executeRaw`UPDATE core.sessions SET reauth_failed_count = 0 WHERE id = ${sc.sessionId}::uuid`;
      return;
    }
    if (full) {
      // đăng nhập trọn vẹn ⇒ xóa dòng của nguồn được truyền, nguồn đăng nhập hiện tại (IP hoặc trình duyệt quen) và bước 2FA
      const login = (await this.loginSource(userId)).source;
      await this.tx.$executeRaw`
        DELETE FROM core.auth_lockouts
        WHERE user_id = ${userId}::uuid AND source IN (${sc.source}, ${login}, ${MFA_SOURCE})`;
      await this.tx.user.update({
        where: { id: userId },
        data: { lastLoginAt: new Date(), failWindowCount: 0, failWindowStart: null },
        select: { id: true },
      });
    } else {
      await this.tx.$executeRaw`
        UPDATE core.auth_lockouts SET failed_count = 0 WHERE user_id = ${userId}::uuid AND source = ${sc.source}`;
    }
  }

  async clearAllLocks(userId: string): Promise<void> {
    await clearAllLocks(this.tx, userId);
  }

  async log(userId: string | null, result: LoginResult, identifierHash: Uint8Array | null): Promise<void> {
    await this.auditWriter.loginLog({
      userId,
      identifierHash,
      result,
      ip: this.cls.get('ip') ?? null,
      device: this.cls.get('deviceId') ?? null,
      userAgent: this.cls.get('userAgent') ?? null,
    });
  }
}
