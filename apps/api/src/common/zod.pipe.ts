import { Injectable, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { AppError } from './errors';

/**
 * Kiểm body/query/param bằng zod (strict: trường lạ ⇒ lỗi). Sai ⇒ 400 INVALID_REQUEST kèm danh sách lỗi theo đường
 * dẫn (không lặp lại giá trị người dùng gửi — có thể chứa dữ liệu nhạy cảm).
 */
@Injectable()
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const r = this.schema.safeParse(value);
    if (r.success) return r.data;
    throw new AppError('INVALID_REQUEST', 'Dữ liệu gửi lên không hợp lệ', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })),
    });
  }
}
