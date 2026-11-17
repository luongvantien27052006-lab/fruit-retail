import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { Client } from 'pg';

/**
 * Bộ chạy SQL tay trong infra/sql (ADR-017): áp theo thứ tự số, ghi sha256 vào integration.sql_migrations,
 * từ chối nếu file đã áp bị sửa hoặc bị xóa. Đặt mật khẩu role từ biến môi trường dưới dạng SCRAM verifier
 * (mật khẩu thô không đi vào câu lệnh SQL, tránh lộ qua log PostgreSQL — FR-INV-18).
 */
export const ROLE_PASSWORD_ENV = {
  app_rw: 'PG_APP_RW_PASSWORD',
  projector_rw: 'PG_PROJECTOR_RW_PASSWORD',
  viewer_ro: 'PG_VIEWER_RO_PASSWORD',
  viewer_act: 'PG_VIEWER_ACT_PASSWORD',
  audit_writer: 'PG_AUDIT_WRITER_PASSWORD',
} as const;

const FILE_RE = /^\d{3}_[a-z0-9_]+\.sql$/;
/** Khóa advisory cố định để 2 lần bootstrap chạy song song không đua nhau. */
const LOCK_KEY = 4_211_021_000;

export interface ApplyOptions {
  url: string;
  dir: URL;
  env: Record<string, string | undefined>;
  log?: (msg: string) => void;
}

/** Kiểm mật khẩu role: có, đủ dài, không phải giá trị mẫu, không trùng nhau. */
export function validateRolePasswords(env: Record<string, string | undefined>): void {
  const strict = env['NODE_ENV'] === 'staging' || env['NODE_ENV'] === 'production';
  const minLen = strict ? 24 : 12;
  const keys = [
    ...Object.values(ROLE_PASSWORD_ENV),
    ...(env['PG_OWNER_PASSWORD'] !== undefined ? ['PG_OWNER_PASSWORD'] : []),
  ];
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const k of keys) {
    const v = env[k] ?? '';
    if (v.length < minLen) problems.push(`${k} (< ${minLen} ký tự)`);
    else if (/change-me/i.test(v)) problems.push(`${k} (còn giá trị mẫu change-me)`);
    else if (seen.has(v)) problems.push(`${k} (trùng ${seen.get(v)})`);
    seen.set(v, k);
  }
  if (problems.length) throw new Error(`Mật khẩu role không hợp lệ: ${problems.join(', ')}`);
}

/** SCRAM-SHA-256 verifier theo RFC 5802/7677 — định dạng PostgreSQL chấp nhận trong ALTER ROLE … PASSWORD. */
export function scramSha256Verifier(password: string, iterations = 4096): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

export async function applySqlMigrations({
  url,
  dir,
  env,
  log = console.log,
}: ApplyOptions): Promise<{ applied: string[] }> {
  validateRolePasswords(env);

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const bad = files.filter((f) => !FILE_RE.test(f));
  if (bad.length) throw new Error(`Tên file SQL sai quy ước NNN_ascii_snake.sql: ${bad.join(', ')}`);

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    const hasTable = await client.query(`SELECT to_regclass('integration.sql_migrations') IS NOT NULL AS ok`);
    const done = new Map<string, string>();
    if (hasTable.rows[0].ok) {
      for (const r of (await client.query('SELECT file, sha256 FROM integration.sql_migrations')).rows)
        done.set(r.file, r.sha256);
    }
    const vanished = [...done.keys()].filter((f) => !files.includes(f));
    if (vanished.length) throw new Error(`File đã áp nhưng không còn trong thư mục: ${vanished.join(', ')}`);

    for (const f of files) {
      const sql = readFileSync(new URL(f, dir), 'utf8');
      const sha = createHash('sha256').update(sql).digest('hex');
      const prev = done.get(f);
      if (prev) {
        if (prev !== sha)
          throw new Error(
            `File ${f} đã áp nhưng sha256 thay đổi (${prev.slice(0, 12)}… → ${sha.slice(0, 12)}…). Sửa bằng file mới, không sửa file cũ.`,
          );
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO integration.sql_migrations(file, sha256) VALUES ($1, $2)', [f, sha]);
        await client.query('COMMIT');
      } catch (e) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Giữ lỗi gốc bên dưới; lỗi ROLLBACK (kết nối đã chết) không được che lỗi gốc.
        }
        throw new Error(`Áp ${f} thất bại: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      applied.push(f);
      log(`[sql] đã áp ${f}`);
    }
    // Mật khẩu role luôn đặt lại theo env hiện tại (xoay mật khẩu = đổi env + chạy lại). Chỉ gửi SCRAM verifier.
    for (const [role, key] of Object.entries(ROLE_PASSWORD_ENV)) {
      const verifier = scramSha256Verifier(env[key] ?? '');
      const lit = (await client.query('SELECT quote_literal($1) AS l', [verifier])).rows[0].l as string;
      await client.query(`ALTER ROLE ${role} PASSWORD ${lit}`);
    }
    return { applied };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}
