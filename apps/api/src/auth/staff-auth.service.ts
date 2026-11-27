import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import { v7 as uuidv7 } from 'uuid';
import type { Tx } from '../common/audit-outbox.service';
import { findSqlState } from '../common/db-errors';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { AuthAttempts, deviceSource } from './auth-attempts';
import type { TokenPair } from './auth.service';
import type { DeviceProof } from './device-proof';
import { dummyHash, verifySecret, withArgonSlot } from './password';
import { PiiCipher } from './pii-cipher';
import { PosDeviceService, type VerifiedDevice } from './pos-device.service';
import { AccessTokens, randomToken, sha256, STAFF_SESSION_S } from './tokens';

const invalidPin = () =>
  new AppError(
    'AUTHENTICATION_REQUIRED',
    'Mã nhân viên hoặc PIN không đúng, tài khoản đang tạm khóa, hoặc không được đăng nhập trên thiết bị này',
  );

export const normalizeStaffCode = (c: string) => c.normalize('NFC').trim().toUpperCase();

/**
 * Nhân viên POS đăng nhập mã NV + PIN 6 số trên thiết bị ĐÃ KÍCH HOẠT (SEC3 — ADR-012, ADR-022).
 * Thứ tự: bằng chứng thiết bị (chữ ký + nonce một lần, đã commit) → tra nhân viên → `AuthAttempts.run` (khóa theo
 * tài khoản, đếm sai chung SEC5) → phiên STAFF gắn thiết bị, hạn tuyệt đối 24 giờ.
 */
@Injectable()
export class StaffAuthService {
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly devices: PosDeviceService,
    private readonly attempts: AuthAttempts,
    private readonly cipher: PiiCipher,
    private readonly tokens: AccessTokens,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  private get tx() {
    return this.txHost.tx;
  }

  async pinLogin(b: {
    staff_code: string;
    pin: string;
    device_proof: DeviceProof;
  }): Promise<TokenPair & { staff: { user_id: string; staff_code: string; full_name: string }; device_id: string }> {
    const code = normalizeStaffCode(b.staff_code);
    const device = await this.devices.verifyProof('pin', code, b.device_proof);
    const identifierHash = this.cipher.hmac(`staff:${code}`);
    const slot = `dev:${device.id}`;
    const dummy = async () => void (await verifySecret(await dummyHash(), b.pin));

    const staff = await this.tx.staff.findUnique({
      where: { staffCode: code },
      select: {
        userId: true,
        staffCode: true,
        fullName: true,
        leftAt: true,
        user: { select: { type: true, pinHash: true } },
      },
    });
    const allowed = staff ? await this.allowedOnStore(staff.userId, device.storeId) : false;
    if (!staff || staff.user.type !== 'STAFF' || !staff.user.pinHash || hasLeft(staff.leftAt) || !allowed) {
      // cùng thời gian (Argon2 giả) + cùng lỗi với sai PIN: không dò được mã NV nào tồn tại / thuộc cửa hàng nào
      try {
        await withArgonSlot(slot, dummy);
      } catch (e) {
        if (e instanceof AppError && e.code === 'RATE_LIMITED')
          await this.attempts.log(staff?.userId ?? null, 'RATE_LIMITED', identifierHash);
        throw e;
      }
      await this.attempts.log(staff?.userId ?? null, staff ? 'STORE_NOT_ALLOWED' : 'UNKNOWN_USER', identifierHash);
      throw invalidPin();
    }
    const pinHash = staff.user.pinHash;
    try {
      return await this.loginOnce(staff, device, identifierHash, pinHash, b.pin, slot, dummy);
    } catch (e) {
      // L1: thu hồi thiết bị commit giữa bước kiểm chữ ký và tạo phiên ⇒ trigger sessions_guard (23514)
      if (findSqlState(e) === '23514') {
        await this.attempts.log(staff.userId, 'DEVICE_REVOKED', identifierHash);
        throw new AppError('DEVICE_REVOKED', 'Thiết bị vừa bị thu hồi');
      }
      throw e;
    }
  }

