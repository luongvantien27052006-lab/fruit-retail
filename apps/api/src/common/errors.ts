/**
 * Mã lỗi chuẩn §13.1 — khớp `components.schemas.ErrorCode` + `x-http-status` trong packages/contracts/openapi.yaml.
 * Test `request-framework.test.ts` đối chiếu bảng này với hợp đồng (lệch ⇒ đỏ).
 */
export const ERROR_HTTP_STATUS = {
  INVALID_REQUEST: 400,
  AUTHENTICATION_REQUIRED: 401,
  TWO_FACTOR_REQUIRED: 401,
  OTP_INVALID: 401,
  ACCOUNT_LOCKED: 403,
  ACTION_FORBIDDEN: 403,
  STEP_UP_REQUIRED: 403,
  DEVICE_NOT_ACTIVATED: 403,
  RESOURCE_NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  INVALID_STATE_TRANSITION: 409,
  STOCK_INSUFFICIENT: 422,
  DEAL_SOLD_OUT: 422,
  DEAL_NOT_LIVE: 422,
  DEAL_LIMIT_EXCEEDED: 422,
  OUT_OF_ZONE: 422,
  SHIFT_NOT_OPEN: 422,
  SHIFT_ALREADY_OPEN: 422,
  APPROVAL_REQUIRED: 422,
  APPROVER_MUST_DIFFER: 422,
  PERIOD_LOCKED: 422,
  DOCUMENT_HAS_DOWNSTREAM: 422,
  BATCH_EXPIRED: 422,
  BATCH_STOP_SELL_APP: 422,
  BARCODE_CHECKSUM_INVALID: 422,
  OFFLINE_WINDOW_EXCEEDED: 422,
  COD_LIMIT_EXCEEDED: 422,
  SHIPPER_COD_LIMIT_EXCEEDED: 422,
  COMPLAINT_WINDOW_EXPIRED: 422,
  COMPLAINT_LIMIT_EXCEEDED: 422,
  CASH_DIFFERENCE_APPROVAL_REQUIRED: 422,
  PRICE_BELOW_FLOOR: 422,
  PAYMENT_NOT_CONFIRMED: 422,
  IMPORT_VALIDATION_FAILED: 422,
  TWO_FACTOR_ENROLLMENT_REQUIRED: 403,
  PASSWORD_CHANGE_REQUIRED: 403,
  SESSION_REVOKED: 401,
  DEVICE_REVOKED: 403,
  LAST_MASTER_REQUIRED: 422,
  WEBHOOK_SIGNATURE_INVALID: 401,
  MFA_CHALLENGE_INVALID: 401,
  RATE_LIMITED: 429,
  OTP_RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  CONFIGURATION_NOT_READY: 503,
  DEPENDENCY_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;

/** Lỗi nghiệp vụ có mã chuẩn. Ném ở bất kỳ tầng nào; filter chuyển thành envelope `{code, message, details, request_id}`. */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ERROR_HTTP_STATUS[code];
  }
}

export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ERROR_HTTP_STATUS, v);
}
