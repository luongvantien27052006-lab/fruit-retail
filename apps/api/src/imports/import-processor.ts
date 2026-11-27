import { Inject, Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import type { Principal } from '../common/access';
import { AuditOutboxService, type Tx } from '../common/audit-outbox.service';
import { AppError } from '../common/errors';
import type { Prisma } from '../generated/prisma/client';
import type { RequestStore } from '../common/request-context';
import { nameKey } from '../catalog/catalog-rules';
import { CatalogService } from '../catalog/catalog.service';
import { PricesService } from '../catalog/prices.service';
import { SkusService } from '../catalog/skus.service';
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
interface Outcome {
  rows: ReportRow[];
  stoppedAt?: number;
}

const MAX_FILE = 5 * 1024 * 1024;
/** transaction nhập: tối đa 4 phút (5.000 dòng); consumer worker cho 10 phút */
const IMPORT_TX = { timeout: 240_000, maxWait: 10_000 } as const;

/** Ném trong transaction để rollback (chạy thử / dừng khi trùng) mà vẫn giữ báo cáo. */
class Rollback extends Error {
  constructor(readonly outcome: Outcome) {
    super('rollback');
  }
}

/**
 * Chạy một lượt nhập (CP04 lát 5, ADR-031) — gọi từ consumer worker (sự kiện `catalog.import_requested`) hoặc test.
 * 1. Giành lượt: PENDING → RUNNING (khóa dòng; không PENDING ⇒ bỏ qua — giao lại sự kiện không chạy hai lần).
 * 2. Ngoài transaction: tải file (≤ 5 MB), kiểm zip/xlsx, đọc dòng. File hỏng / độc ⇒ FAILED (lý do), không ghi gì.
 * 3. MỘT transaction: mỗi dòng một SAVEPOINT — lỗi dòng chỉ hoàn tác dòng đó. Ghi qua CHÍNH service API (quy tắc kiểu bán,
 *    khóa, audit từng bản ghi, lịch sử giá) với người thực hiện = người tạo lượt. Chạy thử / dừng khi trùng ⇒ rollback cả
 *    transaction, lưu báo cáo ở transaction riêng.
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
    return this.cls.run(() => this.runInContext(jobId));
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
      try {
        await this.txHost.withTransaction(IMPORT_TX, async () => {
          const out =
            type === 'CATALOG' ? await this.catalogRows(rows, mode, jobId) : await this.supplierRows(rows, mode);
          if (job.dryRun || out.stoppedAt !== undefined) throw new Rollback(out);
          await this.finish(jobId, rows.length, out, false, mode);
        });
      } catch (e) {
        if (!(e instanceof Rollback)) throw e;
        await this.txHost.withTransaction(() => this.finish(jobId, rows.length, e.outcome, job.dryRun, mode));
      }
    } catch (e) {
      if (e instanceof AppError && e.code === 'ACTION_FORBIDDEN') {
        await this.fail(jobId, e.message).catch(() => undefined);
        return;
      }
      // lỗi hệ thống (DB / S3…) ⇒ FAILED (không để RUNNING mãi); không ném tiếp — thử lại cả lượt phải tạo lượt mới
      this.log.error({ err: e instanceof Error ? e.message : String(e), jobId }, 'nhập file lỗi');
      await this.fail(jobId, 'Lỗi hệ thống khi nhập — tạo lượt nhập mới để thử lại').catch((err: unknown) =>
        this.log.error({ err: err instanceof Error ? err.message : String(err), jobId }, 'không ghi được FAILED'),
      );
    }
  }

  /** Người thực hiện = người tạo lượt; phải còn là Master đang hoạt động có `import:run`. */
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

  private async finish(jobId: string, total: number, out: Outcome, dryRun: boolean, mode: DupMode) {
    const n = (s: RowStatus) => out.rows.filter((r) => r.status === s).length;
    const stopped = out.stoppedAt !== undefined;
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
      ...(stopped ? { stopped_at_row: out.stoppedAt } : {}),
      rows: out.rows as unknown as Prisma.InputJsonArray,
    };
    await this.tx.importJob.update({
      where: { id: jobId },
      data: stopped
        ? {
            status: 'FAILED',
            error: `Dừng do trùng ở dòng ${out.stoppedAt} (chế độ STOP) — không nhập dòng nào`,
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

  /** Chạy một dòng trong SAVEPOINT — lỗi ⇒ hoàn tác riêng dòng đó, transaction vẫn dùng tiếp. */
  private async inSavepoint<T>(fn: () => Promise<T>): Promise<T> {
    await this.tx.$executeRawUnsafe('SAVEPOINT import_row');
    try {
      const r = await fn();
      await this.tx.$executeRawUnsafe('RELEASE SAVEPOINT import_row');
      return r;
    } catch (e) {
      await this.tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT import_row');
      throw e;
    }
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
    this.log.warn({ err: e instanceof Error ? e.message : String(e), row }, 'dòng nhập lỗi không xác định');
    return { row, status: 'ERROR', ...(key ? { key } : {}), message: 'Lỗi không xác định khi ghi dòng này' };
  }

  // ───────── danh mục ─────────

  private async catalogRows(rows: SheetRow[], mode: DupMode, jobId: string): Promise<Outcome> {
    const parsed = rows.map((r) => ({ row: r.row, p: CatalogRow.safeParse(r.values) }));
    const ok = parsed.flatMap((x) => (x.p.success ? [{ row: x.row, v: x.p.data }] : []));
    // bản ghi đã có (kể cả lưu trữ — mã / PLU / mã vạch không dùng lại)
    const codes = ok.map((x) => x.v.sku_code);
    const plus = ok.flatMap((x) => (x.v.scale_plu ? [x.v.scale_plu] : []));
    const barcodes = ok.flatMap((x) => (x.v.barcode ? [x.v.barcode] : []));
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
    const cats = new Map<string, string>();
    const prods = new Map<string, string>();
    const reason = `Nhập file Excel (lượt ${jobId})`;
    const out: ReportRow[] = [];

    for (const { row, p } of parsed) {
      if (!p.success) {
        const issues = rowIssues(p.error);
        out.push({
          row,
          status: 'ERROR',
          ...(issues[0]?.field ? { field: issues[0].field } : {}),
          message: issues.map((i) => `${i.field}: ${i.message}`).join('; '),
        });
        continue;
      }
      const v = p.data;
      // trùng trong file (dòng sau trùng dòng trước) / trùng bản ghi đã có
      const inFile = (
        [
          ['sku_code', v.sku_code],
          ['scale_plu', v.scale_plu],
          ['barcode', v.barcode],
        ] as const
      ).find(([f, x]) => x !== undefined && firstRow.has(`${f}:${x}`));
      const existing = skuId.get(v.sku_code);
      const pluOther = v.scale_plu ? pluOwner.get(v.scale_plu) : undefined;
      const barOther = v.barcode ? barcodeOwner.get(v.barcode) : undefined;
      const dupOther =
        (pluOther && pluOther !== v.sku_code && (['scale_plu', pluOther] as const)) ||
        (barOther && barOther !== v.sku_code && (['barcode', barOther] as const)) ||
        undefined;
      for (const [f, x] of [
        ['sku_code', v.sku_code],
        ['scale_plu', v.scale_plu],
        ['barcode', v.barcode],
      ] as const)
        if (x !== undefined && !firstRow.has(`${f}:${x}`)) firstRow.set(`${f}:${x}`, row);

      const dup = inFile
        ? { field: inFile[0], of: `dòng ${firstRow.get(`${inFile[0]}:${inFile[1]}`)}` }
        : dupOther
          ? { field: dupOther[0], of: `SKU ${dupOther[1]}` }
          : existing
            ? { field: 'sku_code', of: `SKU ${v.sku_code}` }
            : undefined;
      if (dup) {
        if (mode === 'STOP') {
          out.push({
            row,
            status: 'SKIPPED',
            key: v.sku_code,
            field: dup.field,
            duplicate_of: dup.of,
            message: 'Trùng',
          });
          return { rows: out, stoppedAt: row };
        }
        // cập nhật chỉ khi trùng ĐÚNG mã SKU của chính nó (mã vạch / PLU của SKU khác ⇒ không cập nhật được)
        const canUpdate = mode === 'UPDATE' && !inFile && !dupOther && existing;
        if (!canUpdate) {
          out.push(
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
          );
          continue;
        }
        try {
          await this.inSavepoint(() => this.updateSku(existing, v, cats, prods, reason));
          out.push({ row, status: 'UPDATED', key: v.sku_code });
        } catch (e) {
          out.push(this.rowError(row, v.sku_code, e));
        }
        continue;
      }
      try {
        await this.inSavepoint(() => this.createSku(v, cats, prods, reason));
        out.push({ row, status: 'CREATED', key: v.sku_code });
      } catch (e) {
        out.push(this.rowError(row, v.sku_code, e));
      }
    }
    return { rows: out };
  }

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

  private attrs(v: CatalogRowT) {
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

  private async createSku(v: CatalogRowT, cats: Map<string, string>, prods: Map<string, string>, reason: string) {
    const productId = await this.productOf(await this.categoryOf(v.category, cats), v.product, prods);
    const s = await this.skus.create({
      product_id: productId,
      sku_code: v.sku_code,
      sale_unit_type: v.sale_unit_type,
      ...this.attrs(v),
      name: v.name,
      ...(v.barcode ? { barcode: v.barcode } : {}),
    });
    if (v.retail_price !== undefined)
      await this.prices.set(s.id, { version: s.version, global: v.retail_price }, reason);
  }

  private async updateSku(
    id: string,
    v: CatalogRowT,
    cats: Map<string, string>,
    prods: Map<string, string>,
    reason: string,
  ) {
    const cur = await this.tx.sku.findUniqueOrThrow({
      where: { id },
      select: { version: true, saleUnitType: true, retailPricePerKg: true, retailPricePerUnit: true },
    });
    if (cur.saleUnitType !== v.sale_unit_type)
      throw new AppError('CATALOG_RULE_VIOLATION', 'Kiểu bán không đổi được — lưu trữ SKU cũ và tạo mã mới', {
        field: 'sale_unit_type',
      });
    const productId = await this.productOf(await this.categoryOf(v.category, cats), v.product, prods);
    const s = await this.skus.update(id, { version: cur.version, product_id: productId, ...this.attrs(v) });
    const price = cur.retailPricePerKg ?? cur.retailPricePerUnit;
    if (v.retail_price !== undefined && v.retail_price !== price)
      await this.prices.set(id, { version: s.version, global: v.retail_price }, reason);
  }

  // ───────── nhà cung cấp ─────────

  private async supplierRows(rows: SheetRow[], mode: DupMode): Promise<Outcome> {
    const parsed = rows.map((r) => ({ row: r.row, p: SupplierRow.safeParse(r.values) }));
    const codes = parsed.flatMap((x) => (x.p.success ? [x.p.data.code] : []));
    const existing = new Map(
      (await this.tx.supplier.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } })).map(
        (s) => [s.code, s.id],
      ),
    );
    const firstRow = new Map<string, number>();
    const out: ReportRow[] = [];
    for (const { row, p } of parsed) {
      if (!p.success) {
        const issues = rowIssues(p.error);
        out.push({
          row,
          status: 'ERROR',
          ...(issues[0]?.field ? { field: issues[0].field } : {}),
          message: issues.map((i) => `${i.field}: ${i.message}`).join('; '),
        });
        continue;
      }
      const v = p.data;
      const prev = firstRow.get(v.code);
      if (prev === undefined) firstRow.set(v.code, row);
      const id = existing.get(v.code);
      if (prev !== undefined || id) {
        const of = prev !== undefined ? `dòng ${prev}` : `NCC ${v.code}`;
        if (mode === 'STOP') {
          out.push({ row, status: 'SKIPPED', key: v.code, field: 'code', duplicate_of: of, message: 'Trùng' });
          return { rows: out, stoppedAt: row };
        }
        if (mode === 'SKIP' || prev !== undefined || !id) {
          out.push(
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
          );
          continue;
        }
        try {
          await this.inSavepoint(() => this.suppliers.update(id, this.supplierFields(v)));
          out.push({ row, status: 'UPDATED', key: v.code });
        } catch (e) {
          out.push(this.rowError(row, v.code, e));
        }
        continue;
      }
      try {
        await this.inSavepoint(() =>
          this.suppliers.create({ code: v.code, ...this.supplierFields(v), name: v.name, type: v.type }),
        );
        out.push({ row, status: 'CREATED', key: v.code });
      } catch (e) {
        out.push(this.rowError(row, v.code, e));
      }
    }
    return { rows: out };
  }

  /** ô trống = không đổi (cập nhật) / không có (tạo) */
  private supplierFields(v: SupplierRowT) {
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
}
