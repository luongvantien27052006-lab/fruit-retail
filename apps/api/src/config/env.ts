import { z } from 'zod';

// Biến môi trường §19.4 (+ ADR-011/012). Thiếu biến hạ tầng bắt buộc → dừng khởi động (không fallback, FR-INV-17).
// Biến của đối tác (SePay, Ahamove, OTP…) không bắt buộc ở đây: thiếu → 503 CONFIGURATION_NOT_READY cho tác vụ mới.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_URL_APP: z.string().url(),
  DATABASE_URL_VIEWER: z.string().url().optional(),
  DATABASE_URL_VIEWER_ACT: z.string().url().optional(),
  DATABASE_URL_PROJECTOR: z.string().url().optional(),
  DATABASE_URL_AUDIT: z.string().url().optional(),
  REDIS_URL: z.string().url(),
  TZ: z.literal('Asia/Ho_Chi_Minh').default('Asia/Ho_Chi_Minh'),
  BUSINESS_DAY_CUTOFF: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('04:00'),
  // Khóa ký JWT, khóa mã hóa PII, pepper băm (ADR-012/015). Kiểm định dạng ở AuthConfig khi API khởi động
  // (worker không cần) — thiếu/sai ⇒ API không khởi động.
  JWT_SIGNING_KEYS: z.string().optional(),
  PII_ENC_KEYS: z.string().optional(),
  PII_HASH_PEPPER: z.string().optional(),
  // OTP khách (SEC6, ADR-023). Kiểm ở AuthModule lúc API khởi động: production bắt buộc nhà cung cấp thật (chưa có ⇒ không
  // khởi động); TEST_DOUBLE chỉ cho development/test/staging; thiếu ⇒ route OTP trả 503 CONFIGURATION_NOT_READY.
  OTP_PROVIDER: z.enum(['TEST_DOUBLE', 'SMS_BRANDNAME', 'ZALO_ZNS']).optional(),
  OTP_API_KEY: z.string().optional(),
  OTP_SENDER: z.string().optional(),
  // Lưu file (§19.4, ADR-014/025): object storage tương thích S3, bucket riêng tư. Thiếu ⇒ route /files/* trả 503.
  S3_ENDPOINT: z.string().url().optional(),
  /** địa chỉ client dùng để PUT/GET presigned (mặc định = S3_ENDPOINT) — khác khi API gọi S3 qua mạng nội bộ */
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().min(3).max(63).optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true'),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof schema>;

const S3_REQUIRED = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const;
const S3_ANY = [...S3_REQUIRED, 'S3_PUBLIC_ENDPOINT'] as const;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // biến đặt rỗng (compose `${X:-}`) = không đặt — tránh "" lọt vào enum/url của biến tùy chọn
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    // Không in giá trị (URL có thể chứa mật khẩu) — FR-INV-18.
    throw new Error(`Cấu hình môi trường không hợp lệ hoặc thiếu: ${fields}`);
  }
  // S3 đặt một phần (quên khóa bí mật…) ⇒ dừng khởi động, không âm thầm tắt tính năng file (kiểm thử lát 7)
  const s3Set = S3_ANY.filter((k) => parsed.data[k] !== undefined);
  if (s3Set.length > 0 && S3_REQUIRED.some((k) => parsed.data[k] === undefined))
    throw new Error(`Cấu hình S3 thiếu: ${S3_REQUIRED.filter((k) => parsed.data[k] === undefined).join(', ')}`);
  // Múi giờ process luôn là giờ VN kể cả ngoài Docker (FR-INV-13); lưu DB vẫn là UTC TIMESTAMPTZ.
  process.env['TZ'] = parsed.data.TZ;
  return parsed.data;
}

export const ENV = Symbol('ENV');
