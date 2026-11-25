import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import type { Principal } from './access';
import type { Tx } from './audit-outbox.service';
import { AppError } from './errors';
import type { RequestStore } from './request-context';
import { storeScope } from './store-scope';

export type StoreScope = 'ALL' | ReadonlySet<string>;

/**
 * Phạm vi cửa hàng của người gọi theo TỪNG mã quyền (`x-scope: store` — ADR-024). Một nguồn duy nhất cho mọi route
 * có phạm vi: vai trò/cấp riêng phạm vi ALL ⇒ 'ALL'; ngược lại tập cửa hàng của các dòng STORE mang mã đó. Nhân viên
 * đăng nhập trên máy POS: chỉ cửa hàng của thiết bị (giao với phạm vi theo vai trò) — cửa hàng trưởng của 2 cửa hàng
 * đứng ở máy cửa hàng A không thao tác được cửa hàng B. Kết quả nhớ trong request (CLS).
 */
@Injectable()
export class ScopeService {
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  private principal(): Principal {
    const p = this.cls.get('principal');
    if (!p) throw new AppError('AUTHENTICATION_REQUIRED', 'Cần đăng nhập');
    return p;
  }

  async stores(permission: string): Promise<StoreScope> {
    const p = this.principal();
    const cache = this.cls.get('scopeCache') ?? new Map<string, StoreScope>();
    const hit = cache.get(permission);
    if (hit) return hit;
    let s: StoreScope = p.permissions.has(permission)
      ? await storeScope(this.txHost.tx, p.userId, permission)
      : new Set();
    if (p.posStoreId) {
      const on = p.posStoreId;
      s = s === 'ALL' || s.has(on) ? new Set([on]) : new Set();
    }
    cache.set(permission, s);
    this.cls.set('scopeCache', cache);
    return s;
  }

  async has(permission: string, storeId: string): Promise<boolean> {
    const s = await this.stores(permission);
    return s === 'ALL' || s.has(storeId);
  }

  /** Ngoài phạm vi ⇒ lỗi do người gọi chọn (mặc định 404 — không lộ tài nguyên của cửa hàng khác tồn tại) */
  async assertStore(permission: string, storeId: string, err: () => AppError = notFound): Promise<void> {
    if (!(await this.has(permission, storeId))) throw err();
  }

  /** Mọi phạm vi ALL (Master hoặc vai trò toàn chuỗi) — dùng cho đối tượng không thuộc cửa hàng (kho, cấu hình). */
  async isAll(permission: string): Promise<boolean> {
    return (await this.stores(permission)) === 'ALL';
  }
}

const notFound = () => new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy');
