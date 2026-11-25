import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import type { Tx } from '../common/audit-outbox.service';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { AuditWriterService, type LoginResult } from '../infra/audit-writer.service';
import { withArgonSlot } from './password';
import { MFA_CHALLENGE_MAX_ATTEMPTS } from './tokens';

/** SEC5: 5 lần sai liên tiếp ⇒ khóa 15 phút, mỗi lần khóa sau gấp đôi, trần 24 giờ (ADR-012, ADR-021) */
export const MAX_FAILED = 5;
const LOCK_BASE_MIN = 15;
const LOCK_MAX_MIN = 24 * 60;

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
  failResult: LoginResult;
  /** cân thời gian nhánh bị từ chối của luồng công khai */
  dummy?: () => Promise<void>;
  /** khóa giới hạn suất Argon2; mặc định theo IP */
  slot?: string;
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
    type Out =
      | { kind: 'ok'; value: T }
      | { kind: 'busy' | 'challenge' | 'fail' }
      | { kind: 'locked'; status: string; until: Date | null };
    const run = (): Promise<Out> =>
      this.txHost.withTransaction(async (): Promise<Out> => {
        const [lk] = await this.tx.$queryRaw<{ ok: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtextextended('auth:' || ${g.userId}, 0)) AS ok`;
        if (!lk?.ok) {
          // luồng công khai: nhánh bận phải giống hệt sai mật khẩu (thời gian + mã lỗi) — không lộ tài khoản có thật (T1)
          if (g.dummy) await g.dummy();
          return { kind: 'busy' };
        }
        const [st] = await this.tx.$queryRaw<{ status: string; locked_until: Date | null; locked: boolean }[]>`
          SELECT status::text AS status, locked_until, (locked_until IS NOT NULL AND locked_until > now()) AS locked
          FROM core.users WHERE id = ${g.userId}::uuid`;
        if (!st || st.status !== 'ACTIVE' || st.locked) {
          if (g.dummy) await g.dummy();
          return { kind: 'locked', status: st?.status ?? 'DISABLED', until: st?.locked ? st.locked_until : null };
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
          await this.tx.$executeRaw`
            UPDATE core.users SET
              lock_count = CASE WHEN failed_login_count + 1 >= ${MAX_FAILED} THEN lock_count + 1 ELSE lock_count END,
              locked_until = CASE WHEN failed_login_count + 1 >= ${MAX_FAILED}
                THEN now() + make_interval(mins => LEAST(${LOCK_BASE_MIN} * (2 ^ LEAST(lock_count, 7))::int, ${LOCK_MAX_MIN}))
                ELSE locked_until END,
              failed_login_count = CASE WHEN failed_login_count + 1 >= ${MAX_FAILED} THEN 0 ELSE failed_login_count + 1 END
            WHERE id = ${g.userId}::uuid`;
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
      case 'fail':
        await this.log(g.userId, g.failResult, g.identifierHash);
        throw g.publicError ? g.publicError() : otpInvalid();
    }
  }

  /** Khóa giới hạn suất Argon2 theo nguồn (IP đã qua trust proxy) */
  ipSlot(): string {
    return `ip:${this.cls.get('ip') ?? '?'}`;
  }

  lockedError(until?: Date | null): AppError {
    return new AppError(
      'ACCOUNT_LOCKED',
      'Tài khoản đang bị khóa',
      until ? { retry_after_s: Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000)) } : undefined,
    );
  }

  /** Lần thử đúng (trong transaction của `run`, đã giữ khóa tài khoản): full = đăng nhập trọn vẹn, xóa cả mức khóa. */
  async clearFailures(userId: string, full: boolean): Promise<void> {
    await this.tx.user.update({
      where: { id: userId },
      data: { failedLoginCount: 0, ...(full ? { lockCount: 0, lockedUntil: null, lastLoginAt: new Date() } : {}) },
      select: { id: true },
    });
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
