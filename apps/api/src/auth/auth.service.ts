import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import { randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verifySync } from 'otplib';
import type { VerifyResult as TotpResult } from 'otplib';
import { v7 as uuidv7 } from 'uuid';
import { AuditOutboxService, type Tx } from '../common/audit-outbox.service';
import type { Principal } from '../common/access';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { AuthAttempts, challengeInvalid, otpInvalid } from './auth-attempts';
import { type DeviceProof, refreshBinding } from './device-proof';
import { PosDeviceService } from './pos-device.service';
import { hasLeft, staffAllowedOnStore } from './staff-auth.service';
import { ARGON_PROFILES, dummyHash, hashSecret, MAX_SECRET_LEN, verifySecret, withArgonSlot } from './password';
import { PiiCipher, totpAad } from './pii-cipher';
import {
  AccessTokens,
  ADMIN_ABSOLUTE_S,
  ADMIN_SLIDING_S,
  type Amr,
  MFA_CHALLENGE_MAX_ATTEMPTS,
  MFA_CHALLENGE_TTL_S,
  OPAQUE_TOKEN_RE,
  randomToken,
  sha256,
  STEP_UP_TTL_S,
} from './tokens';

const RECOVERY_CODES = 10;
/** NC-22: mật khẩu tạm chưa đổi — tài khoản chưa kích hoạt quá 72 giờ không đăng nhập được */
export const TEMP_PASSWORD_TTL_S = 72 * 3600;

/** NC-22: mật khẩu tạm chưa đổi (và chưa có 2FA) quá 72 giờ kể từ lúc tạo tài khoản */
export function tempPasswordExpired(u: {
  mustChangePassword: boolean;
  totpEnabledAt: Date | null;
  createdAt: Date;
}): boolean {
  return u.mustChangePassword && !u.totpEnabledAt && u.createdAt.getTime() < Date.now() - TEMP_PASSWORD_TTL_S * 1000;
}
/** mật khẩu mới: 12–256 ký tự (người dùng tự chọn; Argon2id hồ sơ PASSWORD) */
export const PASSWORD_MIN = 12;
const TOTP_ISSUER = 'Fruit Retail';
/** ±1 bước 30 s cho lệch đồng hồ điện thoại */
const TOTP_TOLERANCE_S = 30;

type AdminType = 'MASTER' | 'VIEWER';
const isAdmin = (t: string): t is AdminType => t === 'MASTER' || t === 'VIEWER';

export interface TokenPair {
  access_token: string;
  access_token_expires_at: string;
  refresh_token: string;
  session_id: string;
  amr: Amr[];
}

export type LoginResponse =
  | { status: 'MFA_REQUIRED'; mfa_challenge: string; mfa_challenge_expires_at: string }
  | ({ status: 'ENROLLMENT_REQUIRED'; password_change_required: boolean } & TokenPair);

// /auth/login trả CÙNG một lỗi cho sai email, sai mật khẩu, tài khoản khóa/vô hiệu (không liệt kê được email — S3)
const passwordChangeRequired = () =>
  new AppError('PASSWORD_CHANGE_REQUIRED', 'Đổi mật khẩu tạm trước khi đăng ký xác thực 2 lớp');

const invalidCredentials = () =>
  new AppError('AUTHENTICATION_REQUIRED', 'Email hoặc mật khẩu không đúng, hoặc tài khoản đang tạm khóa');

export const normalizeEmail = (e: string) => e.normalize('NFC').trim().toLowerCase();

/** Mã khôi phục: 16 ký tự base32 (80 bit), hiển thị 4 nhóm `xxxx-xxxx-xxxx-xxxx`; nhập không phân biệt hoa/thường/gạch. */
const RC_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 ký tự, bỏ l/o/0/1 dễ nhầm
export function newRecoveryCode(): string {
  const b = randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += RC_ALPHABET[(b[i] ?? 0) & 31];
  return [0, 4, 8, 12].map((i) => s.slice(i, i + 4)).join('-');
}
export const normalizeRecoveryCode = (c: string) => c.toLowerCase().replace(/[\s-]/g, '');

interface UserAuthRow {
  id: string;
  type: string;
  email: string | null;
  passwordHash: string | null;
  totpSecretEnc: Uint8Array | null;
  totpEnabledAt: Date | null;
  totpLastStep: bigint | null;
  status: string;
  lockedUntil: Date | null;
  mustChangePassword: boolean;
  createdAt: Date;
}
const USER_AUTH_SELECT = {
  id: true,
  type: true,
  email: true,
  passwordHash: true,
  totpSecretEnc: true,
  totpEnabledAt: true,
  totpLastStep: true,
  status: true,
  lockedUntil: true,
  mustChangePassword: true,
  createdAt: true,
} as const;

