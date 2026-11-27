import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { ENV, type Env } from '../config/env';
import type { Tx } from './audit-outbox.service';
import { NO_AUDIT_KEY, OWN_TX_KEY } from './access';
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
  private readonly log = new Logger('MutationInterceptor');
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly cls: ClsService<RequestStore>,
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!MUTATING.has(req.method)) return next.handle();
    const noAudit = this.reflector.get<string | undefined>(NO_AUDIT_KEY, ctx.getHandler());
    // luồng tự quản transaction (lần sai phải được lưu dù request lỗi) — xem @OwnTransaction. Review cổng CP03 TB5: vẫn
    // phải để lại dấu vết — thành công mà không có dòng audit.logs NÀO và không có dòng audit.login_logs NÀO ⇒ lỗi lập
    // trình. Transaction đã commit (không rollback được) ⇒ dev/test: 500 để test đỏ; production: ghi log lỗi.
    if (this.reflector.get<string | undefined>(OWN_TX_KEY, ctx.getHandler())) {
      if (noAudit) return next.handle();
      return from(
        (async () => {
          const trace = { audit: 0, login: 0 };
          this.cls.set('ownTxTrace', trace);
          const result = await lastValueFrom(next.handle(), { defaultValue: undefined });
          if (trace.audit + trace.login === 0) {
            const msg = `Mutation @OwnTransaction ${req.method} ${req.route?.path ?? req.path} không ghi audit/login_logs`;
            // chỉ test/dev ném lỗi (mutation ĐÃ commit — staging/production trả 500 sẽ khiến client thử lại thao tác không
            // idempotent); staging/production ghi log lỗi
            if (this.env.NODE_ENV === 'test' || this.env.NODE_ENV === 'development') throw new Error(msg);
            this.log.error(msg);
          }
          return result;
        })(),
      );
    }
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
