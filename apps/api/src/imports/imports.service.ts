import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import ExcelJS from 'exceljs';
import { ClsService } from 'nestjs-cls';
import { v7 as uuidv7 } from 'uuid';
import type { Principal } from '../common/access';
import { AuditOutboxService, type Tx } from '../common/audit-outbox.service';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { ScopeService } from '../common/scope.service';
import { DOWNLOAD_TTL_S, EXPORT_XLSX_KIND, XLSX_MIME } from '../files/files.service';
import type { ImportJob } from '../generated/prisma/client';
import { ObjectStorage } from '../infra/object-storage.service';
import { CATALOG_COLUMNS, type ImportType, SUPPLIER_COLUMNS } from './import-columns';
import type { DupMode } from './import-processor';

export const IMPORT_EVENT = 'catalog.import_requested';
export const EXPORT_LISTS = ['skus', 'categories', 'suppliers', 'stores', 'locations'] as const;
export type ExportList = (typeof EXPORT_LISTS)[number];
/** lượt RUNNING lâu hơn ngần này coi như kẹt (không tính vào trần 2 lượt) */
export const STALE_RUNNING_MS = 15 * 60_000;
/** trần dòng mỗi file xuất (giữ request ngắn) */
export const MAX_EXPORT_ROWS = 20_000;
/** quyền ĐỌC cần cho từng danh sách (ngoài report:export của route) */
const LIST_PERMISSION: Record<ExportList, string> = {
  skus: 'catalog:read',
  categories: 'catalog:read',
  suppliers: 'supplier:read',
  stores: 'report:read',
  locations: 'stock:read',
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);
export function importJobWire(j: ImportJob, withReport: boolean) {
  return {
    id: j.id,
    type: j.type,
    file_id: j.fileId,
    mode_on_duplicate: j.modeOnDuplicate,
    dry_run: j.dryRun,
    status: j.status,
    total_rows: j.totalRows,
    ok_rows: j.okRows,
    skipped_rows: j.skippedRows,
    error_rows: j.errorRows,
    error: j.error,
    created_by: j.createdBy,
    created_at: j.createdAt.toISOString(),
    started_at: iso(j.startedAt),
    finished_at: iso(j.finishedAt),
    ...(withReport ? { report: (j.report ?? null) as Record<string, unknown> | null } : {}),
  };
}

/**
 * Nhập / xuất Excel phía API (CP04 lát 5, ADR-031). Nhập: tạo lượt PENDING + sự kiện outbox cùng transaction ⇒ worker
 * chạy (ImportProcessor). Xuất: tạo .xlsx trong request, lưu S3 (file READY do server tạo), trả URL tải 60 giây.
 */