/**
 * Xác thực Master/Viewer (SEC1, SEC2, SEC4, SEC5 — ADR-012, ADR-021). Các luồng có thể thất bại vì nhập sai
 * (login, 2fa/verify, 2fa/recover, refresh, step-up) chạy `@OwnTransaction`: lần sai được ghi trong transaction riêng
 * rồi mới trả lỗi; phần thành công chạy trong một transaction (phiên + token + nhật ký cùng commit).
 * Mọi lần thử ghi `audit.login_logs` (kết nối audit_writer riêng — còn lại dù nghiệp vụ rollback).
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly cipher: PiiCipher,
    private readonly tokens: AccessTokens,
    private readonly attempts: AuthAttempts,
    private readonly ao: AuditOutboxService,
    private readonly cls: ClsService<RequestStore>,
    private readonly devices: PosDeviceService,
  ) {}

  private get tx() {
    return this.txHost.tx;
  }

  // ───────────────────────────── đăng nhập ─────────────────────────────

  async login(emailRaw: string, password: string): Promise<LoginResponse> {
    const email = normalizeEmail(emailRaw);
    const identifierHash = this.cipher.hmac(`email:${email}`);
    const user = (await this.tx.user.findUnique({ where: { email }, select: USER_AUTH_SELECT })) as UserAuthRow | null;
    if (!user || !isAdmin(user.type) || !user.passwordHash) {
      // cùng thời gian với nhánh sai mật khẩu
      try {
        await withArgonSlot(this.attempts.ipSlot(), async () => void (await verifySecret(await dummyHash(), password)));
      } catch (e) {
        // hết suất: ghi nhật ký như nhánh email có thật (T4)
        if (e instanceof AppError && e.code === 'RATE_LIMITED')
          await this.attempts.log(null, 'RATE_LIMITED', identifierHash);
        throw e;
      }
      await this.attempts.log(null, 'UNKNOWN_USER', identifierHash);
      throw invalidCredentials();
    }
    const hash = user.passwordHash;
    let totpEnabledNow: Date | null = user.totpEnabledAt;
    let mustChangeNow = user.mustChangePassword;
    return this.attempts.run(
      {
        userId: user.id,
        identifierHash,
        argon: true,
        publicError: invalidCredentials,
        failResult: 'BAD_CREDENTIALS',
        dummy: async () => void (await verifySecret(await dummyHash(), password)),
      },
      async () => {
        // G4 (lát 6/8): đọc LẠI mã băm mật khẩu trong transaction đang giữ khóa `auth:<id>` — bản đọc trước khi chờ suất
        // Argon có thể đã cũ (Master vừa reset/khóa); đổi ⇒ coi như sai (cùng thời gian nhờ Argon giả)
        const cur = await this.tx.user.findUnique({
          where: { id: user.id },
          select: { passwordHash: true, totpEnabledAt: true, mustChangePassword: true, createdAt: true },
        });
        // G-a: trạng thái 2FA dùng cho nhánh thành công cũng lấy từ bản đọc dưới khóa
        totpEnabledNow = cur?.totpEnabledAt ?? null;
        mustChangeNow = cur?.mustChangePassword ?? false;
        // NC-22: mật khẩu tạm chưa đổi quá 72 giờ (tài khoản chưa kích hoạt) ⇒ không đăng nhập được (cùng lỗi 401)
        const expired = !!cur && tempPasswordExpired(cur);
        if (!cur?.passwordHash || cur.passwordHash !== hash || expired) {
          await verifySecret(await dummyHash(), password);
          return false;
        }
        return verifySecret(hash, password);
      },
      async () => {
        // mật khẩu đúng KHÔNG xóa bộ đếm sai khi đã bật 2FA: chỉ đăng nhập trọn vẹn mới xóa (chặn dò mã 2FA vô hạn)
        if (totpEnabledNow) {
          const challenge = randomToken();
          const expiresAt = new Date(Date.now() + MFA_CHALLENGE_TTL_S * 1000);
          await this.tx.authChallenge.create({
            data: { id: uuidv7(), kind: 'MFA', userId: user.id, secretHash: sha256(challenge), expiresAt },
            select: { id: true },
          });
          await this.attempts.log(user.id, 'MFA_REQUIRED', identifierHash);
          return {
            status: 'MFA_REQUIRED' as const,
            mfa_challenge: challenge,
            mfa_challenge_expires_at: expiresAt.toISOString(),
          };
        }
        // Chưa đăng ký 2FA (tài khoản mới / vừa reset 2FA): mật khẩu là yếu tố duy nhất ⇒ xóa bộ đếm; phiên chỉ gọi
        // được route đăng ký (AccessGuard)
        await this.attempts.clearFailures(user.id, false);
        const p = await this.createSession(user, ['pwd']);
        await this.attempts.log(user.id, 'ENROLLMENT_REQUIRED', identifierHash);
        return { status: 'ENROLLMENT_REQUIRED' as const, password_change_required: mustChangeNow, ...p };
      },
    );
  }

  async verifyMfa(challenge: string, code: string): Promise<TokenPair> {
    const { ch, user } = await this.loadChallenge(challenge);
    let step: number | undefined;
    return this.attempts.run(
      {
        userId: user.id,
        identifierHash: null,
        challengeId: ch.id,
        argon: false,
        failResult: 'BAD_TOTP',
      },
      async () => {
        // G4: secret 2FA đọc LẠI trong transaction giữ khóa — Master vừa reset 2FA ⇒ challenge cũ không dùng được nữa
        const cur = (await this.tx.user.findUnique({
          where: { id: user.id },
          select: USER_AUTH_SELECT,
        })) as UserAuthRow | null;
        if (!cur?.totpEnabledAt || !cur.totpSecretEnc) return false;
        step = totpStep(this.totpSecret(cur), code, cur.totpLastStep);
        return step !== undefined;
      },
      async () => {
        await this.consumeChallenge(ch.id);
        await this.useTotpStep(user.id, step ?? -1);
        await this.attempts.clearFailures(user.id, true);
        const pair = await this.createSession(user, ['pwd', 'otp']);
        await this.maybeNewDevice(user.id, pair.session_id);
        await this.attempts.log(user.id, 'SUCCESS', null); // bước cuối trước commit (ghi lỗi ⇒ không ra phiên)
        return pair;
      },
    );
  }

  async recover(challenge: string, codeRaw: string): Promise<TokenPair & { recovery_codes_remaining: number }> {
    const { ch, user } = await this.loadChallenge(challenge);
    const code = normalizeRecoveryCode(codeRaw);
    let matched: string | undefined;
    let remaining = 0;
    return this.attempts.run(
      {
        userId: user.id,
        identifierHash: null,
        challengeId: ch.id,
        argon: true,
        failResult: 'BAD_RECOVERY',
      },
      async () => {
        const codes = await this.tx.recoveryCode.findMany({
          where: { userId: user.id, usedAt: null },
          select: { id: true, codeHash: true },
        });
        remaining = codes.length - 1;
        // kiểm hết danh sách (không dừng sớm) — thời gian không lộ vị trí mã
        for (const c of codes) if ((await verifySecret(c.codeHash, code)) && !matched) matched = c.id;
        return matched !== undefined;
      },
      () => this.finishRecover(user, ch.id, matched ?? '', remaining),
    );
  }

  private async finishRecover(
    user: UserAuthRow,
    challengeId: string,
    id: string,
    remaining: number,
  ): Promise<TokenPair & { recovery_codes_remaining: number }> {
    await this.consumeChallenge(challengeId);
    const used = await this.tx.recoveryCode.updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date() } });
    if (used.count !== 1) throw otpInvalid(); // dùng song song cùng một mã
    await this.attempts.clearFailures(user.id, true);
    const pair = await this.createSession(user, ['pwd', 'rcv']);
    await this.ao.recordAudit({
      action: 'auth.recovery_code_use',
      resourceType: 'user',
      resourceId: user.id,
      actor: { userId: user.id, userType: user.type as AdminType },
    });
    await this.maybeNewDevice(user.id, pair.session_id);
    await this.attempts.log(user.id, 'SUCCESS_RECOVERY', null);
    return { ...pair, recovery_codes_remaining: remaining };
  }

  // ───────────────────────────── refresh / phiên ─────────────────────────────

  async refresh(refreshToken: string, proof?: DeviceProof): Promise<TokenPair> {
    if (!OPAQUE_TOKEN_RE.test(refreshToken))
      throw new AppError('AUTHENTICATION_REQUIRED', 'Refresh token không hợp lệ');
    const rt = await this.tx.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      select: {
        id: true,
        usedAt: true,
        session: {
          select: {
            id: true,
            userId: true,
            userType: true,
            amr: true,
            createdAt: true,
            expiresAt: true,
            revokedAt: true,
            posDeviceId: true,
            user: { select: { status: true, mustChangePassword: true, totpEnabledAt: true, createdAt: true } },
          },
        },
      },
    });
    if (!rt) throw new AppError('AUTHENTICATION_REQUIRED', 'Refresh token không hợp lệ');
    const s = rt.session;
    const staff = s.userType === 'STAFF';
    const customer = s.userType === 'CUSTOMER';
    if (!isAdmin(s.userType) && !staff && !customer)
      throw new AppError('AUTHENTICATION_REQUIRED', 'Refresh token không hợp lệ');
    if (staff) {
      // SEC3: refresh của nhân viên bắt buộc chữ ký đúng thiết bị của phiên — kiểm TRƯỚC phát hiện dùng lại: token bị lộ
      // mà không có khóa thiết bị thì vô dụng, và không đủ để kẻ gian thu hồi phiên của thu ngân
      if (!proof || !s.posDeviceId)
        throw new AppError('AUTHENTICATION_REQUIRED', 'Thiếu chữ ký thiết bị (device_proof)');
      if (this.cls.get('deviceId')?.toLowerCase() !== s.posDeviceId)
        throw new AppError('AUTHENTICATION_REQUIRED', 'Refresh token không thuộc thiết bị này');
      const dev = await this.devices.verifyProof('refresh', refreshBinding(refreshToken), proof);
      // L2: nghỉ việc / mất vai trò ở cửa hàng của thiết bị ⇒ không gia hạn token (phiên hết hiệu lực theo access 15 phút)
      const st = await this.tx.staff.findUnique({ where: { userId: s.userId }, select: { leftAt: true } });
      if (!st || hasLeft(st.leftAt) || !(await staffAllowedOnStore(this.tx, s.userId, dev.storeId)))
        throw new AppError('SESSION_REVOKED', 'Nhân viên không còn được làm việc trên thiết bị này — đăng nhập lại');
    }
    if (rt.usedAt) {
      await this.revokeForReuse(s.id, s.userId, s.userType);
      throw new AppError('SESSION_REVOKED', 'Phiên đã bị thu hồi — đăng nhập lại');
    }
    const now = new Date();
    if (s.revokedAt || s.expiresAt <= now || s.user.status !== 'ACTIVE' || tempPasswordExpired(s.user))
      throw new AppError('SESSION_REVOKED', 'Phiên đã hết hạn hoặc bị thu hồi — đăng nhập lại');
    const next = randomToken();
    let reused = false;
    try {
      return await this.txHost.withTransaction(async () => {
        // nhân viên (24 giờ) và khách (60 ngày): hạn tuyệt đối, không gia hạn; admin: 12 giờ trượt, trần 7 ngày
        const expiresAt = staff || customer ? s.expiresAt : slidingExpiry(s.createdAt, now);
        if (expiresAt <= now) throw new AppError('SESSION_REVOKED', 'Phiên đã hết hạn — đăng nhập lại');
        // khóa dòng phiên TRƯỚC (thu hồi song song phải chờ, hoặc ta thấy phiên đã thu hồi ⇒ 401, không phải lỗi trigger)
        const live = await this.tx.session.updateMany({
          where: { id: s.id, revokedAt: null, expiresAt: { gt: now } },
          data: { lastUsedAt: now, expiresAt },
        });
        if (live.count !== 1) throw new AppError('SESSION_REVOKED', 'Phiên đã hết hạn hoặc bị thu hồi — đăng nhập lại');
        const created = await this.tx.refreshToken.create({
          data: { id: uuidv7(), sessionId: s.id, tokenHash: sha256(next) },
          select: { id: true },
        });
        // xoay có điều kiện: token đã bị dùng song song ⇒ 0 dòng ⇒ coi như dùng lại
        const rotated = await this.tx.refreshToken.updateMany({
          where: { id: rt.id, usedAt: null },
          data: { usedAt: now, replacedById: created.id },
        });
        if (rotated.count !== 1) {
          reused = true;
          throw new AppError('SESSION_REVOKED', 'Phiên đã bị thu hồi — đăng nhập lại');
        }
        const access = await this.tokens.sign({
          sub: s.userId,
          typ: staff ? 'staff' : customer ? 'customer' : tokenTyp(s.userType),
          sid: s.id,
          amr: s.amr as Amr[],
          ...(staff && s.posDeviceId ? { dev: s.posDeviceId } : {}),
        });
        return {
          access_token: access.token,
          access_token_expires_at: access.expiresAt.toISOString(),
          refresh_token: next,
          session_id: s.id,
          amr: s.amr as Amr[],
        };
      });
    } catch (e) {
      if (reused) await this.revokeForReuse(s.id, s.userId, s.userType);
      throw e;
    }
  }

  /**
   * NC-22: đổi mật khẩu (Master/Viewer). Mật khẩu hiện tại sai ⇒ tính một lần sai (khóa SEC5 dùng chung); mật khẩu mới
   * băm TRƯỚC khi mở transaction. Thành công ⇒ bỏ cờ mật khẩu tạm, thu hồi mọi phiên KHÁC (phiên hiện tại giữ lại).
   * @OwnTransaction ở controller.
   */
  async changePassword(p: Principal, current: string, next: string): Promise<{ revoked_sessions: number }> {
    if (p.userType !== 'MASTER' && p.userType !== 'VIEWER')
      throw new AppError('ACTION_FORBIDDEN', 'Chỉ tài khoản Master/Viewer đổi mật khẩu ở đây');
    if (next.length < PASSWORD_MIN || next.length > MAX_SECRET_LEN)
      throw new AppError('INVALID_REQUEST', `Mật khẩu mới ${PASSWORD_MIN}–${MAX_SECRET_LEN} ký tự`, {
        field: 'new_password',
      });
    if (next === current)
      throw new AppError('INVALID_REQUEST', 'Mật khẩu mới phải khác mật khẩu hiện tại', { field: 'new_password' });
    const me = await this.tx.user.findUnique({ where: { id: p.userId }, select: { email: true, passwordHash: true } });
    if (!me?.passwordHash) throw new AppError('ACTION_FORBIDDEN', 'Tài khoản không đăng nhập bằng mật khẩu');
    const local = (me.email ?? '').split('@')[0]?.toLowerCase() ?? '';
    if (local.length >= 4 && next.toLowerCase().includes(local))
      throw new AppError('INVALID_REQUEST', 'Mật khẩu mới không được chứa tên email', { field: 'new_password' });
    const newHash = await withArgonSlot(`user:${p.userId}`, () => hashSecret(next, ARGON_PROFILES.PASSWORD));
    let hashChecked = '';
    return this.attempts.run(
      {
        userId: p.userId,
        identifierHash: null,
        argon: true,
        failResult: 'BAD_CREDENTIALS',
        slot: `user:${p.userId}`,
        failError: () =>
          new AppError('CURRENT_PASSWORD_INVALID', 'Mật khẩu hiện tại không đúng', { field: 'current_password' }),
      },
      async () => {
        // đọc lại dưới khóa `auth:<id>` (Master vừa reset/khóa…)
        const cur = await this.tx.user.findUnique({
          where: { id: p.userId },
          select: { passwordHash: true, mustChangePassword: true, totpEnabledAt: true, createdAt: true },
        });
        if (!cur?.passwordHash) return false;
        // L1 (review NC-22): phiên lấy bằng mật khẩu tạm không kéo dài được hạn kích hoạt 72 giờ
        if (tempPasswordExpired(cur))
          throw new AppError('ACTION_FORBIDDEN', 'Mật khẩu tạm đã hết hạn 72 giờ — nhờ Master cấp lại tài khoản');
        hashChecked = cur.passwordHash;
        return verifySecret(cur.passwordHash, current);
      },
      async () => {
        const w = await this.tx.user.updateMany({
          where: { id: p.userId, passwordHash: hashChecked },
          data: { passwordHash: newHash, mustChangePassword: false, failedLoginCount: 0 },
        });
        if (w.count !== 1) throw new AppError('INVALID_STATE_TRANSITION', 'Mật khẩu vừa được đổi ở nơi khác — thử lại');
        // L2 (review NC-22): challenge MFA phát bằng mật khẩu cũ không còn dùng được
        await this.tx.authChallenge.updateMany({
          where: { userId: p.userId, kind: 'MFA', usedAt: null },
          data: { usedAt: new Date() },
        });
        await this.tx.$queryRaw`
          SELECT id FROM core.sessions WHERE user_id = ${p.userId}::uuid AND revoked_at IS NULL ORDER BY id FOR UPDATE`;
        const r = await this.tx.session.updateMany({
          where: { userId: p.userId, revokedAt: null, id: { not: p.sessionId } },
          data: { revokedAt: new Date(), revokeReason: 'PASSWORD_CHANGED' },
        });
        await this.ao.recordAudit({
          action: 'auth.password_change',
          resourceType: 'user',
          resourceId: p.userId,
          after: { revoked_sessions: r.count },
        });
        return { revoked_sessions: r.count };
      },
    );
  }

  async logout(p: Principal): Promise<void> {
    await this.tx.session.updateMany({
      where: { id: p.sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'LOGOUT' },
    });
    await this.ao.recordAudit({ action: 'auth.logout', resourceType: 'session', resourceId: p.sessionId });
  }

  async listSessions(p: Principal) {
    const rows = await this.tx.session.findMany({
      where: { userId: p.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        clientDevice: true,
        userAgent: true,
        amr: true,
      },
      orderBy: { lastUsedAt: 'desc' },
      take: 100,
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        created_at: r.createdAt.toISOString(),
        last_used_at: r.lastUsedAt.toISOString(),
        expires_at: r.expiresAt.toISOString(),
        client_device: r.clientDevice,
        user_agent: r.userAgent,
        amr: r.amr,
        current: r.id === p.sessionId,
      })),
    };
  }

  /** Chỉ phiên của chính mình; phiên người khác/không có ⇒ 404 (không lộ tồn tại). */
  async revokeOwnSession(p: Principal, id: string): Promise<void> {
    const r = await this.tx.session.updateMany({
      where: { id, userId: p.userId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'USER_REVOKED' },
    });
    if (r.count !== 1) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy phiên');
    await this.ao.recordAudit({ action: 'auth.session_revoke', resourceType: 'session', resourceId: id });
  }

  // ───────────────────────────── 2FA: đăng ký, mã khôi phục, step-up ─────────────────────────────

  async setupTotp(p: Principal): Promise<{ secret: string; otpauth_uri: string; issuer: string }> {
    const u = await this.adminUser(p, true);
    if (u.mustChangePassword) throw passwordChangeRequired();
    if (u.totpEnabledAt)
      throw new AppError('INVALID_STATE_TRANSITION', '2FA đã bật — cần Master reset trước khi đăng ký lại');
    const secret = generateSecret(); // 20 byte, base32
    // có điều kiện: 2FA vừa được bật song song ⇒ không ghi đè secret (S2)
    const w = await this.tx.user.updateMany({
      where: { id: u.id, totpEnabledAt: null },
      data: { totpSecretEnc: this.cipher.encrypt(secret, totpAad(u.id)) },
    });
    if (w.count !== 1) throw new AppError('INVALID_STATE_TRANSITION', '2FA đã bật');
    await this.ao.recordAudit({ action: 'auth.totp_setup', resourceType: 'user', resourceId: u.id });
    return {
      secret,
      otpauth_uri: generateURI({ secret, label: u.email ?? u.id, issuer: TOTP_ISSUER }),
      issuer: TOTP_ISSUER,
    };
  }

  async confirmTotp(
    p: Principal,
    code: string,
  ): Promise<{ recovery_codes: string[] } & Omit<TokenPair, 'refresh_token'>> {
    // @OwnTransaction (T2/T3): (1) kiểm mã TOTP trước — rẻ, chưa giữ gì; sai ⇒ 401 không tốn Argon2;
    // (2) băm mã khôi phục khi CHƯA mở transaction (không giữ kết nối/khóa trong lúc chờ suất Argon2);
    // (3) transaction: khóa dòng user, đọc lại, secret phải là secret đã kiểm ở (1) (setup chen vào ⇒ 409).
    const pre = await this.adminUser(p);
    if (pre.totpEnabledAt || !pre.totpSecretEnc)
      throw new AppError('INVALID_STATE_TRANSITION', 'Chưa bắt đầu đăng ký 2FA hoặc 2FA đã bật');
    const step = totpStep(this.totpSecret(pre, true), code, null);
    if (step === undefined) throw otpInvalid();
    const checkedSecret = Buffer.from(pre.totpSecretEnc);
    const fresh = await this.newRecoveryCodes();
    return this.txHost.withTransaction(() => this.enableTotp(p, step, checkedSecret, fresh));
  }

  private async enableTotp(
    p: Principal,
    step: number,
    checkedSecret: Buffer,
    fresh: { codes: string[]; hashes: string[] },
  ): Promise<{ recovery_codes: string[] } & Omit<TokenPair, 'refresh_token'>> {
    // khóa dòng user đến hết transaction: setup song song phải chờ, rồi thấy 2FA đã bật (S2)
    const u = await this.adminUser(p, true);
    if (u.mustChangePassword) throw passwordChangeRequired();
    if (u.totpEnabledAt || !u.totpSecretEnc || !checkedSecret.equals(Buffer.from(u.totpSecretEnc)))
      throw new AppError('INVALID_STATE_TRANSITION', 'Đăng ký 2FA vừa thay đổi — quét lại mã QR mới nhất');
    const enabled = await this.tx.user.updateMany({
      where: { id: u.id, totpEnabledAt: null },
      data: { totpEnabledAt: new Date(), totpLastStep: BigInt(step) },
    });
    if (enabled.count !== 1) throw new AppError('INVALID_STATE_TRANSITION', '2FA đã bật');
    const codes = await this.replaceRecoveryCodes(u.id, fresh);
    const amr: Amr[] = ['pwd', 'otp'];
    const live = await this.tx.session.updateMany({ where: { id: p.sessionId, revokedAt: null }, data: { amr } });
    if (live.count !== 1) throw new AppError('SESSION_REVOKED', 'Phiên đã bị thu hồi — đăng nhập lại');
    // phiên chỉ-mật-khẩu KHÁC của user (vd của kẻ biết mật khẩu) không được sống tiếp tới lần reset 2FA sau
    const others = await this.tx.session.updateMany({
      where: { userId: u.id, id: { not: p.sessionId }, revokedAt: null, NOT: { amr: { hasSome: ['otp', 'rcv'] } } },
      data: { revokedAt: new Date(), revokeReason: 'TOTP_ENABLED' },
    });
    await this.ao.recordAudit({
      action: 'auth.totp_enable',
      resourceType: 'user',
      resourceId: u.id,
      after: { revoked_password_only_sessions: others.count },
    });
    // lần đầu phiên qua 2FA trên thiết bị này (kích hoạt tài khoản) — Master được báo như đăng nhập thiết bị mới
    await this.maybeNewDevice(u.id, p.sessionId);
    const access = await this.tokens.sign({ sub: u.id, typ: tokenTyp(u.type), sid: p.sessionId, amr });
    return {
      recovery_codes: codes,
      access_token: access.token,
      access_token_expires_at: access.expiresAt.toISOString(),
      session_id: p.sessionId,
      amr,
    };
  }

  async regenerateRecoveryCodes(p: Principal): Promise<{ recovery_codes: string[] }> {
    // @OwnTransaction (T2): băm trước, transaction sau — không giữ kết nối khi chờ suất Argon2
    const pre = await this.adminUser(p);
    if (!pre.totpEnabledAt) throw new AppError('INVALID_STATE_TRANSITION', 'Chưa bật 2FA');
    const fresh = await this.newRecoveryCodes();
    return this.txHost.withTransaction(async () => {
      // khóa dòng user: hai lần sinh lại song song chạy tuần tự ⇒ chỉ còn đúng 1 bộ 10 mã (kiểm thử lát 3 T6)
      const u = await this.adminUser(p, true);
      if (!u.totpEnabledAt) throw new AppError('INVALID_STATE_TRANSITION', 'Chưa bật 2FA');
      const codes = await this.replaceRecoveryCodes(u.id, fresh);
      await this.ao.recordAudit({ action: 'auth.recovery_codes_regenerate', resourceType: 'user', resourceId: u.id });
      return { recovery_codes: codes };
    });
  }

  async stepUp(
    p: Principal,
    code: string,
  ): Promise<{ step_up_until: string; access_token: string; access_token_expires_at: string }> {
    const u = await this.adminUser(p);
    if (!u.totpEnabledAt) throw new AppError('INVALID_STATE_TRANSITION', 'Chưa bật 2FA');
    let step: number | undefined;
    return this.attempts.run(
      { userId: u.id, identifierHash: null, argon: false, failResult: 'STEP_UP_FAILED' },
      () => {
        step = totpStep(this.totpSecret(u), code, u.totpLastStep);
        return Promise.resolve(step !== undefined);
      },
      async () => {
        await this.useTotpStep(u.id, step ?? -1);
        await this.attempts.clearFailures(u.id, false);
        const until = new Date(Date.now() + STEP_UP_TTL_S * 1000);
        // phiên phải còn hiệu lực (thu hồi song song ⇒ 0 dòng)
        const s = await this.tx.session.updateMany({
          where: { id: p.sessionId, revokedAt: null },
          data: { stepUpUntil: until },
        });
        if (s.count !== 1) throw new AppError('SESSION_REVOKED', 'Phiên đã bị thu hồi — đăng nhập lại');
        await this.ao.recordAudit({ action: 'auth.step_up', resourceType: 'session', resourceId: p.sessionId });
        const access = await this.tokens.sign({
          sub: u.id,
          typ: tokenTyp(u.type),
          sid: p.sessionId,
          amr: [...p.amr] as Amr[],
          step_up_until: Math.floor(until.getTime() / 1000),
        });
        return {
          step_up_until: until.toISOString(),
          access_token: access.token,
          access_token_expires_at: access.expiresAt.toISOString(),
        };
      },
    );
  }

  // ───────────────────────────── nội bộ ─────────────────────────────

  private async adminUser(p: Principal, lockRow = false): Promise<UserAuthRow> {
    if (!isAdmin(p.userType)) throw new AppError('ACTION_FORBIDDEN', '2FA chỉ dành cho tài khoản Master/Viewer');
    if (lockRow) await this.tx.$queryRaw`SELECT id FROM core.users WHERE id = ${p.userId}::uuid FOR UPDATE`;
    const u = (await this.tx.user.findUnique({
      where: { id: p.userId },
      select: USER_AUTH_SELECT,
    })) as UserAuthRow | null;
    if (!u) throw new AppError('AUTHENTICATION_REQUIRED', 'Cần đăng nhập');
    return u;
  }

  private totpSecret(u: UserAuthRow, pending = false): string {
    if (!u.totpSecretEnc || (!pending && !u.totpEnabledAt)) throw challengeInvalid();
    return this.cipher.decrypt(u.totpSecretEnc, totpAad(u.id)).toString('utf8');
  }

  private async loadChallenge(challenge: string) {
    if (!OPAQUE_TOKEN_RE.test(challenge)) throw challengeInvalid();
    const ch = await this.tx.authChallenge.findUnique({
      where: { secretHash: sha256(challenge) },
      select: { id: true, kind: true, userId: true, attempts: true, expiresAt: true, usedAt: true },
    });
    if (
      !ch ||
      ch.kind !== 'MFA' ||
      !ch.userId ||
      ch.usedAt ||
      ch.expiresAt.getTime() <= Date.now() ||
      ch.attempts >= MFA_CHALLENGE_MAX_ATTEMPTS
    ) {
      await this.attempts.log(ch?.userId ?? null, 'CHALLENGE_INVALID', null);
      throw challengeInvalid();
    }
    const user = (await this.tx.user.findUnique({
      where: { id: ch.userId },
      select: USER_AUTH_SELECT,
    })) as UserAuthRow | null;
    if (!user || !isAdmin(user.type) || !user.totpEnabledAt) {
      await this.attempts.log(ch.userId, 'CHALLENGE_INVALID', null);
      throw challengeInvalid();
    }
    return { ch, user };
  }

  private async consumeChallenge(id: string): Promise<void> {
    const r = await this.tx.authChallenge.updateMany({
      // lượt hiện tại đã được tính (attempts + 1) trong cùng transaction ⇒ ≤ 5
      where: { id, usedAt: null, attempts: { lte: MFA_CHALLENGE_MAX_ATTEMPTS }, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (r.count !== 1) throw challengeInvalid(); // dùng song song / vừa hết hạn
  }

  /** Bước TOTP chỉ tăng — hai request cùng một mã: chỉ một cái qua. */
  private async useTotpStep(userId: string, step: number): Promise<void> {
    const r = await this.tx.user.updateMany({
      where: { id: userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: BigInt(step) } }] },
      data: { totpLastStep: BigInt(step) },
    });
    if (r.count !== 1) throw otpInvalid();
  }

  private async createSession(u: UserAuthRow, amr: Amr[]): Promise<TokenPair> {
    const now = new Date();
    const id = uuidv7();
    const ip = this.cls.get('ip');
    await this.tx.session.create({
      data: {
        id,
        userId: u.id,
        userType: u.type as AdminType,
        clientDevice: this.cls.get('deviceId') ?? null,
        amr,
        expiresAt: new Date(now.getTime() + ADMIN_SLIDING_S * 1000),
        ipHash: ip ? this.cipher.hmac(`ip:${ip}`) : null,
        userAgent: this.cls.get('userAgent')?.slice(0, 512) ?? null,
      },
      select: { id: true },
    });
    const refresh = randomToken();
    await this.tx.refreshToken.create({
      data: { id: uuidv7(), sessionId: id, tokenHash: sha256(refresh) },
      select: { id: true },
    });
    const access = await this.tokens.sign({ sub: u.id, typ: tokenTyp(u.type), sid: id, amr }, now);
    return {
      access_token: access.token,
      access_token_expires_at: access.expiresAt.toISOString(),
      refresh_token: refresh,
      session_id: id,
      amr,
    };
  }

  /** SEC5: thiết bị (X-Device-Id) chưa từng có phiên đã qua 2FA ⇒ sự kiện cho Master. */
  private async maybeNewDevice(userId: string, sessionId: string): Promise<void> {
    const device = this.cls.get('deviceId');
    const seen = device
      ? await this.tx.session.count({
          where: { userId, clientDevice: device, id: { not: sessionId }, amr: { hasSome: ['otp', 'rcv'] } },
        })
      : 0;
    if (seen > 0) return;
    await this.ao.emitEvent({
      eventType: 'auth.new_device_login',
      schemaVersion: 1,
      aggregateType: 'user',
      aggregateId: userId,
      payload: { user_id: userId, session_id: sessionId, at: new Date().toISOString() },
    });
  }

  private async revokeForReuse(sessionId: string, userId: string, userType: string): Promise<void> {
    await this.txHost.withTransaction(async () => {
      const r = await this.tx.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'REFRESH_REUSE' },
      });
      if (r.count === 1)
        await this.ao.recordAudit({
          action: 'auth.refresh_reuse',
          resourceType: 'session',
          resourceId: sessionId,
          actor: { userId, userType: userType as AdminType | 'STAFF' | 'CUSTOMER' },
          reason: 'refresh token đã xoay bị dùng lại — thu hồi cả họ',
        });
      await this.attempts.log(userId, 'REFRESH_REUSE', null);
    });
  }

  /** 10 mã mới + hash (một suất Argon2, băm tuần tự) — gọi khi CHƯA giữ khóa dòng nào */
  private async newRecoveryCodes(): Promise<{ codes: string[]; hashes: string[] }> {
    const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
    const hashes = await withArgonSlot(this.attempts.ipSlot(), async () => {
      const out: string[] = [];
      for (const c of codes) out.push(await hashSecret(normalizeRecoveryCode(c), ARGON_PROFILES.CODE));
      return out;
    });
    return { codes, hashes };
  }

  private async replaceRecoveryCodes(userId: string, fresh: { codes: string[]; hashes: string[] }): Promise<string[]> {
    await this.tx.recoveryCode.deleteMany({ where: { userId } });
    await this.tx.recoveryCode.createMany({
      data: fresh.hashes.map((codeHash) => ({ id: uuidv7(), userId, codeHash })),
    });
    return fresh.codes;
  }
}

/** Mã TOTP đúng (±1 bước) và MỚI hơn bước đã dùng ⇒ trả bước thời gian; sai ⇒ undefined. */
function totpStep(secret: string, code: string, lastStep: bigint | null): number | undefined {
  const r = verifySync({
    secret,
    token: code,
    epochTolerance: TOTP_TOLERANCE_S,
    ...(lastStep !== null ? { afterTimeStep: Number(lastStep) } : {}),
  }) as TotpResult;
  return r.valid ? r.timeStep : undefined;
}

function tokenTyp(t: string): 'master' | 'viewer' {
  return t === 'MASTER' ? 'master' : 'viewer';
}

/** 12 giờ trượt, không vượt trần 7 ngày kể từ lúc đăng nhập */
export function slidingExpiry(createdAt: Date, now: Date): Date {
  return new Date(Math.min(now.getTime() + ADMIN_SLIDING_S * 1000, createdAt.getTime() + ADMIN_ABSOLUTE_S * 1000));
}
