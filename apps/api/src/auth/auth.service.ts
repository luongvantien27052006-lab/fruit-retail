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
import { AuditWriterService, type LoginResult } from '../infra/audit-writer.service';
import { ARGON_PROFILES, dummyHash, hashSecret, verifySecret } from './password';
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

/** SEC5: 5 lần sai liên tiếp ⇒ khóa 15 phút, mỗi lần khóa sau gấp đôi, trần 24 giờ (ADR-012, ADR-021) */
export const MAX_FAILED = 5;
const LOCK_BASE_MIN = 15;
const LOCK_MAX_MIN = 24 * 60;
const RECOVERY_CODES = 10;
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
  | ({ status: 'ENROLLMENT_REQUIRED' } & TokenPair);

const invalidCredentials = () => new AppError('AUTHENTICATION_REQUIRED', 'Email hoặc mật khẩu không đúng');
const challengeInvalid = () =>
  new AppError('MFA_CHALLENGE_INVALID', 'Phiên xác minh 2FA không hợp lệ hoặc đã hết hạn — đăng nhập lại');
const otpInvalid = () => new AppError('OTP_INVALID', 'Mã xác minh không đúng');

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
    private readonly auditWriter: AuditWriterService,
    private readonly ao: AuditOutboxService,
    private readonly cls: ClsService<RequestStore>,
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
      await verifySecret(await dummyHash(), password); // cùng thời gian với nhánh sai mật khẩu
      await this.loginLog(null, 'UNKNOWN_USER', identifierHash);
      throw invalidCredentials();
    }
    // kiểm khóa TRƯỚC mật khẩu: đang khóa thì không cho dò tiếp (và không thành "máy báo mật khẩu đúng")
    await this.assertCanAuthenticate(user, identifierHash, password);
    if (!(await verifySecret(user.passwordHash, password))) {
      await this.recordFailure(user.id, 'BAD_CREDENTIALS', identifierHash);
      throw invalidCredentials();
    }
    // mật khẩu đúng KHÔNG xóa bộ đếm sai: chỉ đăng nhập trọn vẹn (qua 2FA) mới xóa — chặn dò mã 2FA không giới hạn
    if (user.totpEnabledAt) {
      const challenge = randomToken();
      const expiresAt = new Date(Date.now() + MFA_CHALLENGE_TTL_S * 1000);
      await this.txHost.withTransaction(async () => {
        await this.tx.authChallenge.create({
          data: { id: uuidv7(), kind: 'MFA', userId: user.id, secretHash: sha256(challenge), expiresAt },
          select: { id: true },
        });
        await this.loginLog(user.id, 'MFA_REQUIRED', identifierHash);
      });
      return { status: 'MFA_REQUIRED', mfa_challenge: challenge, mfa_challenge_expires_at: expiresAt.toISOString() };
    }
    // Chưa đăng ký 2FA (tài khoản mới tạo / vừa reset 2FA): phiên chỉ gọi được route đăng ký (AccessGuard)
    const pair = await this.txHost.withTransaction(async () => {
      await this.resetFailures(user.id, false);
      const p = await this.createSession(user, ['pwd']);
      await this.loginLog(user.id, 'ENROLLMENT_REQUIRED', identifierHash);
      return p;
    });
    return { status: 'ENROLLMENT_REQUIRED', ...pair };
  }

  async verifyMfa(challenge: string, code: string): Promise<TokenPair> {
    const { ch, user } = await this.loadChallenge(challenge);
    const secret = this.totpSecret(user);
    const step = totpStep(secret, code, user.totpLastStep);
    if (step === undefined) {
      await this.recordFailure(user.id, 'BAD_TOTP', null, ch.id);
      throw otpInvalid();
    }
    return this.txHost.withTransaction(async () => {
      await this.consumeChallenge(ch.id);
      await this.useTotpStep(user.id, step);
      await this.resetFailures(user.id, true);
      const pair = await this.createSession(user, ['pwd', 'otp']);
      await this.loginLog(user.id, 'SUCCESS', null);
      await this.maybeNewDevice(user.id, pair.session_id);
      return pair;
    });
  }

  async recover(challenge: string, codeRaw: string): Promise<TokenPair & { recovery_codes_remaining: number }> {
    const { ch, user } = await this.loadChallenge(challenge);
    const code = normalizeRecoveryCode(codeRaw);
    const codes = await this.tx.recoveryCode.findMany({
      where: { userId: user.id, usedAt: null },
      select: { id: true, codeHash: true },
    });
    let matched: string | undefined;
    // kiểm hết danh sách (không dừng sớm) — thời gian không lộ vị trí mã
    for (const c of codes) if ((await verifySecret(c.codeHash, code)) && !matched) matched = c.id;
    if (!matched) {
      await this.recordFailure(user.id, 'BAD_RECOVERY', null, ch.id);
      throw otpInvalid();
    }
    const id = matched;
    return this.txHost.withTransaction(async () => {
      await this.consumeChallenge(ch.id);
      const used = await this.tx.recoveryCode.updateMany({
        where: { id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (used.count !== 1) throw otpInvalid(); // dùng song song cùng một mã
      await this.resetFailures(user.id, true);
      const pair = await this.createSession(user, ['pwd', 'rcv']);
      await this.ao.recordAudit({
        action: 'auth.recovery_code_use',
        resourceType: 'user',
        resourceId: user.id,
        actor: { userId: user.id, userType: user.type as AdminType },
      });
      await this.loginLog(user.id, 'SUCCESS_RECOVERY', null);
      await this.maybeNewDevice(user.id, pair.session_id);
      return { ...pair, recovery_codes_remaining: codes.length - 1 };
    });
  }

  // ───────────────────────────── refresh / phiên ─────────────────────────────

  async refresh(refreshToken: string): Promise<TokenPair> {
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
            user: { select: { status: true } },
          },
        },
      },
    });
    if (!rt) throw new AppError('AUTHENTICATION_REQUIRED', 'Refresh token không hợp lệ');
    const s = rt.session;
    // phiên nhân viên/khách: lát 4/5 (cần chữ ký thiết bị / luồng OTP) — chưa nhận ở đây
    if (!isAdmin(s.userType)) throw new AppError('AUTHENTICATION_REQUIRED', 'Refresh token không hợp lệ');
    if (rt.usedAt) {
      await this.revokeForReuse(s.id, s.userId, s.userType);
      throw new AppError('SESSION_REVOKED', 'Phiên đã bị thu hồi — đăng nhập lại');
    }
    const now = new Date();
    if (s.revokedAt || s.expiresAt <= now || s.user.status !== 'ACTIVE')
      throw new AppError('SESSION_REVOKED', 'Phiên đã hết hạn hoặc bị thu hồi — đăng nhập lại');
    const next = randomToken();
    let reused = false;
    try {
      return await this.txHost.withTransaction(async () => {
        const expiresAt = slidingExpiry(s.createdAt, now);
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
          typ: s.userType === 'MASTER' ? 'master' : 'viewer',
          sid: s.id,
          amr: s.amr as Amr[],
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
    const u = await this.adminUser(p);
    if (u.totpEnabledAt)
      throw new AppError('INVALID_STATE_TRANSITION', '2FA đã bật — cần Master reset trước khi đăng ký lại');
    const secret = generateSecret(); // 20 byte, base32
    await this.tx.user.update({
      where: { id: u.id },
      data: { totpSecretEnc: this.cipher.encrypt(secret, totpAad(u.id)) },
      select: { id: true },
    });
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
    const u = await this.adminUser(p);
    if (u.totpEnabledAt || !u.totpSecretEnc)
      throw new AppError('INVALID_STATE_TRANSITION', 'Chưa bắt đầu đăng ký 2FA hoặc 2FA đã bật');
    const step = totpStep(this.totpSecret(u, true), code, null);
    if (step === undefined) throw otpInvalid();
    const enabled = await this.tx.user.updateMany({
      where: { id: u.id, totpEnabledAt: null },
      data: { totpEnabledAt: new Date(), totpLastStep: BigInt(step) },
    });
    if (enabled.count !== 1) throw new AppError('INVALID_STATE_TRANSITION', '2FA đã bật');
    const codes = await this.replaceRecoveryCodes(u.id);
    const amr: Amr[] = ['pwd', 'otp'];
    const live = await this.tx.session.updateMany({ where: { id: p.sessionId, revokedAt: null }, data: { amr } });
    if (live.count !== 1) throw new AppError('SESSION_REVOKED', 'Phiên đã bị thu hồi — đăng nhập lại');
    await this.ao.recordAudit({ action: 'auth.totp_enable', resourceType: 'user', resourceId: u.id });
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
    const u = await this.adminUser(p);
    if (!u.totpEnabledAt) throw new AppError('INVALID_STATE_TRANSITION', 'Chưa bật 2FA');
    const codes = await this.replaceRecoveryCodes(u.id);
    await this.ao.recordAudit({ action: 'auth.recovery_codes_regenerate', resourceType: 'user', resourceId: u.id });
    return { recovery_codes: codes };
  }

  async stepUp(
    p: Principal,
    code: string,
  ): Promise<{ step_up_until: string; access_token: string; access_token_expires_at: string }> {
    const u = await this.adminUser(p);
    if (!u.totpEnabledAt) throw new AppError('INVALID_STATE_TRANSITION', 'Chưa bật 2FA');
    await this.assertCanAuthenticate(u, null);
    const step = totpStep(this.totpSecret(u), code, u.totpLastStep);
    if (step === undefined) {
      await this.recordFailure(u.id, 'STEP_UP_FAILED', null);
      throw otpInvalid();
    }
    return this.txHost.withTransaction(async () => {
      await this.useTotpStep(u.id, step);
      await this.resetFailures(u.id, false);
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
    });
  }

  // ───────────────────────────── nội bộ ─────────────────────────────

  private async adminUser(p: Principal): Promise<UserAuthRow> {
    if (!isAdmin(p.userType)) throw new AppError('ACTION_FORBIDDEN', '2FA chỉ dành cho tài khoản Master/Viewer');
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

  /** Trạng thái tài khoản + khóa tạm. Ghi login_logs rồi ném. `password` chỉ để cân thời gian nhánh bị từ chối. */
  private async assertCanAuthenticate(
    u: UserAuthRow,
    identifierHash: Uint8Array | null,
    password?: string,
  ): Promise<void> {
    if (u.status === 'DISABLED') {
      if (password !== undefined) await verifySecret(await dummyHash(), password);
      await this.loginLog(u.id, 'DISABLED', identifierHash);
      throw invalidCredentials();
    }
    const now = Date.now();
    if (u.status === 'LOCKED' || (u.lockedUntil && u.lockedUntil.getTime() > now)) {
      await this.loginLog(u.id, 'LOCKED', identifierHash);
      throw new AppError(
        'ACCOUNT_LOCKED',
        'Tài khoản đang bị khóa',
        u.status === 'LOCKED' || !u.lockedUntil
          ? undefined
          : { retry_after_s: Math.ceil((u.lockedUntil.getTime() - now) / 1000) },
      );
    }
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
      await this.loginLog(ch?.userId ?? null, 'CHALLENGE_INVALID', null);
      throw challengeInvalid();
    }
    const user = (await this.tx.user.findUnique({
      where: { id: ch.userId },
      select: USER_AUTH_SELECT,
    })) as UserAuthRow | null;
    if (!user || !isAdmin(user.type) || !user.totpEnabledAt) {
      await this.loginLog(ch.userId, 'CHALLENGE_INVALID', null);
      throw challengeInvalid();
    }
    await this.assertCanAuthenticate(user, null);
    return { ch, user };
  }

  private async consumeChallenge(id: string): Promise<void> {
    const r = await this.tx.authChallenge.updateMany({
      where: { id, usedAt: null, attempts: { lt: MFA_CHALLENGE_MAX_ATTEMPTS }, expiresAt: { gt: new Date() } },
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

  /**
   * Lần sai: transaction RIÊNG đã commit trước khi request trả lỗi. Cộng bộ đếm nguyên tử trong SQL (song song không
   * mất lần đếm); đủ 5 ⇒ khóa 15 phút × 2^lock_count (trần 24 giờ), bộ đếm về 0.
   */
  private async recordFailure(
    userId: string,
    result: LoginResult,
    identifierHash: Uint8Array | null,
    challengeId?: string,
  ): Promise<void> {
    await this.txHost.withTransaction(async () => {
      await this.tx.$executeRaw`
        UPDATE core.users SET
          failed_login_count = CASE WHEN failed_login_count + 1 >= ${MAX_FAILED} THEN 0 ELSE failed_login_count + 1 END,
          lock_count = CASE WHEN failed_login_count + 1 >= ${MAX_FAILED} THEN lock_count + 1 ELSE lock_count END,
          locked_until = CASE WHEN failed_login_count + 1 >= ${MAX_FAILED}
            THEN now() + make_interval(mins => LEAST(${LOCK_BASE_MIN} * (2 ^ LEAST(lock_count, 7))::int, ${LOCK_MAX_MIN}))
            ELSE locked_until END
        WHERE id = ${userId}::uuid`;
      if (challengeId)
        await this.tx.authChallenge.updateMany({
          where: { id: challengeId, attempts: { lt: MFA_CHALLENGE_MAX_ATTEMPTS } },
          data: { attempts: { increment: 1 } },
        });
      await this.loginLog(userId, result, identifierHash);
    });
  }

  /** Đăng nhập trọn vẹn (2FA) ⇒ xóa cả mức khóa tăng dần; còn lại chỉ xóa bộ đếm sai. */
  private async resetFailures(userId: string, fullLogin: boolean): Promise<void> {
    await this.tx.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: 0,
        ...(fullLogin ? { lockCount: 0, lockedUntil: null, lastLoginAt: new Date() } : {}),
      },
      select: { id: true },
    });
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
          actor: { userId, userType: userType as AdminType },
          reason: 'refresh token đã xoay bị dùng lại — thu hồi cả họ',
        });
      await this.loginLog(userId, 'REFRESH_REUSE', null);
    });
  }

  private async replaceRecoveryCodes(userId: string): Promise<string[]> {
    await this.tx.recoveryCode.deleteMany({ where: { userId } });
    const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
    const hashes = await Promise.all(codes.map((c) => hashSecret(normalizeRecoveryCode(c), ARGON_PROFILES.CODE)));
    await this.tx.recoveryCode.createMany({ data: hashes.map((codeHash) => ({ id: uuidv7(), userId, codeHash })) });
    return codes;
  }

  private async loginLog(userId: string | null, result: LoginResult, identifierHash: Uint8Array | null): Promise<void> {
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