  private loginOnce(
    staff: { userId: string; staffCode: string; fullName: string },
    device: VerifiedDevice,
    identifierHash: Uint8Array,
    pinHash: string,
    pin: string,
    slot: string,
    dummy: () => Promise<void>,
  ) {
    return this.attempts.run(
      {
        userId: staff.userId,
        identifierHash,
        argon: true,
        publicError: invalidPin,
        failResult: 'BAD_CREDENTIALS',
        dummy,
        slot,
        // ADR-030: khóa theo (nhân viên, máy) — nhập sai trên một máy không khóa nhân viên ở máy khác
        scope: { source: deviceSource(device.id) },
      },
      async () => {
        // L1' (kiểm thử DB lát 6): ĐỌC LẠI mã băm PIN + ngày nghỉ trong transaction đang giữ khóa `auth:<id>` — mã băm đọc
        // trước khi chờ suất Argon có thể đã cũ (Master vừa đổi PIN). PIN đã đổi ⇒ PIN cũ là PIN sai (đếm sai như thường).
        const cur = await this.tx.user.findUnique({
          where: { id: staff.userId },
          select: { pinHash: true, staff: { select: { leftAt: true } } },
        });
        if (!cur?.pinHash || hasLeft(cur.staff?.leftAt ?? null)) {
          await dummy(); // G1: cùng thời gian với nhánh kiểm thật
          return false;
        }
        if (cur.pinHash !== pinHash) {
          await dummy(); // cùng thời gian với nhánh kiểm thật
          return false;
        }
        return verifySecret(cur.pinHash, pin);
      },
      async () => {
        // kiểm lại trong transaction (vai trò có thể vừa bị thu hồi)
        if (!(await this.allowedOnStore(staff.userId, device.storeId))) throw invalidPin();
        await this.attempts.clearFailures(staff.userId, true, { source: deviceSource(device.id) });
        const pair = await this.createSession(staff.userId, device);
        await this.attempts.log(staff.userId, 'SUCCESS', identifierHash);
        return {
          ...pair,
          staff: { user_id: staff.userId, staff_code: staff.staffCode, full_name: staff.fullName },
          device_id: device.id,
        };
      },
    );
  }

  private allowedOnStore(userId: string, storeId: string): Promise<boolean> {
    return staffAllowedOnStore(this.tx, userId, storeId);
  }

  private async createSession(userId: string, device: VerifiedDevice): Promise<TokenPair> {
    const now = new Date();
    const id = uuidv7();
    const ip = this.cls.get('ip');
    // trigger sessions_guard: thiết bị phải ACTIVE (FOR SHARE) — thu hồi song song chờ transaction này rồi thu hồi luôn
    await this.tx.session.create({
      data: {
        id,
        userId,
        userType: 'STAFF',
        posDeviceId: device.id,
        amr: ['pin'],
        expiresAt: new Date(now.getTime() + STAFF_SESSION_S * 1000),
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
    const access = await this.tokens.sign({ sub: userId, typ: 'staff', sid: id, amr: ['pin'], dev: device.id }, now);
    return {
      access_token: access.token,
      access_token_expires_at: access.expiresAt.toISOString(),
      refresh_token: refresh,
      session_id: id,
      amr: ['pin'],
    };
  }
}

/** Nhân viên có vai trò còn hiệu lực phạm vi ALL hoặc đúng cửa hàng của thiết bị (đăng nhập PIN + refresh — L2). */
export async function staffAllowedOnStore(tx: Tx['tx'], userId: string, storeId: string): Promise<boolean> {
  // cửa hàng ngừng hoạt động / lưu trữ ⇒ không ai đăng nhập được trên máy của cửa hàng đó (ADR-024)
  const store = await tx.store.findUnique({ where: { id: storeId }, select: { status: true, archivedAt: true } });
  if (!store || store.status !== 'ACTIVE' || store.archivedAt) return false;
  const n = await tx.userRoleAssignment.count({
    where: { userId, revokedAt: null, OR: [{ scopeType: 'ALL' }, { scopeType: 'STORE', scopeId: storeId }] },
  });
  return n > 0;
}

/** Ngày nghỉ việc đã tới (left_at là DATE, so theo ngày UTC) */
export function hasLeft(leftAt: Date | null): boolean {
  return leftAt !== null && leftAt.getTime() <= Date.now();
}
