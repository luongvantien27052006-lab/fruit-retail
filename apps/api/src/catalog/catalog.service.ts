import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { v7 as uuidv7 } from 'uuid';
import { AuditOutboxService, type Tx } from '../common/audit-outbox.service';
import { AppError } from '../common/errors';
import { catalogWrite } from './catalog-db';
import { rule } from './catalog-rules';
import { categoryWire, productWire, unitWire } from './catalog-wire';

/** Đơn vị gốc mặc định của SKU (catalog-rules.baseUnitFor) — lưu trữ sẽ chặn tạo SKU mới ⇒ không cho lưu trữ. */
const BASE_UNIT_CODES = new Set(['KG', 'PIECE', 'PACK', 'BASKET', 'SERVICE']);

const archivedAt = (archived: boolean | undefined, current: Date | null): Date | null | undefined =>
  archived === undefined ? undefined : archived ? (current ?? new Date()) : null;

export interface UnitCreate {
  code: string;
  name: string;
  kind: 'WEIGHT' | 'COUNT';
  fixed_g?: number | null;
}
export interface CategoryCreate {
  parent_id?: string | null;
  name: string;
  sort?: number;
}
export interface CategoryUpdate {
  parent_id?: string | null;
  name?: string;
  sort?: number;
  archived?: boolean;
}
export interface ProductCreate {
  category_id: string;
  name: string;
  description?: string | null;
  origin?: string | null;
}
export interface ProductUpdate {
  category_id?: string;
  name?: string;
  description?: string | null;
  origin?: string | null;
  archived?: boolean;
}

