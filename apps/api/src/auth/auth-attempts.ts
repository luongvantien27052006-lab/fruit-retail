import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import type { Tx } from '../common/audit-outbox.service';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { AuditWriterService, type LoginResult } from '../infra/audit-writer.service';
import { ipBucket } from '../infra/rate-limiter.service';
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
 * Master mở khóa / đặt lại PIN: xóa mọi khóa tạm của tài khoản (theo nguồn + toàn tài khoản). Người gọi đã giữ khóa
 * `auth:<id>` trong transaction.
 */
export async function clearAllLocks(
  tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<number> },
  userId: string,
): Promise<void> {
  await tx.$executeRaw`DELETE FROM core.auth_lockouts WHERE user_id = ${userId}::uuid`;
  await tx.$executeRaw`
    UPDATE core.users SET locked_until = NULL, lock_count = 0, failed_login_count = 0 WHERE id = ${userId}::uuid`;
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

/** phạm vi đếm sai: theo nguồn (luồng đăng nhập) hoặc theo phiên (xác thực lại khi đã đăng nhập) */
export type AttemptScope = { source: string } | { sessionId: string };

/** nguồn IP: bucket (IPv4 / IPv6 /64) băm — không lưu IP thô vào bảng khóa */
export const ipSource = (ip: string | undefined) =>
  `ip:${createHash('sha256').update(ipBucket(ip), 'utf8').digest('base64url').slice(0, 22)}`;
export const deviceSource = (deviceId: string) => `dev:${deviceId.toLowerCase()}`;

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
        // trạng thái LOCKED/DISABLED chặn mọi luồng; khóa TẠM toàn tài khoản chỉ chặn luồng đăng nhập (không chặn phiên)
        const tempLocked = 'source' in scope && !!st?.locked;
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
              failed_count = CASE WHEN l.updated_at < now() - interval '24 hours' THEN 0 ELSE l.failed_count END,
              lock_count = CASE WHEN l.updated_at < now() - interval '24 hours' THEN 0 ELSE l.lock_count END
            RETURNING failed_count AS failed, lock_count AS locks`;
          const failed = (lo?.failed ?? 0) + 1;
          const locks = lo?.locks ?? 0;
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
      await this.tx
        .$executeRaw`DELETE FROM core.auth_lockouts WHERE user_id = ${userId}::uuid AND source = ${sc.source}`;
      await this.tx.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() }, select: { id: true } });
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
