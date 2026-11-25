import { createHash, randomBytes } from 'node:crypto';
import { errors, jwtVerify, SignJWT, decodeProtectedHeader } from 'jose';
import type { AuthKeys } from './auth-config';

/** Hạn và hằng số phiên (ADR-012, ADR-021) */
export const ACCESS_TTL_S = 15 * 60;
export const MFA_CHALLENGE_TTL_S = 5 * 60;
export const MFA_CHALLENGE_MAX_ATTEMPTS = 5;
export const STEP_UP_TTL_S = 5 * 60;
/** admin: 12 giờ trượt (ADR-012), trần tuyệt đối 7 ngày kể từ đăng nhập (ADR-021) */
export const ADMIN_SLIDING_S = 12 * 3600;
export const ADMIN_ABSOLUTE_S = 7 * 24 * 3600;
/** nhân viên POS: 24 giờ tuyệt đối kể từ đăng nhập PIN, refresh không gia hạn (ADR-012, ADR-022) */
export const STAFF_SESSION_S = 24 * 3600;

const ISSUER = 'fruit-api';
const AUDIENCE = 'fruit';

export type Amr = 'pwd' | 'otp' | 'rcv' | 'pin';

export interface AccessClaims {
  sub: string;
  typ: 'master' | 'viewer' | 'staff' | 'customer';
  sid: string;
  amr: Amr[];
  /** epoch giây; chỉ để client hiển thị — server luôn đọc sessions.step_up_until */
  step_up_until?: number;
  /** thiết bị POS của phiên nhân viên (ADR-012 claim dev) — chỉ để client; server đọc sessions.pos_device_id */
  dev?: string;
}

/** Chuỗi ngẫu nhiên 256 bit (refresh token, mfa_challenge) — base64url, 43 ký tự. */
export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(createHash('sha256').update(s, 'utf8').digest());
export const OPAQUE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export class AccessTokens {
  constructor(private readonly keys: AuthKeys) {}

  async sign(c: AccessClaims, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + ACCESS_TTL_S;
    const body: Record<string, unknown> = { typ: c.typ, sid: c.sid, amr: c.amr };
    if (c.step_up_until) body['step_up_until'] = c.step_up_until;
    if (c.dev) body['dev'] = c.dev;
    const token = await new SignJWT(body)
      .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: this.keys.jwt.signKid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(c.sub)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .setJti(randomBytes(12).toString('base64url'))
      .sign(this.keys.jwt.sign);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /**
   * Kiểm chữ ký (chỉ EdDSA, `kid` phải có trong cấu hình), iss/aud/exp. Sai ⇒ `undefined` (người gọi trả 401 chung,
   * không lộ lý do). Không tin claim nào ngoài sub/sid — trạng thái phiên đọc lại từ DB mỗi request.
   */
  async verify(token: string): Promise<{ sub: string; sid: string } | undefined> {
    if (token.length > 2048) return undefined;
    let kid: string | undefined;
    try {
      const h = decodeProtectedHeader(token);
      if (h.alg !== 'EdDSA' || h.typ !== 'at+jwt' || typeof h.kid !== 'string') return undefined;
      kid = h.kid;
    } catch {
      return undefined;
    }
    const key = this.keys.jwt.verify.get(kid);
    if (!key) return undefined;
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['EdDSA'],
        issuer: ISSUER,
        audience: AUDIENCE,
        typ: 'at+jwt',
        requiredClaims: ['sub', 'sid', 'exp', 'iat'],
        clockTolerance: 5,
      });
      if (typeof payload.sub !== 'string' || typeof payload['sid'] !== 'string') return undefined;
      return { sub: payload.sub, sid: payload['sid'] };
    } catch (e) {
      if (e instanceof errors.JOSEError) return undefined;
      throw e;
    }
  }
}