/**
 * Đơn vị tính, cây danh mục, sản phẩm (CP04 lát 2, §4.1, §21.3.1). Không xóa — chỉ lưu trữ (`archived`); gắn con vào
 * cha đã lưu trữ hoặc lưu trữ cha còn con đang dùng ⇒ 422. Khóa: cha `FOR SHARE` khi gắn con, chính nó `FOR UPDATE` khi
 * sửa/lưu trữ ⇒ "lưu trữ cha" và "gắn con" song song không lọt (READ COMMITTED đọc lại bản mới sau khi chờ khóa).
 */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly ao: AuditOutboxService,
  ) {}

  private get tx() {
    return this.txHost.tx;
  }

  // ───────── đơn vị tính ─────────

  async listUnits(includeArchived: boolean) {
    const rows = await this.tx.unit.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: { code: 'asc' },
    });
    return { items: rows.map(unitWire) };
  }

  async getUnit(code: string) {
    const u = await this.tx.unit.findUnique({ where: { code } });
    if (!u) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy đơn vị tính');
    return unitWire(u);
  }

  async createUnit(b: UnitCreate) {
    const fixed = b.fixed_g ?? null;
    if ((b.kind === 'WEIGHT') !== (fixed !== null))
      throw rule('Đơn vị khối lượng phải có fixed_g (số gram); đơn vị đếm thì không', { field: 'fixed_g' });
    const u = await catalogWrite(() =>
      this.tx.unit.create({ data: { code: b.code, name: b.name, kind: b.kind, fixedG: fixed } }),
    );
    await this.ao.recordAudit({
      action: 'unit.create',
      resourceType: 'unit',
      resourceId: u.code,
      after: unitWire(u),
    });
    return unitWire(u);
  }

  async updateUnit(code: string, b: { name?: string; archived?: boolean }) {
    const locked = await this.tx.$queryRaw<{ code: string }[]>`
      SELECT code FROM core.units WHERE code = ${code} FOR UPDATE`;
    if (!locked.length) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy đơn vị tính');
    const before = await this.tx.unit.findUniqueOrThrow({ where: { code } });
    if (b.archived && BASE_UNIT_CODES.has(code))
      throw rule(`Đơn vị ${code} là đơn vị gốc mặc định của SKU — không lưu trữ`, { field: 'archived' });
    const u = await catalogWrite(() =>
      this.tx.unit.update({
        where: { code },
        data: { name: b.name, archivedAt: archivedAt(b.archived, before.archivedAt) },
      }),
    );
    await this.ao.recordAudit({
      action: 'unit.update',
      resourceType: 'unit',
      resourceId: code,
      before: unitWire(before),
      after: unitWire(u),
    });
    return unitWire(u);
  }

  // ───────── danh mục ─────────

  async listCategories(includeArchived: boolean) {
    const rows = await this.tx.category.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: [{ sort: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(categoryWire) };
  }

  async getCategory(id: string) {
    const c = await this.tx.category.findUnique({ where: { id } });
    if (!c) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy danh mục');
    return categoryWire(c);
  }

  /** Khóa chia sẻ một danh mục đang dùng (làm cha / chứa sản phẩm) — chặn lưu trữ song song. */
  private async shareActiveCategory(id: string, field: string): Promise<void> {
    const r = await this.tx.$queryRaw<{ archived: boolean }[]>`
      SELECT archived_at IS NOT NULL AS archived FROM core.categories WHERE id = ${id}::uuid FOR SHARE`;
    if (!r.length) throw rule('Danh mục không tồn tại', { field });
    if (r[0]?.archived) throw rule('Danh mục đã lưu trữ — không gắn thêm vào', { field });
  }

  async createCategory(b: CategoryCreate) {
    if (b.parent_id) await this.shareActiveCategory(b.parent_id, 'parent_id');
    const c = await catalogWrite(() =>
      this.tx.category.create({
        data: { id: uuidv7(), parentId: b.parent_id ?? null, name: b.name, sort: b.sort ?? 0 },
      }),
    );
    await this.ao.recordAudit({
      action: 'category.create',
      resourceType: 'category',
      resourceId: c.id,
      after: categoryWire(c),
    });
    return categoryWire(c);
  }

  async updateCategory(id: string, b: CategoryUpdate) {
    const locked = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM core.categories WHERE id = ${id}::uuid FOR UPDATE`;
    if (!locked.length) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy danh mục');
    const before = await this.tx.category.findUniqueOrThrow({ where: { id } });
    const parentId = b.parent_id === undefined ? before.parentId : b.parent_id;
    const willBeActive = b.archived === undefined ? before.archivedAt === null : !b.archived;
    // cha mới, hoặc mở lại khi cha cũ đã lưu trữ ⇒ cha phải đang dùng
    if (parentId && willBeActive && (parentId !== before.parentId || before.archivedAt !== null))
      await this.shareActiveCategory(parentId, 'parent_id');
    if (b.archived === true && before.archivedAt === null) {
      const [n] = await this.tx.$queryRaw<{ children: number; products: number }[]>`
        SELECT (SELECT count(*)::int FROM core.categories WHERE parent_id = ${id}::uuid AND archived_at IS NULL) AS children,
               (SELECT count(*)::int FROM core.products WHERE category_id = ${id}::uuid AND archived_at IS NULL) AS products`;
      if (n && (n.children > 0 || n.products > 0))
        throw rule('Danh mục còn danh mục con / sản phẩm đang dùng — lưu trữ chúng trước', {
          active_children: n.children,
          active_products: n.products,
        });
    }
    const c = await catalogWrite(() =>
      this.tx.category.update({
        where: { id },
        data: {
          parentId: b.parent_id,
          name: b.name,
          sort: b.sort,
          archivedAt: archivedAt(b.archived, before.archivedAt),
        },
      }),
    );
    await this.ao.recordAudit({
      action: 'category.update',
      resourceType: 'category',
      resourceId: id,
      before: categoryWire(before),
      after: categoryWire(c),
    });
    return categoryWire(c);
  }

  // ───────── sản phẩm ─────────

  async listProducts(q: { category_id?: string; include_archived: boolean; q?: string }) {
    const rows = await this.tx.product.findMany({
      where: {
        ...(q.include_archived ? {} : { archivedAt: null }),
        ...(q.category_id ? { categoryId: q.category_id } : {}),
        ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 1000,
    });
    return { items: rows.map(productWire) };
  }

  async getProduct(id: string) {
    const p = await this.tx.product.findUnique({ where: { id } });
    if (!p) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy sản phẩm');
    return productWire(p);
  }

  async createProduct(b: ProductCreate) {
    await this.shareActiveCategory(b.category_id, 'category_id');
    const p = await catalogWrite(() =>
      this.tx.product.create({
        data: {
          id: uuidv7(),
          categoryId: b.category_id,
          name: b.name,
          description: b.description ?? null,
          origin: b.origin ?? null,
        },
      }),
    );
    await this.ao.recordAudit({
      action: 'product.create',
      resourceType: 'product',
      resourceId: p.id,
      after: productWire(p),
    });
    return productWire(p);
  }

  async updateProduct(id: string, b: ProductUpdate) {
    const locked = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM core.products WHERE id = ${id}::uuid FOR UPDATE`;
    if (!locked.length) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy sản phẩm');
    const before = await this.tx.product.findUniqueOrThrow({ where: { id } });
    const categoryId = b.category_id ?? before.categoryId;
    const willBeActive = b.archived === undefined ? before.archivedAt === null : !b.archived;
    if (willBeActive && (categoryId !== before.categoryId || before.archivedAt !== null))
      await this.shareActiveCategory(categoryId, 'category_id');
    if (b.archived === true && before.archivedAt === null) {
      const [n] = await this.tx.$queryRaw<{ skus: number }[]>`
        SELECT count(*)::int AS skus FROM core.skus WHERE product_id = ${id}::uuid AND archived_at IS NULL`;
      if (n && n.skus > 0) throw rule('Sản phẩm còn SKU đang dùng — lưu trữ SKU trước', { active_skus: n.skus });
    }
    const p = await catalogWrite(() =>
      this.tx.product.update({
        where: { id },
        data: {
          categoryId: b.category_id,
          name: b.name,
          description: b.description,
          origin: b.origin,
          archivedAt: archivedAt(b.archived, before.archivedAt),
        },
      }),
    );
    await this.ao.recordAudit({
      action: 'product.update',
      resourceType: 'product',
      resourceId: id,
      before: productWire(before),
      after: productWire(p),
    });
    return productWire(p);
  }
}
