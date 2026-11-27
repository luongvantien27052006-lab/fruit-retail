import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { resolveRequestId } from './request-context';
import { dbErrorDetails, isConnectionError, isDbError, mapDbError } from './db-errors';
import { AppError, type ErrorCode, ERROR_HTTP_STATUS, isErrorCode } from './errors';

interface Envelope {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  request_id: string;
}

/**
 * HttpException của Nest/Express (route không có, JSON hỏng, body quá lớn, URI hỏng…) → mã §13.1 + thông báo CỐ ĐỊNH
 * (không lặp lại chi tiết parser/đầu vào). 413 → 400 INVALID_REQUEST (hợp đồng không có mã riêng cho body quá lớn).
 */
function fromHttpStatus(status: number): { status: number; code: ErrorCode; message: string } {
  if (status === 401) return { status, code: 'AUTHENTICATION_REQUIRED', message: 'Cần đăng nhập' };
  if (status === 403) return { status, code: 'ACTION_FORBIDDEN', message: 'Không có quyền thực hiện' };
  if (status === 404) return { status, code: 'RESOURCE_NOT_FOUND', message: 'Không tìm thấy' };
  if (status === 413) return { status: 400, code: 'INVALID_REQUEST', message: 'Dữ liệu gửi lên quá lớn' };
  if (status === 429) return { status, code: 'RATE_LIMITED', message: 'Gửi quá nhiều yêu cầu' };
  if (status === 503) return { status, code: 'DEPENDENCY_UNAVAILABLE', message: 'Dịch vụ tạm thời không sẵn sàng' };
  if (status >= 400 && status < 500) return { status: 400, code: 'INVALID_REQUEST', message: 'Yêu cầu không hợp lệ' };
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống' };
}

/**
 * Mọi lỗi → envelope chuẩn §13.1 (`Error` trong OpenAPI); request_id luôn có (kể cả lỗi xảy ra trước middleware).
 * Lỗi không lường trước → 500 INTERNAL_ERROR, KHÔNG lộ chi tiết ra client; log đủ để truy vết nhưng lỗi DB chỉ ghi
 * mã/SQLSTATE (message Prisma có thể chứa tham số/PII — FR-INV-18).
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('ErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const requestId = resolveRequestId(req);
    // Thứ tự: AppError → lỗi DB ánh xạ được → mất kết nối (pg/pg-pool/Prisma mang code mạng) → còn lại 500
    const dbMapped = exception instanceof AppError ? undefined : mapDbError(exception);
    const connLost = !(exception instanceof AppError) && !dbMapped && isConnectionError(exception);
    const mapped =
      exception instanceof AppError
        ? exception
        : (dbMapped ??
          (connLost ? new AppError('DEPENDENCY_UNAVAILABLE', 'Dịch vụ tạm thời không sẵn sàng') : undefined));
    let status: number;
    let body: Envelope;

    if (mapped) {
      status = mapped.status;
      // lỗi DB đã ánh xạ sang 4xx (vi phạm ràng buộc, trùng khóa…) thường là lỗi dữ liệu/lập trình ⇒ ghi warn
      if (status < 500 && dbMapped)
        this.log.warn(
          { request_id: requestId, method: req.method, status, ...dbErrorDetails(exception) },
          'lỗi DB → 4xx',
        );
      body = {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details ? { details: mapped.details } : {}),
        request_id: requestId,
      };
    } else if (exception instanceof HttpException) {
      const r = exception.getResponse();
      // Body đã ở dạng envelope (vd health 503) → giữ code/details
      if (typeof r === 'object' && r !== null && isErrorCode((r as { code?: unknown }).code)) {
        const e = r as { code: ErrorCode; message?: string; details?: Record<string, unknown> };
        status = ERROR_HTTP_STATUS[e.code];
        body = {
          code: e.code,
          message: e.message ?? 'Lỗi',
          ...(e.details ? { details: e.details } : {}),
          request_id: requestId,
        };
      } else {
        const f = fromHttpStatus(exception.getStatus());
        status = f.status;
        body = { code: f.code, message: f.message, request_id: requestId };
        if (status < 500)
          this.log.warn(
            { request_id: requestId, method: req.method, status: exception.getStatus() },
            `từ chối: ${exception.name}`,
          );
      }
    } else {
      status = ERROR_HTTP_STATUS.INTERNAL_ERROR;
      body = { code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống', request_id: requestId };
    }

    // mất kết nối hạ tầng: 503 cho client nhưng log ĐỦ message/stack để chẩn đoán sự cố
    if (connLost) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.log.error({ request_id: requestId, method: req.method, err }, 'mất kết nối hạ tầng → 503');
    } else if (status >= 500) {
      const where = { request_id: requestId, method: req.method, route: req.route?.path as string | undefined };
      if (isDbError(exception)) {
        this.log.error({ ...where, ...dbErrorDetails(exception) }, 'lỗi DB 5xx');
      } else {
        const err = exception instanceof Error ? exception : new Error(String(exception));
        this.log.error({ ...where, err }, 'request lỗi 5xx');
      }
    }
    if (!res.headersSent) res.status(status).json(body);
  }
}
