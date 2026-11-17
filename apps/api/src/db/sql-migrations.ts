import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { Client } from 'pg';

/**
 * Bộ chạy SQL tay trong infra/sql (ADR-017): áp theo thứ tự số, ghi sha256 vào integration.sql_migrations,
 * từ chối nếu file đã áp bị sửa. Đặt mật khẩu role từ biến môi trường (không có mật khẩu mặc định).
 */
export const ROLE_PASSWORD_ENV = {
  app_rw: 'PG_APP_RW_PASSWORD',
  projector_rw: 'PG_PROJECTOR_RW_PASSWORD',
  viewer_ro: 'PG_VIEWER_RO_PASSWORD',
  viewer_act: 'PG_VIEWER_ACT_PASSWORD',
  audit_writer: 'PG_AUDIT_WRITER_PASSWORD',
} as const;

const FILE_RE = /^\d{3}_[a-z0-9_]+\.sql$/;

export interface ApplyOptions {
  url: string;
  dir: URL;
  env: Record<string, string | undefined>;
  log?: (msg: string) => void;
}

export async function applySqlMigrations({ url, dir, env, log = console.log }: ApplyOptions): Promise<{ applied: string[] }> {
  const missing = Object.values(ROLE_PASSWORD_ENV).filter((k) => !env[k] || env[k]!.length < 12);
  if (missing.length) throw new Error(`Thiếu hoặc quá ngắn (< 12 ký tự) mật khẩu role: ${missing.join(', ')}`);

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const bad = files.filter((f) => !FILE_RE.test(f));
  if (bad.length) throw new Error(`Tên file SQL sai quy ước NNN_ascii_snake.sql: ${bad.join(', ')}`);

  const client = new Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];
  try {
    const hasTable = await client.query(`SELECT to_regclass('integration.sql_migrations') IS NOT NULL AS ok`);
    const done = new Map<string, string>();
    if (hasTable.rows[0].ok) {
      for (const r of (await client.query('SELECT file, sha256 FROM integration.sql_migrations')).rows) done.set(r.file, r.sha256);
    }
    for (const f of files) {
      const sql = readFileSync(new URL(f, dir), 'utf8');
      const sha = createHash('sha256').update(sql).digest('hex');
      const prev = done.get(f);
      if (prev) {
        if (prev !== sha) throw new Error(`File ${f} đã áp nhưng sha256 thay đổi (${prev.slice(0, 12)}… → ${sha.slice(0, 12)}…). Sửa bằng file mới, không sửa file cũ.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO integration.sql_migrations(file, sha256) VALUES ($1, $2)', [f, sha]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Áp ${f} thất bại: ${e instanceof Error ? e.message : String(e)}`);
      }
      applied.push(f);
      log(`[sql] đã áp ${f}`);
    }
    // Mật khẩu role luôn đặt lại theo env hiện tại (xoay mật khẩu = đổi env + chạy lại). Không log giá trị.
    for (const [role, key] of Object.entries(ROLE_PASSWORD_ENV)) {
      const lit = (await client.query('SELECT quote_literal($1) AS l', [env[key]])).rows[0].l as string;
      await client.query(`ALTER ROLE ${role} PASSWORD ${lit}`);
    }
    return { applied };
  } finally {
    await client.end();
  }
}
