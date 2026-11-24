import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { toJsonSafe } from './json-safe';

/**
 * Response JSON: bigint (tiền) → chuỗi qua codec `toWire` (ADR-016, FR-INV-01). Không patch `BigInt.prototype.toJSON`.
 * Response KHÔNG tự che khóa bí mật (route tự chọn trường trả về); chỉ audit/outbox mới che.
 */
@Injectable()
export class SerializeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((v) => (v === undefined ? v : toJsonSafe(v, 'raw'))));
  }
}