@Injectable()
export class ImportsService {
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly cls: ClsService<RequestStore>,
    private readonly ao: AuditOutboxService,
    private readonly storage: ObjectStorage,
    private readonly scope: ScopeService,
  ) {}

  private get tx() {
    return this.txHost.tx;
  }

  private principal(): Principal {
    const p = this.cls.get('principal');
    if (!p) throw new AppError('AUTHENTICATION_REQUIRED', 'Cần đăng nhập');
    return p;
  }

  async create(b: { type: ImportType; file_id: string; mode_on_duplicate: DupMode; dry_run: boolean }) {
    const p = this.principal();
    // file READY, loại IMPORT_XLSX, của chính người gọi; khóa chia sẻ (không đổi trạng thái giữa chừng)
    const [f] = await this.tx.$queryRaw<{ kind: string; status: string; created_by: string }[]>`
      SELECT kind, status::text, created_by::text FROM core.files WHERE id = ${b.file_id}::uuid FOR SHARE`;
    if (!f || f.created_by !== p.userId)
      throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy file', { field: 'file_id' });
    if (f.kind !== 'IMPORT_XLSX')
      throw new AppError('INVALID_REQUEST', 'File không phải loại IMPORT_XLSX', { field: 'file_id' });
    if (f.status !== 'READY')
      throw new AppError('INVALID_STATE_TRANSITION', 'File chưa sẵn sàng (complete trước)', { field: 'file_id' });
    // tối đa 2 lượt đang chờ / chạy mỗi người (một lượt nhập giữ transaction dài ở worker)
    await this.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('import-create:' || ${p.userId}, 0))`;
    // lượt RUNNING quá 15 phút (worker chết giữa chừng) không chặn người dùng mãi — review TS lát 5 N2 (dọn ở CP19)
    const busy = await this.tx.importJob.count({
      where: {
        createdBy: p.userId,
        OR: [{ status: 'PENDING' }, { status: 'RUNNING', startedAt: { gt: new Date(Date.now() - STALE_RUNNING_MS) } }],
      },
    });
    if (busy >= 2) throw new AppError('RATE_LIMITED', 'Đang có lượt nhập chờ chạy — đợi xong rồi tạo tiếp');
    const id = uuidv7();
    const j = await this.tx.importJob.create({
      data: {
        id,
        type: b.type,
        fileId: b.file_id,
        modeOnDuplicate: b.mode_on_duplicate,
        dryRun: b.dry_run,
        createdBy: p.userId,
      },
    });
    await this.ao.recordAudit({
      action: 'import.create',
      resourceType: 'import_job',
      resourceId: id,
      after: { type: b.type, file_id: b.file_id, mode_on_duplicate: b.mode_on_duplicate, dry_run: b.dry_run },
    });
    await this.ao.emitEvent({
      eventType: IMPORT_EVENT,
      schemaVersion: 1,
      aggregateType: 'import_job',
      aggregateId: id,
      payload: { import_job_id: id, type: b.type },
    });
    return importJobWire(j, false);
  }

  async list(limit: number) {
    const rows = await this.tx.importJob.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit });
    return { items: rows.map((j) => importJobWire(j, false)) };
  }

  async get(id: string) {
    const j = await this.tx.importJob.findUnique({ where: { id } });
    if (!j) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy lượt nhập');
    return importJobWire(j, true);
  }

  // ───────── xuất Excel ─────────

  async export(list: ExportList) {
    const p = this.principal();
    if (!p.permissions.has(LIST_PERMISSION[list]))
      throw new AppError('ACTION_FORBIDDEN', `Cần quyền ${LIST_PERMISSION[list]} để xuất danh sách này`);
    const { headers, rows } = await this.rowsOf(list, p);
    if (rows.length > MAX_EXPORT_ROWS)
      throw new AppError('INVALID_REQUEST', `Danh sách quá ${MAX_EXPORT_ROWS} dòng — lọc bớt trước khi xuất`);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'fruit-retail';
    const ws = wb.addWorksheet(list);
    ws.columns = headers.map((h) => ({ header: h.header, key: h.key, width: 20 }));
    ws.getRow(1).font = { bold: true };
    // chữ bắt đầu bằng = + - @ ⇒ thêm ' (chống chèn công thức khi người dùng mở / chuyển sang CSV)
    for (const r of rows) ws.addRow(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, safeCell(v)])));
    for (const h of headers) if (h.text) ws.getColumn(h.key).numFmt = '@';
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const saved = await this.saveExport({
      buf,
      mime: XLSX_MIME,
      kind: EXPORT_XLSX_KIND,
      ext: 'xlsx',
      fileName: list,
      exportType: `CATALOG_${list.toUpperCase()}`,
      filters: { list },
      rows: rows.length,
    });
    return { file_id: saved.file_id, list, rows: rows.length, url: saved.url, expires_at: saved.expires_at };
  }

  /**
   * Lưu file xuất do SERVER tạo (S3, file READY) + `audit.export_logs` (SPEC §12.3 — ai xuất gì, bộ lọc, số dòng) + audit
   * `export.create` cùng transaction; trả URL tải 60 giây. Dùng chung cho xuất danh sách (lát 5) và file PLU (lát 6).
   */
  async saveExport(e: {
    buf: Buffer;
    mime: string;
    kind: string;
    ext: string;
    fileName: string;
    exportType: string;
    filters: Record<string, string | number | boolean | null>;
    rows: number;
  }) {
    const p = this.principal();
    if (!this.storage.configured) throw new AppError('CONFIGURATION_NOT_READY', 'Chưa cấu hình lưu trữ file');
    const id = uuidv7();
    const now = new Date();
    const key = `exports/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}.${e.ext}`;
    await this.storage.put(key, e.buf, e.mime);
    const sha = new Uint8Array(createHash('sha256').update(e.buf).digest());
    await this.tx.file.create({
      data: {
        id,
        kind: e.kind,
        mime: e.mime,
        storageKey: key,
        finalKey: key,
        declaredBytes: e.buf.length,
        declaredSha256: sha,
        bytes: e.buf.length,
        sha256: sha,
        status: 'READY',
        completedAt: now,
        createdBy: p.userId,
      },
      select: { id: true },
    });
    await this.tx.exportLog.create({
      data: { id: uuidv7(), userId: p.userId, exportType: e.exportType, filters: e.filters, rows: e.rows, fileId: id },
      select: { id: true },
    });
    await this.ao.recordAudit({
      action: 'export.create',
      resourceType: 'file',
      resourceId: id,
      after: { export_type: e.exportType, ...e.filters, rows: e.rows },
    });
    const url = await this.storage.presignGet(
      key,
      `${e.fileName}-${now.toISOString().slice(0, 10)}.${e.ext}`,
      DOWNLOAD_TTL_S,
    );
    return { file_id: id, url, expires_at: new Date(Date.now() + DOWNLOAD_TTL_S * 1000).toISOString() };
  }

  private async rowsOf(
    list: ExportList,
    p: Principal,
  ): Promise<{
    headers: { key: string; header: string; text?: boolean }[];
    rows: Record<string, string | number | boolean | null>[];
  }> {
    const take = MAX_EXPORT_ROWS + 1;
    const h = (cols: readonly { key: string; label: string }[], extra: { key: string; header: string }[] = []) => [
      ...cols.map((c) => ({ key: c.key, header: `${c.label} (${c.key})`, text: TEXT_COLS.has(c.key) })),
      ...extra,
    ];
    switch (list) {
      case 'skus': {
        const cats = await this.categoryPaths();
        const skus = await this.tx.sku.findMany({
          orderBy: { skuCode: 'asc' },
          take,
          include: {
            product: { select: { name: true, categoryId: true } },
            // đơn vị gốc = đơn vị tạo cùng SKU (id UUIDv7 nhỏ nhất)
            units: { orderBy: { id: 'asc' }, take: 1, select: { barcode: true } },
          },
        });
        return {
          // cùng cột với file nhập ⇒ xuất → sửa → nhập lại (chế độ UPDATE)
          // giá lẻ chỉ khi có price:read (API giá tách quyền khỏi catalog:read — review bảo mật lát 5 N3)
          headers: h(
            p.permissions.has('price:read') ? CATALOG_COLUMNS : CATALOG_COLUMNS.filter((c) => c.key !== 'retail_price'),
            [{ key: 'archived', header: 'Đã lưu trữ (archived)' }],
          ),
          rows: skus.map((s) => ({
            category: cats.get(s.product.categoryId) ?? '',
            product: s.product.name,
            sku_code: s.skuCode,
            name: s.name,
            sale_unit_type: s.saleUnitType,
            ...(p.permissions.has('price:read')
              ? { retail_price: (s.retailPricePerKg ?? s.retailPricePerUnit)?.toString() ?? null }
              : {}),
            std_weight_g: s.stdWeightG,
            weight_min_g: s.weightMinG,
            weight_max_g: s.weightMaxG,
            tare_g: s.tareG,
            scale_plu: s.scalePlu,
            sold_by_scale: yesNo(s.soldByScale),
            barcode: s.units[0]?.barcode ?? null,
            shelf_life_days: s.shelfLifeDays,
            has_ripeness: yesNo(s.hasRipeness),
            is_high_value: yesNo(s.isHighValue),
            cold_required: yesNo(s.coldRequired),
            archived: yesNo(s.archivedAt !== null),
          })),
        };
      }
      case 'categories': {
        const cats = await this.categoryPaths();
        const rows = await this.tx.category.findMany({ orderBy: [{ sort: 'asc' }, { name: 'asc' }], take });
        return {
          headers: [
            { key: 'path', header: 'Đường dẫn (path)' },
            { key: 'sort', header: 'Thứ tự (sort)' },
            { key: 'archived', header: 'Đã lưu trữ (archived)' },
          ],
          rows: rows
            .map((c) => ({ path: cats.get(c.id) ?? c.name, sort: c.sort, archived: yesNo(c.archivedAt !== null) }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        };
      }
      case 'suppliers': {
        // KHÔNG xuất SĐT / số tài khoản / chủ tài khoản (ADR-015): SĐT che ở cột riêng (không phải cột nhập `phone`)
        const rows = await this.tx.supplier.findMany({ orderBy: { code: 'asc' }, take });
        return {
          headers: h(
            SUPPLIER_COLUMNS.filter((c) => !['phone', 'account_number', 'account_holder', 'bank_name'].includes(c.key)),
            [
              { key: 'has_phone', header: 'Có SĐT (has_phone)' },
              // như API: thông tin ngân hàng chỉ cho supplier:write
              ...(p.permissions.has('supplier:write')
                ? [{ key: 'has_bank_account', header: 'Có tài khoản NH (has_bank_account)' }]
                : []),
              { key: 'archived', header: 'Đã lưu trữ (archived)' },
            ],
          ),
          rows: rows.map((s) => ({
            code: s.code,
            name: s.name,
            type: s.type,
            contact_name: s.contactName,
            payment_terms_days: s.paymentTermsDays,
            note: s.note,
            has_phone: yesNo(s.phoneEnc !== null),
            ...(p.permissions.has('supplier:write') ? { has_bank_account: yesNo(s.bankEnc !== null) } : {}),
            archived: yesNo(s.archivedAt !== null),
          })),
        };
      }
      case 'stores': {
        const sc = await this.scope.stores('report:read');
        const rows = await this.tx.store.findMany({
          where: sc === 'ALL' ? {} : { id: { in: [...sc] } },
          orderBy: { code: 'asc' },
          take,
        });
        return {
          headers: [
            { key: 'code', header: 'Mã (code)', text: true },
            { key: 'name', header: 'Tên (name)' },
            { key: 'address', header: 'Địa chỉ (address)' },
            { key: 'status', header: 'Trạng thái (status)' },
            { key: 'pos_status', header: 'Bán tại quầy (pos_status)' },
            { key: 'app_status', header: 'Nhận đơn app (app_status)' },
            { key: 'app_capacity_per_hour', header: 'Năng lực đơn/giờ (app_capacity_per_hour)' },
            { key: 'lat', header: 'Vĩ độ (lat)' },
            { key: 'lng', header: 'Kinh độ (lng)' },
            { key: 'archived', header: 'Đã lưu trữ (archived)' },
          ],
          rows: rows.map((s) => ({
            code: s.code,
            name: s.name,
            address: s.address,
            status: s.status,
            pos_status: s.posStatus,
            app_status: s.appStatus,
            app_capacity_per_hour: s.appCapacityPerHour,
            lat: s.lat,
            lng: s.lng,
            archived: yesNo(s.archivedAt !== null),
          })),
        };
      }
      case 'locations': {
        const sc = await this.scope.stores('stock:read');
        const rows = await this.tx.location.findMany({
          where: sc === 'ALL' ? {} : { storeId: { in: [...sc] } },
          include: { store: { select: { code: true } }, warehouse: { select: { code: true } } },
          orderBy: [{ storeId: 'asc' }, { warehouseId: 'asc' }, { sort: 'asc' }, { code: 'asc' }],
          take,
        });
        return {
          headers: [
            { key: 'owner', header: 'Cửa hàng / kho (owner)', text: true },
            { key: 'code', header: 'Mã (code)', text: true },
            { key: 'name', header: 'Tên (name)' },
            { key: 'type', header: 'Loại (type)' },
            { key: 'sort', header: 'Thứ tự lộ trình (sort)' },
            { key: 'archived', header: 'Đã lưu trữ (archived)' },
          ],
          rows: rows.map((l) => ({
            owner: l.store ? `CH ${l.store.code}` : `KHO ${l.warehouse?.code ?? ''}`,
            code: l.code,
            name: l.name,
            type: l.type,
            sort: l.sort,
            archived: yesNo(l.archivedAt !== null),
          })),
        };
      }
    }
  }

  /** id danh mục ⇒ "Cha > Con" (cây ≤ 5 cấp) */
  private async categoryPaths(): Promise<Map<string, string>> {
    const all = await this.tx.category.findMany({ select: { id: true, parentId: true, name: true } });
    const byId = new Map(all.map((c) => [c.id, c]));
    const out = new Map<string, string>();
    for (const c of all) {
      const parts: string[] = [];
      let cur: typeof c | undefined = c;
      for (let i = 0; cur && i < 6; i++) {
        parts.unshift(cur.name);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      out.set(c.id, parts.join(' > '));
    }
    return out;
  }
}

const TEXT_COLS = new Set(['sku_code', 'scale_plu', 'barcode', 'code']);
const yesNo = (b: boolean) => (b ? 'có' : 'không');
function safeCell(v: string | number | boolean | null): string | number | boolean | null {
  return typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}
