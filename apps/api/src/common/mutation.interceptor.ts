import { type CallHandler, type ExecutionContext, Inject, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { Tx } from './audit-outbox.service';
import { NO_AUDIT_KEY } from './access';
import type { RequestStore } from './request-context';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Mỗi request ghi (POST/PUT/PATCH/DELETE) chạy trong MỘT transaction app_rw (ADR-016): nghiệp vụ + audit + outbox
 * cùng commit hoặc cùng rollback. Handler kết thúc mà chưa ghi dòng audit nào ⇒ lỗi lập trình ⇒ rollback + 500
 * (kế hoạch CP03: "mọi mutation có dòng audit + outbox cùng transaction"). Ngoại lệ phải khai báo `@NoAudit(lý do)`.
 * Gọi dịch vụ ngoài KHÔNG được nằm trong handler mutation (làm sau commit — ADR-007).
 */
@Injectable()
export class MutationInterceptor implements NestInterceptor {
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly cls: ClsService<RequestStore>,
    private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!MUTATING.has(req.method)) return next.handle();
    const noAudit = this.reflector.get<string | undefined>(NO_AUDIT_KEY, ctx.getHandler());
    return from(
      this.txHost.withTransaction(async () => {
        this.cls.set('auditCount', 0);
        const result = await lastValueFrom(next.handle(), { defaultValue: undefined });
        if (!noAudit && (this.cls.get('auditCount') ?? 0) === 0)
          throw new Error(
            `Mutation ${req.method} ${req.route?.path ?? req.path} không ghi audit (thiếu recordAudit hoặc @NoAudit)`,
          );
        return result;
      }),
    );
  }
}
