import { generateKeyPairSync, randomBytes } from 'node:crypto';

/** Khóa thử sinh mới mỗi lần chạy test (không có khóa cố định trong repo). */
export function newJwtKey(kid: string): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return `${kid}:${privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')}`;
}

export function testAuthEnv(auditUrl = 'postgresql://audit_writer:x@127.0.0.1:1/none'): Record<string, string> {
  return {
    JWT_SIGNING_KEYS: newJwtKey('k1'),
    PII_ENC_KEYS: `1:${randomBytes(32).toString('base64')}`,
    PII_HASH_PEPPER: randomBytes(32).toString('base64'),
    DATABASE_URL_AUDIT: auditUrl,
  };
}
