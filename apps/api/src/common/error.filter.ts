import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError, type ErrorCode, ERROR_HTTP_STATUS, isErrorCode } from './errors';

interface Envelope {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  request_id: string;
}

/** Mã lỗi mặc định khi lỗi đến từ HttpException của Nest (route không có, JSON sai, body quá lớn…). */
function codeForStatus(status: number): ErrorCode {
  if (status === 401) return 'AUTHENTICATION_REQUIRED';
  if (status === 403) return 'ACTION_FORBIDDEN';
  if (status === 404) return 'RESOURCE_NOT_FOUND';
  if (status === 409) return 'VERSION_CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'DEPENDENCY_UNAVAILABLE';
  if (status >= 400 && status < 500) return 'INVALID_REQUEST';
  return 'INTERNAL_ERROR';
}

/**
 * Mọi lỗi → envelope chuẩn §13.1 (`Error` trong OpenAPI). Lỗi không lường trước → 500 INTERNAL_ERROR, KHÔNG lộ chi
 * tiết/stack ra client (ghi log đầy đủ kèm request_id để truy vết).
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('ErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const requestId = String(req.id ?? '');
    let status: number;
    let body: Envelope;

    if (exception instanceof AppError) {
      status = exception.status;
      body = {
        code: exception.code,
        message: exception.message,
        ...(exception.details ? { details: exception.details } : {}),
        request_id: requestId,
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      // Body đã ở dạng envelope (vd health 503) → giữ code/details, ép request_id
      if (typeof r === 'object' && r !== null && isErrorCode((r as { code?: unknown }).code)) {
        const e = r as { code: ErrorCode; message?: string; details?: Record<string, unknown> };
        body = {
          code: e.code,
          message: e.message ?? exception.message,
          ...(e.details ? { details: e.details } : {}),
          request_id: requestId,
        };
      } else {
        const code = codeForStatus(status);
        body = { code, message: status === 404 ? 'Không tìm thấy' : exception.message, request_id: requestId };
      }
    } else {
      status = ERROR_HTTP_STATUS.INTERNAL_ERROR;
      body = { code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống', request_id: requestId };
    }

    if (status >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.log.error({ err, request_id: requestId, method: req.method, url: req.originalUrl }, 'request lỗi 5xx');
    }
    if (!res.headersSent) res.status(status).json(body);
  }
}
