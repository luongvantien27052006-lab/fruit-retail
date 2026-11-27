import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { AppError } from '../common/errors';
import { ENV, type Env } from '../config/env';

export type ViewerQuery = <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;

/**
 * Pool RIÊNG role `viewer_ro` cho route /v1/viewer/* (SPEC §2.5 lớp 3–4, ADR-006/011/024). Mỗi lần đọc = một
 * transaction READ ONLY, đặt `app.viewer_profile_id` bằng `set_config(..., true)` (chỉ trong transaction) ⇒ RLS
 * `reporting.allowed_stores()` lọc theo hồ sơ. Kết nối không phải `viewer_ro` (cấu hình nhầm URL) ⇒ từ chối đọc — không
 * bao giờ âm thầm đọc bằng role có quyền rộng hơn. Thiếu DATABASE_URL_VIEWER ⇒ 503.
 */
@Injectable()
export class ViewerDb implements OnModuleDestroy {
  private readonly log = new Logger('ViewerDb');
  private readonly pool: Pool | null;

  constructor(@Inject(ENV) env: Env) {
    this.pool = env.DATABASE_URL_VIEWER
      ? new Pool({
          connectionString: env.DATABASE_URL_VIEWER,
          max: 5,
          connectionTimeoutMillis: 5_000,
          statement_timeout: 10_000,
          query_timeout: 15_000,
        })
      : null;
    this.pool?.on('error', (err) => this.log.error({ err: err.message }, 'pool viewer_ro lỗi'));
  }

  async read<T>(profileId: string, fn: (q: ViewerQuery) => Promise<T>): Promise<T> {
    if (!this.pool) throw new AppError('CONFIGURATION_NOT_READY', 'Chưa cấu hình kết nối dữ liệu báo cáo');
    let c: PoolClient;
    try {
      c = await this.pool.connect();
    } catch (e) {
      const err = e as { code?: unknown; name?: string };
      this.log.error(`Pool viewer_ro lỗi kết nối: ${err?.name ?? 'Error'}${err?.code ? ` (${String(err.code)})` : ''}`);
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'Không kết nối được dữ liệu báo cáo');
    }
    let broken = false;
    try {
      await c.query('BEGIN TRANSACTION READ ONLY');
      // kiểm role ở MỖI transaction (gần như miễn phí): SET ROLE / đổi URL không lọt qua lần kiểm đầu
      const r = await c.query<{ u: string }>(
        `SELECT current_user AS u, set_config('app.viewer_profile_id', $1, true) AS p`,
        [profileId],
      );
      if (r.rows[0]?.u !== 'viewer_ro') {
        broken = true;
        throw new Error('DATABASE_URL_VIEWER không phải role viewer_ro');
      }
      const out = await fn(async <R>(sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows as R[]);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      // ROLLBACK lỗi (kết nối hỏng / quá hạn) ⇒ hủy kết nối, không trả về pool (L3)
      await c.query('ROLLBACK').catch(() => {
        broken = true;
      });
      throw e;
    } finally {
      c.release(broken);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
