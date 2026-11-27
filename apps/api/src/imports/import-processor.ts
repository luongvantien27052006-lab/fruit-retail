import { Inject, Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import type { Principal } from '../common/access';
import { AuditOutboxService, type Tx } from '../common/audit-outbox.service';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { nameKey } from '../catalog/catalog-rules';
import { CatalogService } from '../catalog/catalog.service';
import { PricesService } from '../catalog/prices.service';
import { SkusService } from '../catalog/skus.service';
import type { Prisma } from '../generated/prisma/client';
import { ObjectStorage } from '../infra/object-storage.service';
import { SuppliersService } from '../org/suppliers.service';
import {
  CatalogRow,
  type CatalogRowT,
  columnsOf,
  type ImportType,
  rowIssues,
  SupplierRow,
  type SupplierRowT,
} from './import-columns';
import { readSheet, type SheetRow, XlsxRejected } from './xlsx-safe';

export type DupMode = 'SKIP' | 'UPDATE' | 'STOP';
export type RowStatus = 'CREATED' | 'UPDATED' | 'SKIPPED' | 'ERROR';
export interface ReportRow {
  row: number;
  status: RowStatus;
  /** mã SKU / mã NCC của dòng (không bao giờ SĐT / số tài khoản) */
  key?: string;
  /** trùng: cột bị trùng; lỗi: cột lỗi */
  field?: string;
  /** trùng với dòng nào trong file / bản ghi đã có */
  duplicate_of?: string;
  message?: string;
}

/** Quyết định cho một dòng sau bước phân loại (chưa ghi gì) */
type Plan<T> =
  | { row: number; kind: 'report'; report: ReportRow }
  | { row: number; kind: 'create'; key: string; v: T }
  | { row: number; kind: 'update'; key: string; id: string; v: T };

const MAX_FILE = 5 * 1024 * 1024;
/** mỗi lô một transaction (≤ 500 SAVEPOINT — tránh tràn subxact; giữ khóa ngắn) */
export const IMPORT_BATCH = 500;
const BATCH_TX = { timeout: 120_000, maxWait: 10_000 } as const;

/** Ném trong transaction của lô chạy thử để rollback mà vẫn giữ kết quả. */
class Rollback extends Error {
  constructor(readonly rows: ReportRow[]) {
    super('rollback');
  }
}

/** mỗi tiến trình chạy MỘT lượt nhập một lúc (exceljs nạp cả file vào bộ nhớ — review bảo mật lát 5 N1) */
let running: Promise<void> = Promise.resolve();

/**
 * Chạy một lượt nhập (CP04 lát 5, ADR-031) — gọi từ consumer worker (sự kiện `catalog.import_requested`) hoặc test.
 * 1. Giành lượt: PENDING → RUNNING (khóa dòng; không PENDING ⇒ bỏ qua — giao lại sự kiện không chạy hai lần).
 * 2. Ngoài transaction: tải file (≤ 5 MB), kiểm zip/xlsx, đọc dòng. File hỏng / độc ⇒ FAILED (lý do), không ghi gì.
 * 3. PHÂN LOẠI mọi dòng trước khi ghi (dữ liệu sai, trùng trong file, trùng bản ghi đã có) ⇒ chế độ STOP gặp trùng thì
 *    FAILED mà KHÔNG ghi dòng nào.
 * 4. Ghi theo LÔ 500 dòng, mỗi lô một transaction, mỗi dòng một SAVEPOINT (lỗi dòng chỉ hoàn tác dòng đó). Ghi qua CHÍNH
 *    service API (quy tắc kiểu bán, khóa, audit, lịch sử giá) với người thực hiện = người tạo lượt. Chạy thử: mỗi lô
 *    rollback. Chạy thật lỗi hệ thống giữa chừng ⇒ các lô trước đã ghi (báo trong `error`).
 */
@Injectable()
export class ImportProcessor {
  private readonly log = new Logger('ImportProcessor');

  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly cls: ClsService<RequestStore>,
    private readonly ao: AuditOutboxService,
    private readonly storage: ObjectStorage,
    private readonly catalog: CatalogService,
    private readonly skus: SkusService,
    private readonly prices: PricesService,
    private readonly suppliers: SuppliersService,
  ) {}

  private get tx() {
    return this.txHost.tx;
  }

  run(jobId: string): Promise<void> {
    const next = running.then(() => this.cls.run(() => this.runInContext(jobId)));
    running = next.catch(() => undefined);
    return next;
  }

  private async runInContext(jobId: string): Promise<void> {
    this.cls.set('requestId', jobId);
    this.cls.set('auditCount', 0);
    const job = await this.txHost.withTransaction(async () => {
      const [j] = await this.tx.$queryRaw<{ status: string }[]>`
        SELECT status::text FROM core.import_jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
      if (j?.status !== 'PENDING') return null;
      return this.tx.importJob.update({
        where: { id: jobId },
        data: { status: 'RUNNING' },
        include: { file: { select: { finalKey: true, status: true, kind: true } } },
      });
    });
    if (!job) return;
    let committedBatches = 0;
    try {
      const principal = await this.principalOf(job.createdBy);
      this.cls.set('principal', principal);
      if (job.file.status !== 'READY' || !job.file.finalKey || job.file.kind !== 'IMPORT_XLSX')
        return await this.fail(jobId, 'File nhập không còn dùng được');
      const type = job.type as ImportType;
      let rows: SheetRow[];
      try {
        const buf = await this.storage.read(job.file.finalKey, MAX_FILE);
        const keys = columnsOf(type).map((c) => c.key);
        const sheet = await readSheet(buf, keys);
        const missing = columnsOf(type).filter((c) => c.required && sheet.missing.includes(c.key));
        if (missing.length)
          return await this.fail(
            jobId,
            `Thiếu cột bắt buộc: ${missing.map((c) => `${c.label} (${c.key})`).join(', ')}`,
          );
        rows = sheet.rows;
      } catch (e) {
        if (e instanceof XlsxRejected) return await this.fail(jobId, `File bị từ chối: ${e.message}`, e.reason);
        if (e instanceof AppError) return await this.fail(jobId, e.message);
        throw e;
      }
      const mode = job.modeOnDuplicate as DupMode;
      const plans = type === 'CATALOG' ? await this.planCatalog(rows, mode) : await this.planSupplier(rows, mode);
      // STOP: gặp trùng ⇒ dừng TRƯỚC khi ghi bất cứ gì
      const stop = mode === 'STOP' ? plans.find((p) => p.kind === 'report' && p.report.duplicate_of) : undefined;
      if (stop) {
        const report = plans.flatMap((p) => (p.kind === 'report' ? [p.report] : []));
        return await this.txHost.withTransaction(() =>
          this.finish(jobId, rows.length, report, job.dryRun, mode, stop.row),
        );
      }
      const out: ReportRow[] = [];
      const caches = { cats: new Map<string, string>(), prods: new Map<string, string>() };
      for (let i = 0; i < plans.length; i += IMPORT_BATCH) {
        const batch = plans.slice(i, i + IMPORT_BATCH);
        // chạy thử: id danh mục / sản phẩm của lô trước đã hoàn tác ⇒ bỏ bộ nhớ đệm
        if (job.dryRun) {
          caches.cats.clear();
          caches.prods.clear();
        }
        try {
          const res = await this.txHost.withTransaction(BATCH_TX, async () => {
            const r = await this.runBatch(type, batch, caches, jobId);
            if (job.dryRun) throw new Rollback(r);
            return r;
          });
          out.push(...res);
          committedBatches++;
        } catch (e) {
          if (!(e instanceof Rollback)) throw e;
          out.push(...e.rows);
        }
      }
      await this.txHost.withTransaction(() => this.finish(jobId, rows.length, out, job.dryRun, mode));
    } catch (e) {
      if (e instanceof AppError && e.code === 'ACTION_FORBIDDEN') {
        await this.fail(jobId, e.message).catch(() => undefined);
        return;
      }
      // lỗi hệ thống (DB / S3…) ⇒ FAILED (không để RUNNING mãi); không ném tiếp — thử lại phải tạo lượt mới.
      // Chỉ log tên / mã lỗi (thông điệp lỗi DB có thể mang giá trị dòng)
      this.log.error({ err: errName(e), jobId }, 'nhập file lỗi');
      const partial = committedBatches
        ? ` — ${committedBatches * IMPORT_BATCH} dòng đầu (${committedBatches} lô) ĐÃ ghi; kiểm tra rồi nhập lại phần còn lại`
        : '';
      await this.fail(jobId, `Lỗi hệ thống khi nhập${partial}`).catch((err: unknown) =>
        this.log.error({ err: errName(err), jobId }, 'không ghi được FAILED'),
      );
    }
  }

  /** Người thực hiện = người tạo lượt; phải còn là Master đang hoạt động có `import:run` (kiểm một lần lúc bắt đầu). */
  private async principalOf(userId: string): Promise<Principal> {
    const u = await this.tx.user.findUnique({ where: { id: userId }, select: { type: true, status: true } });
    const roles = await this.tx.userRoleAssignment.findMany({
      where: { userId, revokedAt: null },
      select: { role: true },
    });
    const roleList = [...new Set(roles.map((r) => r.role))].sort();
    const [fromRoles, grants] = await Promise.all([
      roleList.length
        ? this.tx.rolePermission.findMany({ where: { role: { in: roleList } }, select: { permissionCode: true } })
        : Promise.resolve([]),
      this.tx.userPermissionGrant.findMany({ where: { userId, revokedAt: null }, select: { permissionCode: true } }),
    ]);
    const permissions = new Set([...fromRoles, ...grants].map((x) => x.permissionCode));
    if (u?.type !== 'MASTER' || u.status !== 'ACTIVE' || !permissions.has('import:run'))
      throw new AppError('ACTION_FORBIDDEN', 'Người tạo lượt nhập không còn quyền');
    return {
      userId,
      userType: 'MASTER',
      sessionId: '',
      permissions,
      roles: new Set(roleList),
      ...(roleList[0] ? { role: roleList[0] } : {}),
      amr: [],
      mfaComplete: true,
    };
  }

  private async fail(jobId: string, error: string, reason?: string): Promise<void> {
    await this.txHost.withTransaction(async () => {
      await this.tx.importJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', error: error.slice(0, 2000), report: reason ? { reason } : undefined },
        select: { id: true },
      });
      await this.ao.recordAudit({
        action: 'import.fail',
        resourceType: 'import_job',
        resourceId: jobId,
        after: { error: error.slice(0, 300), ...(reason ? { reason } : {}) },
      });
    });
  }

  private async finish(
    jobId: string,
    total: number,
    rows: ReportRow[],
    dryRun: boolean,
    mode: DupMode,
    stoppedAt?: number,
  ) {
    const n = (s: RowStatus) => rows.filter((r) => r.status === s).length;
    const stopped = stoppedAt !== undefined;
    const counts = {
      totalRows: total,
      okRows: stopped ? 0 : n('CREATED') + n('UPDATED'),
      skippedRows: stopped ? 0 : n('SKIPPED'),
      errorRows: stopped ? 0 : n('ERROR'),
    };
    const report: Prisma.InputJsonObject = {
      dry_run: dryRun,
      mode,
      created: n('CREATED'),
      updated: n('UPDATED'),
      skipped: n('SKIPPED'),
      errors: n('ERROR'),
      ...(stopped ? { stopped_at_row: stoppedAt } : {}),
      rows: rows.sort((a, b) => a.row - b.row) as unknown as Prisma.InputJsonArray,
    };
    await this.tx.importJob.update({
      where: { id: jobId },
      data: stopped
        ? {
            status: 'FAILED',
            error: `Dừng do trùng ở dòng ${stoppedAt} (chế độ STOP) — không nhập dòng nào`,
            report,
            ...counts,
          }
        : { status: 'COMPLETED', report, ...counts },
      select: { id: true },
    });
    await this.ao.recordAudit({
      action: stopped ? 'import.fail' : dryRun ? 'import.dry_run' : 'import.complete',
      resourceType: 'import_job',
      resourceId: jobId,
      after: { ...counts, created: n('CREATED'), updated: n('UPDATED'), dry_run: dryRun, mode },
    });
  }

  private rowError(row: number, key: string | undefined, e: unknown): ReportRow {
    if (e instanceof AppError) {
      const field = typeof e.details?.['field'] === 'string' ? e.details['field'] : undefined;
      return {
        row,
        status: 'ERROR',
        ...(key ? { key } : {}),
        ...(field ? { field } : {}),
        message: e.message.slice(0, 300),
      };
    }
    this.log.warn({ err: errName(e), row }, 'dòng nhập lỗi không xác định');
    return { row, status: 'ERROR', ...(key ? { key } : {}), message: 'Lỗi không xác định khi ghi dòng này' };
  }

  /** Ghi một lô: mỗi dòng một SAVEPOINT; dòng lỗi ⇒ hoàn tác dòng đó + khôi phục bộ nhớ đệm danh mục / sản phẩm. */
  private async runBatch(
    type: ImportType,
    batch: Plan<CatalogRowT | SupplierRowT>[],
    caches: { cats: Map<string, string>; prods: Map<string, string> },
    jobId: string,
  ): Promise<ReportRow[]> {
    const out: ReportRow[] = [];
    const reason = `Nhập file Excel (lượt ${jobId})`;
    for (const p of batch) {
      if (p.kind === 'report') {
        out.push(p.report);
        continue;
      }
      const cats = new Map(caches.cats);
      const prods = new Map(caches.prods);
      await this.tx.$executeRawUnsafe('SAVEPOINT import_row');
      try {
        if (type === 'CATALOG') {
          const v = p.v as CatalogRowT;
          if (p.kind === 'create') await this.createSku(v, caches, reason);
          else await this.updateSku(p.id, v, caches, reason);
        } else {
          const v = p.v as SupplierRowT;
          if (p.kind === 'create')
            await this.suppliers.create({ code: v.code, ...supplierFields(v), name: v.name, type: v.type });
          else await this.suppliers.update(p.id, supplierFields(v));
        }
        await this.tx.$executeRawUnsafe('RELEASE SAVEPOINT import_row');
        out.push({ row: p.row, status: p.kind === 'create' ? 'CREATED' : 'UPDATED', key: p.key });
      } catch (e) {
        await this.tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT import_row');
        // id danh mục / sản phẩm tạo trong savepoint đã bị hoàn tác (review TS lát 5 C3)
        caches.cats = cats;
        caches.prods = prods;
        out.push(this.rowError(p.row, p.key, e));
      }
    }
    return out;
  }

  // ───────── phân loại ─────────

  private parseError(row: number, e: import('zod').ZodError): Plan<never> {
    const issues = rowIssues(e);
    return {
      row,
      kind: 'report',
      report: {
        row,
        status: 'ERROR',
        ...(issues[0]?.field ? { field: issues[0].field } : {}),
        message: issues.map((i) => `${i.field}: ${i.message}`).join('; '),
      },
    };
  }

  /**
   * Danh mục: trùng = mã SKU / PLU / mã vạch đã có (kể cả lưu trữ) hoặc đã xuất hiện ở dòng TRƯỚC trong file (dòng đó dù
   * lỗi hay bỏ qua vẫn "chiếm" khóa — quy ước ADR-031). UPDATE chỉ khi trùng ĐÚNG mã SKU của chính nó.
   */
  private async planCatalog(rows: SheetRow[], mode: DupMode): Promise<Plan<CatalogRowT>[]> {
    const parsed = rows.map((r) => ({ row: r.row, p: CatalogRow.safeParse(r.values) }));
    const ok = parsed.flatMap((x) => (x.p.success ? [x.p.data] : []));
    const codes = ok.map((v) => v.sku_code);
    const plus = ok.flatMap((v) => (v.scale_plu ? [v.scale_plu] : []));
    const barcodes = ok.flatMap((v) => (v.barcode ? [v.barcode] : []));
    const [bySku, byPlu, byBarcode] = await Promise.all([
      this.tx.sku.findMany({ where: { skuCode: { in: codes } }, select: { id: true, skuCode: true } }),
      plus.length
        ? this.tx.sku.findMany({ where: { scalePlu: { in: plus } }, select: { skuCode: true, scalePlu: true } })
        : Promise.resolve([]),
      barcodes.length
        ? this.tx.skuUnit.findMany({
            where: { barcode: { in: barcodes } },
            select: { barcode: true, sku: { select: { skuCode: true } } },
          })
        : Promise.resolve([]),
    ]);
    const skuId = new Map(bySku.map((s) => [s.skuCode, s.id]));
    const pluOwner = new Map(byPlu.map((s) => [s.scalePlu as string, s.skuCode]));
    const barcodeOwner = new Map(byBarcode.map((u) => [u.barcode as string, u.sku.skuCode]));
    const firstRow = new Map<string, number>();
    return parsed.map(({ row, p }): Plan<CatalogRowT> => {
      if (!p.success) return this.parseError(row, p.error);
      const v = p.data;
      const keys = [
        ['sku_code', v.sku_code],
        ['scale_plu', v.scale_plu],
        ['barcode', v.barcode],
      ] as const;
      const inFile = keys.find(([f, x]) => x !== undefined && firstRow.has(`${f}:${x}`));
      const inFileOf = inFile ? firstRow.get(`${inFile[0]}:${inFile[1]}`) : undefined;
      for (const [f, x] of keys) if (x !== undefined && !firstRow.has(`${f}:${x}`)) firstRow.set(`${f}:${x}`, row);
      const existing = skuId.get(v.sku_code);
      const pluOther = v.scale_plu ? pluOwner.get(v.scale_plu) : undefined;
      const barOther = v.barcode ? barcodeOwner.get(v.barcode) : undefined;
      const dupOther =
        pluOther && pluOther !== v.sku_code
          ? (['scale_plu', pluOther] as const)
          : barOther && barOther !== v.sku_code
            ? (['barcode', barOther] as const)
            : undefined;
      const dup = inFile
        ? { field: inFile[0], of: `dòng ${inFileOf}` }
        : dupOther
          ? { field: dupOther[0], of: `SKU ${dupOther[1]}` }
          : existing
            ? { field: 'sku_code', of: `SKU ${v.sku_code}` }
            : undefined;
      if (!dup) return { row, kind: 'create', key: v.sku_code, v };
      if (mode === 'UPDATE' && !inFile && !dupOther && existing)
        return { row, kind: 'update', key: v.sku_code, id: existing, v };
      return {
        row,
        kind: 'report',
        report:
          mode === 'UPDATE'
            ? {
                row,
                status: 'ERROR',
                key: v.sku_code,
                field: dup.field,
                duplicate_of: dup.of,
                message: 'Trùng với dòng / SKU khác — không cập nhật được',
              }
            : { row, status: 'SKIPPED', key: v.sku_code, field: dup.field, duplicate_of: dup.of, message: 'Trùng' },
      };
    });
  }

  private async planSupplier(rows: SheetRow[], mode: DupMode): Promise<Plan<SupplierRowT>[]> {
    const parsed = rows.map((r) => ({ row: r.row, p: SupplierRow.safeParse(r.values) }));
    const codes = parsed.flatMap((x) => (x.p.success ? [x.p.data.code] : []));
    const existing = new Map(
      (await this.tx.supplier.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } })).map(
        (s) => [s.code, s.id],
      ),
    );
    const firstRow = new Map<string, number>();
    return parsed.map(({ row, p }): Plan<SupplierRowT> => {
      if (!p.success) return this.parseError(row, p.error);
      const v = p.data;
      const prev = firstRow.get(v.code);
      if (prev === undefined) firstRow.set(v.code, row);
      const id = existing.get(v.code);
      if (prev === undefined && !id) return { row, kind: 'create', key: v.code, v };
      if (mode === 'UPDATE' && prev === undefined && id) return { row, kind: 'update', key: v.code, id, v };
      const of = prev !== undefined ? `dòng ${prev}` : `NCC ${v.code}`;
      return {
        row,
        kind: 'report',
        report:
          mode === 'UPDATE'
            ? {
                row,
                status: 'ERROR',
                key: v.code,
                field: 'code',
                duplicate_of: of,
                message: 'Trùng dòng khác trong file',
              }
            : { row, status: 'SKIPPED', key: v.code, field: 'code', duplicate_of: of, message: 'Trùng' },
      };
    });
  }

  // ───────── ghi danh mục ─────────

  /** danh mục theo đường dẫn — tìm theo tên (giống btrim/lower) dưới cha, chưa có thì tạo; lưu trữ ⇒ lỗi dòng */
  private async categoryOf(path: string[], cats: Map<string, string>): Promise<string> {
    let parent: string | null = null;
    let key = '';
    for (const name of path) {
      key += `>${nameKey(name)}`;
      const hit = cats.get(key);
      if (hit) {
        parent = hit;
        continue;
      }
      const sibs: { id: string; name: string; archivedAt: Date | null }[] = await this.tx.category.findMany({
        where: { parentId: parent },
        select: { id: true, name: true, archivedAt: true },
      });
      const found = sibs.find((c) => nameKey(c.name) === nameKey(name));
      if (found?.archivedAt)
        throw new AppError('CATALOG_RULE_VIOLATION', `Danh mục "${name}" đã lưu trữ`, { field: 'category' });
      const id: string = found?.id ?? (await this.catalog.createCategory({ parent_id: parent, name })).id;
      cats.set(key, id);
      parent = id;
    }
    return parent as string;
  }

  private async productOf(categoryId: string, name: string, prods: Map<string, string>): Promise<string> {
    const key = `${categoryId}>${nameKey(name)}`;
    const hit = prods.get(key);
    if (hit) return hit;
    const list = await this.tx.product.findMany({
      where: { categoryId, archivedAt: null },
      select: { id: true, name: true },
    });
    const id =
      list.find((p) => nameKey(p.name) === nameKey(name))?.id ??
      (await this.catalog.createProduct({ category_id: categoryId, name })).id;
    prods.set(key, id);
    return id;
  }

  private async createSku(
    v: CatalogRowT,
    c: { cats: Map<string, string>; prods: Map<string, string> },
    reason: string,
  ) {
    const productId = await this.productOf(await this.categoryOf(v.category, c.cats), v.product, c.prods);
    const s = await this.skus.create({
      product_id: productId,
      sku_code: v.sku_code,
      sale_unit_type: v.sale_unit_type,
      ...attrs(v),
      ...(v.barcode ? { barcode: v.barcode } : {}),
    });
    if (v.retail_price !== undefined)
      await this.prices.set(s.id, { version: s.version, global: v.retail_price }, reason);
  }

  private async updateSku(
    id: string,
    v: CatalogRowT,
    c: { cats: Map<string, string>; prods: Map<string, string> },
    reason: string,
  ) {
    const cur = await this.tx.sku.findUniqueOrThrow({
      where: { id },
      select: {
        version: true,
        saleUnitType: true,
        retailPricePerKg: true,
        retailPricePerUnit: true,
        // đơn vị gốc = đơn vị tạo cùng SKU (UUIDv7 nhỏ nhất)
        units: { orderBy: { id: 'asc' }, take: 1, select: { id: true, barcode: true } },
      },
    });
    if (cur.saleUnitType !== v.sale_unit_type)
      throw new AppError('CATALOG_RULE_VIOLATION', 'Kiểu bán không đổi được — lưu trữ SKU cũ và tạo mã mới', {
        field: 'sale_unit_type',
      });
    const productId = await this.productOf(await this.categoryOf(v.category, c.cats), v.product, c.prods);
    await this.skus.update(id, { version: cur.version, product_id: productId, ...attrs(v) });
    // mã vạch đơn vị gốc: ô có giá trị khác hiện tại ⇒ đổi (review TS lát 5: xuất → sửa → nhập lại)
    const base = cur.units[0];
    if (base && v.barcode !== undefined && v.barcode !== base.barcode)
      await this.skus.updateUnit(id, base.id, { barcode: v.barcode });
    const price = cur.retailPricePerKg ?? cur.retailPricePerUnit;
    if (v.retail_price !== undefined && v.retail_price !== price) {
      const after = await this.tx.sku.findUniqueOrThrow({ where: { id }, select: { version: true } });
      await this.prices.set(id, { version: after.version, global: v.retail_price }, reason);
    }
  }
}

function attrs(v: CatalogRowT) {
  return {
    name: v.name,
    std_weight_g: v.std_weight_g,
    weight_min_g: v.weight_min_g,
    weight_max_g: v.weight_max_g,
    tare_g: v.tare_g,
    scale_plu: v.scale_plu,
    sold_by_scale: v.sold_by_scale,
    shelf_life_days: v.shelf_life_days,
    has_ripeness: v.has_ripeness,
    is_high_value: v.is_high_value,
    cold_required: v.cold_required,
  };
}

/** ô trống = không đổi (cập nhật) / không có (tạo) */
function supplierFields(v: SupplierRowT) {
  return {
    name: v.name,
    type: v.type,
    ...(v.contact_name ? { contact_name: v.contact_name } : {}),
    ...(v.phone ? { phone: v.phone } : {}),
    ...(v.bank_name ? { bank_name: v.bank_name } : {}),
    ...(v.account_number && v.account_holder
      ? { bank_account: { account_number: v.account_number, account_holder: v.account_holder } }
      : {}),
    ...(v.payment_terms_days !== undefined ? { payment_terms_days: v.payment_terms_days } : {}),
    ...(v.note ? { note: v.note } : {}),
  };
}

/** tên / mã lỗi để log — không log thông điệp (lỗi DB có thể mang giá trị dòng) */
function errName(e: unknown): string {
  if (e instanceof AppError) return e.code;
  const x = e as { name?: string; code?: unknown };
  return `${x?.name ?? 'Error'}${typeof x?.code === 'string' ? ` ${x.code}` : ''}`;
}
