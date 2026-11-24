import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { isIP } from 'node:net';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { ENV, type Env } from '../config/env';

export type LoginResult =
  | 'SUCCESS'
  | 'SUCCESS_RECOVERY'
  | 'ENROLLMENT_REQUIRED'
  | 'MFA_REQUIRED'
  | 'BAD_CREDENTIALS'
  | 'UNKNOWN_USER'
  | 'LOCKED'
  | 'DISABLED'
  | 'BAD_TOTP'
  | 'BAD_RECOVERY'
  | 'CHALLENGE_INVALID'
  | 'REFRESH_REUSE'
  | 'STEP_UP_FAILED';

export interface LoginLogEntry {
  userId?: string | null;
  /** HMAC(pepper, định danh đã chuẩn hóa) — không lưu email rõ */
  identifierHash?: Uint8Array | null;
  result: LoginResult;
  ip?: string | null;
  device?: string | null;
  userAgent?: string | null;
}

/**
 * Ghi `audit.login_logs` bằng role `audit_writer` qua kết nối RIÊNG (ADR-011): nhật ký đăng nhập thất bại vẫn còn dù
 * transaction nghiệp vụ rollback. audit_writer chỉ có INSERT (không SELECT) ⇒ INSERT không RETURNING.
 * Ghi lỗi ⇒ ném (đăng nhập không được tiếp tục khi không ghi được nhật ký — FR-INV-10).
 */
@Injectable()
export class AuditWriterService implements OnModuleDestroy {
  private readonly log = new Logger('AuditWriter');
  private readonly pool: Pool;

  constructor(@Inject(ENV) env: Env) {
    if (!env.DATABASE_URL_AUDIT) throw new Error('Thiếu DATABASE_URL_AUDIT (role audit_writer — ADR-011)');
    this.pool = new Pool({
      connectionString: env.DATABASE_URL_AUDIT,
      max: 5,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      query_timeout: 10_000,
    });
    // lỗi kết nối nhàn rỗi không được làm sập process
    this.pool.on('error', (err) => this.log.error({ err: err.message }, 'pool audit_writer lỗi'));
  }

  async loginLog(e: LoginLogEntry): Promise<void> {
    const ip = e.ip && isIP(e.ip) ? e.ip : null;
    await this.pool.query(
      `INSERT INTO audit.login_logs (id, user_id, identifier_hash, result, ip, device, user_agent)
       VALUES ($1, $2, $3, $4, $5::inet, $6, $7)`,
      [
        uuidv7(),
        e.userId ?? null,
        e.identifierHash ?? null,
        e.result,
        ip,
        e.device?.slice(0, 128) ?? null,
        e.userAgent?.slice(0, 512) ?? null,
      ],
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
