import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { normalizeEmail } from '../auth/auth.service';
import { hashSecret } from '../auth/password';

const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

export interface CreatedMaster {
  userId: string;
  email: string;
  /** mật khẩu tạm — chỉ in MỘT lần ra terminal của người chạy lệnh */
  password: string;
}

/**
 * Tạo tài khoản Master (§2.1 — tối thiểu 2 tài khoản; CP03 "Việc của Tiến"). Chạy MỘT lần trên máy chủ bằng role
 * app_rw. Tài khoản mới chưa có 2FA ⇒ lần đăng nhập đầu chỉ gọi được route đăng ký 2FA (AccessGuard). Ghi audit.logs
 * cùng transaction. Email đã tồn tại ⇒ lỗi (không ghi đè).
 */
export async function createMaster(
  databaseUrl: string,
  emailRaw: string,
  /** chỉ test dùng false (bỏ bước đổi mật khẩu tạm để kiểm luồng khác); CLI thật luôn bắt đổi (NC-22) */
  opts: { mustChangePassword?: boolean } = {},
): Promise<CreatedMaster> {
  const email = normalizeEmail(emailRaw);
  if (!EMAIL_RE.test(email) || email.length > 254) throw new Error('Email không hợp lệ');
  const password = randomBytes(15).toString('base64url'); // 20 ký tự, 120 bit
  const passwordHash = await hashSecret(password);
  const userId = uuidv7();
  const c = new Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    // mật khẩu tạm in ra terminal ⇒ phải đổi trước khi đăng ký 2FA (NC-22)
    await c.query(
      `INSERT INTO core.users (id, type, email, password_hash, must_change_password) VALUES ($1, 'MASTER', $2, $3, $4)`,
      [userId, email, passwordHash, opts.mustChangePassword ?? true],
    );
    await c.query(
      `INSERT INTO core.user_role_assignments (id, user_id, role, scope_type) VALUES ($1, $2, 'MASTER_ADMIN', 'ALL')`,
      [uuidv7(), userId],
    );
    await c.query(
      `INSERT INTO audit.logs (id, action, resource_type, resource_id, reason, after)
       VALUES ($1, 'user.master_create', 'user', $2, 'CLI create-master', $3::jsonb)`,
      [uuidv7(), userId, JSON.stringify({ type: 'MASTER', role: 'MASTER_ADMIN' })],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
  return { userId, email, password };
}

async function main(): Promise<void> {
  const i = process.argv.indexOf('--email');
  const email = i > 0 ? process.argv[i + 1] : undefined;
  const url = process.env['DATABASE_URL_APP'];
  if (!email || !url) {
    console.error('Cách dùng: DATABASE_URL_APP=<app_rw> node dist/cli/create-master.js --email <email>');
    process.exit(2);
  }
  const r = await createMaster(url, email);
  // stdout của người chạy lệnh — KHÔNG ghi log/file. Đổi qua đăng ký 2FA ngay ở lần đăng nhập đầu.
  console.log(`Đã tạo Master ${r.email} (id ${r.userId}).`);
  console.log(`Mật khẩu tạm (chỉ hiện một lần, lưu vào trình quản lý mật khẩu): ${r.password}`);
  console.log('Lần đăng nhập đầu: bắt buộc đăng ký 2FA (Authenticator) và cất 10 mã khôi phục.');
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch((e: unknown) => {
    console.error('[create-master] lỗi:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
