import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  BarcodeError,
  type BarcodeRuleDef,
  decodeBarcode,
  formatVnd,
  isValidEan13,
  parsePattern,
} from '@fruit/money_weight';
import ExcelJS from 'exceljs';
import { v7 as uuidv7 } from 'uuid';
import { AuditOutboxService, type Tx } from '../common/audit-outbox.service';
import { AppError } from '../common/errors';
import { ScopeService } from '../common/scope.service';
import { catalogWrite } from '../catalog/catalog-db';
import { rule } from '../catalog/catalog-rules';
import { XLSX_MIME } from '../files/files.service';
import type { BarcodeRule, BrandSettings } from '../generated/prisma/client';
import { ImportsService } from '../imports/imports.service';
import { ean13Svg } from './ean13-svg';

export type RuleType = 'WEIGHT' | 'PRICE' | 'PRODUCT' | 'BATCH' | 'ORDER' | 'STAFF';
export interface RuleCreate {
  code: string;
  name: string;
  priority: number;
  type: RuleType;
  pattern: string;
  value_scale: 1 | 10 | 100;
  ean13_checksum: boolean;
  enabled: boolean;
}
export type RuleUpdate = Partial<Omit<RuleCreate, 'code' | 'type'>>;
export interface BrandUpdate {
  brand_name?: string;
  hotline?: string | null;
  display_address?: string | null;
  receipt_footer?: string | null;
  primary_color?: string | null;
  privacy_url?: string | null;
  logo_mono_file_id?: string | null;
  logo_color_file_id?: string | null;
}

const iso = (d: Date) => d.toISOString();
const ruleWire = (r: BarcodeRule) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  priority: r.priority,
  type: r.type,
  pattern: r.pattern,
  value_scale: r.valueScale,
  ean13_checksum: r.ean13Checksum,
  enabled: r.enabled,
  created_at: iso(r.createdAt),
  updated_at: iso(r.updatedAt),
});
const brandWire = (b: BrandSettings) => ({
  brand_name: b.brandName,
  hotline: b.hotline,
  display_address: b.displayAddress,
  receipt_footer: b.receiptFooter,
  primary_color: b.primaryColor,
  privacy_url: b.privacyUrl,
  logo_mono_file_id: b.logoMonoFileId,
  logo_color_file_id: b.logoColorFileId,
  updated_at: iso(b.updatedAt),
  updated_by: b.updatedBy,
});
const def = (r: BarcodeRule): BarcodeRuleDef => ({
  code: r.code,
  type: r.type,
  pattern: r.pattern,
  valueScale: r.valueScale,
  ean13Checksum: r.ean13Checksum,
});

/** bỏ dấu tiếng Việt (màn hình cân thường chỉ ASCII) */
export const ascii = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^\x20-\x7e]/g, '');
const html = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
/** ô CSV: luôn trong nháy; chữ bắt đầu bằng = + - @ tab CR ⇒ thêm ' (chống chèn công thức khi mở bằng Excel) */
const csvCell = (v: string | number | null) => {
  if (v === null) return '';
  const s = String(v);
  const t = typeof v === 'string' && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${t.replace(/"/g, '""')}"`;
};

export const MAX_LABELS = 500;

/**
 * PLU, mã vạch cân, thương hiệu, tem giá kệ (CP04 lát 6, NC-26, §6.5, §21.3.8, §18.5). Mã vạch giải / kiểm bằng thư viện
 * DÙNG CHUNG `@fruit/money_weight` (cùng vector với Dart — POS / app dùng bản Dart).
 */
@Injectable()
export class LabelsService {
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly ao: AuditOutboxService,
    private readonly scope: ScopeService,
    private readonly exports: ImportsService,
  ) {}

  private get tx() {
    return this.txHost.tx;
  }

  // ───────── quy tắc mã vạch ─────────

  private assertPattern(type: RuleType, pattern: string, ean13: boolean) {
    try {
      parsePattern(pattern, { type, ean13Checksum: ean13 });
    } catch (e) {
      if (e instanceof BarcodeError) throw rule(e.message, { field: 'pattern' });
      throw e;
    }
  }

  async listRules() {
    const rows = await this.tx.barcodeRule.findMany({ orderBy: { priority: 'asc' } });
    return { items: rows.map(ruleWire) };
  }

  async getRule(id: string) {
    const r = await this.tx.barcodeRule.findUnique({ where: { id } });
    if (!r) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy quy tắc mã vạch');
    return ruleWire(r);
  }

  async createRule(b: RuleCreate) {
    this.assertPattern(b.type, b.pattern, b.ean13_checksum);
    const r = await catalogWrite(() =>
      this.tx.barcodeRule.create({
        data: {
          id: uuidv7(),
          code: b.code,
          name: b.name,
          priority: b.priority,
          type: b.type,
          pattern: b.pattern,
          valueScale: b.value_scale,
          ean13Checksum: b.ean13_checksum,
          enabled: b.enabled,
        },
      }),
    ).catch(ruleUnique);
    await this.ao.recordAudit({
      action: 'barcode_rule.create',
      resourceType: 'barcode_rule',
      resourceId: r.id,
      after: ruleWire(r),
    });
    return ruleWire(r);
  }

  async updateRule(id: string, b: RuleUpdate) {
    const locked = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM core.barcode_rules WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
    if (!locked.length) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy quy tắc mã vạch');
    const before = await this.tx.barcodeRule.findUniqueOrThrow({ where: { id } });
    this.assertPattern(before.type, b.pattern ?? before.pattern, b.ean13_checksum ?? before.ean13Checksum);
    const r = await catalogWrite(() =>
      this.tx.barcodeRule.update({
        where: { id },
        data: {
          name: b.name,
          priority: b.priority,
          pattern: b.pattern,
          valueScale: b.value_scale,
          ean13Checksum: b.ean13_checksum,
          enabled: b.enabled,
        },
      }),
    ).catch(ruleUnique);
    await this.ao.recordAudit({
      action: 'barcode_rule.update',
      resourceType: 'barcode_rule',
      resourceId: id,
      before: ruleWire(before),
      after: ruleWire(r),
    });
    return ruleWire(r);
  }

  /**
   * Sắp lại thứ tự ưu tiên (màn A10): `ids` = ĐÚNG toàn bộ quy tắc hiện có theo thứ tự mới. Giữ nguyên tập giá trị priority
   * đang dùng (sắp tăng dần) rồi gán lần lượt ⇒ không vượt khoảng CHECK. Khóa mọi quy tắc theo id (thứ tự cố định) rồi hoãn
   * kiểm UNIQUE tới cuối (migration 0011) — đổi chỗ không cần giá trị tạm.
   */
  async reorderRules(ids: string[]) {
    const rows = await this.tx.$queryRaw<{ id: string; priority: number }[]>`
      SELECT id, priority FROM core.barcode_rules ORDER BY id FOR NO KEY UPDATE`;
    const known = new Set(rows.map((r) => r.id));
    if (new Set(ids).size !== ids.length || ids.length !== rows.length || ids.some((i) => !known.has(i)))
      throw new AppError('VERSION_CONFLICT', 'Danh sách quy tắc đã thay đổi — tải lại rồi sắp lại', {
        reason: 'STALE_LIST',
        field: 'ids',
      });
    const before = [...rows].sort((a, b) => a.priority - b.priority);
    const slots = before.map((r) => r.priority);
    const next = new Map(ids.map((id, i) => [id, slots[i] as number]));
    await this.tx.$executeRaw`SET CONSTRAINTS core.barcode_rules_priority_key DEFERRED`;
    for (const r of rows) {
      const p = next.get(r.id) as number;
      if (p !== r.priority) await this.tx.barcodeRule.update({ where: { id: r.id }, data: { priority: p } });
    }
    // kiểm ngay tại đây (không để tới COMMIT) ⇒ lỗi vẫn qua bộ ánh xạ lỗi + rollback bình thường
    await catalogWrite(() => this.tx.$executeRaw`SET CONSTRAINTS core.barcode_rules_priority_key IMMEDIATE`).catch(
      ruleUnique,
    );
    await this.ao.recordAudit({
      action: 'barcode_rule.reorder',
      resourceType: 'barcode_rule',
      before: { order: before.map((r) => r.id) },
      after: { order: ids },
    });
    return this.listRules();
  }

  /** Thử giải một mã theo các quy tắc ĐANG BẬT (thứ tự priority) + tra SKU — màn cấu hình (A10); POS dùng bản Dart. */
  async decode(code: string) {
    const rules = await this.tx.barcodeRule.findMany({ where: { enabled: true }, orderBy: { priority: 'asc' } });
    const usable = rules.filter((r) => {
      try {
        parsePattern(r.pattern, { type: r.type, ean13Checksum: r.ean13Checksum });
        return true;
      } catch {
        return false; // quy tắc hỏng (sửa tay bằng SQL) ⇒ bỏ qua, không làm hỏng mọi lần giải mã
      }
    });
    // quy tắc bị bỏ qua báo lại để Master sửa (review bảo mật lát 6 vòng 2)
    const skipped = rules.filter((r) => !usable.includes(r)).map((r) => r.code);
    const res = decodeBarcode(usable.map(def), code);
    if (!res.ok)
      return { ok: false as const, reason: res.reason, rule: res.rule ?? null, sku: null, skipped_rules: skipped };
    const d = res.decoded;
    const sku =
      d.plu !== undefined
        ? await this.tx.sku.findFirst({
            where: { scalePlu: d.plu.padStart(5, '0'), archivedAt: null },
            select: { id: true, skuCode: true, name: true },
          })
        : d.type === 'PRODUCT' && d.value
          ? (
              await this.tx.skuUnit.findFirst({
                where: { barcode: d.value, archivedAt: null, sku: { archivedAt: null } },
                select: { sku: { select: { id: true, skuCode: true, name: true } } },
              })
            )?.sku
          : null;
    return {
      ok: true as const,
      skipped_rules: skipped,
      rule: d.rule,
      type: d.type,
      plu: d.plu ?? null,
      grams: d.grams ?? null,
      amount: d.amount ?? null,
      value: d.value ?? null,
      sku: sku ? { id: sku.id, sku_code: sku.skuCode, name: sku.name } : null,
    };
  }

  // ───────── xuất PLU cho cân ─────────

  /**
   * File PLU nạp vào cân in tem (§6.5): chỉ SKU đang dùng, BÁN QUA CÂN, có PLU; giá/kg của cửa hàng (giá riêng nếu có, không
   * thì giá chung). SKU chưa có giá ⇒ không xuất (liệt kê để Master đặt giá). Ghi `audit.export_logs`.
   */
  async pluExport(b: { store_id?: string; format: 'CSV' | 'XLSX' }) {
    if (b.store_id) await this.scope.assertStore('plu:export', b.store_id);
    else if (!(await this.scope.isAll('plu:export')))
      throw new AppError('ACTION_FORBIDDEN', 'Xuất giá chung (không chọn cửa hàng) cần phạm vi toàn chuỗi');
    if (b.store_id) {
      const st = await this.tx.store.findUnique({ where: { id: b.store_id }, select: { archivedAt: true } });
      if (!st) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy');
      if (st.archivedAt) throw rule('Cửa hàng đã lưu trữ', { field: 'store_id' });
    }
    const rows = await this.tx.$queryRaw<
      {
        plu: string;
        sku_code: string;
        name: string;
        sale_unit_type: string;
        price: bigint | null;
        shelf_life_days: number | null;
        tare_g: number | null;
      }[]
    >`
      SELECT s.scale_plu AS plu, s.sku_code, s.name, s.sale_unit_type::text,
             COALESCE(sp.retail_price_per_kg, s.retail_price_per_kg) AS price, s.shelf_life_days, s.tare_g
      FROM core.skus s
      LEFT JOIN core.store_prices sp ON sp.sku_id = s.id AND sp.store_id = ${b.store_id ?? null}::uuid
      WHERE s.sold_by_scale AND s.scale_plu IS NOT NULL AND s.archived_at IS NULL
      ORDER BY s.scale_plu`;
    const out = rows.filter((r) => r.price !== null);
    const noPrice = rows.filter((r) => r.price === null).map((r) => r.sku_code);
    const cols = [
      ['plu', 'PLU'],
      ['name', 'Tên'],
      ['name_ascii', 'Tên không dấu'],
      ['price_per_kg', 'Giá/kg (đồng)'],
      ['sale_unit_type', 'Kiểu bán'],
      ['shelf_life_days', 'Hạn dùng (ngày)'],
      ['tare_g', 'Bì (g)'],
      ['sku_code', 'Mã SKU'],
    ] as const;
    const data = out.map((r) => ({
      plu: r.plu,
      name: r.name,
      name_ascii: ascii(r.name),
      price_per_kg: (r.price as bigint).toString(),
      sale_unit_type: r.sale_unit_type,
      shelf_life_days: r.shelf_life_days,
      tare_g: r.tare_g,
      sku_code: r.sku_code,
    }));
    let buf: Buffer;
    if (b.format === 'CSV') {
      const lines = [
        cols.map(([, h]) => csvCell(h)).join(','),
        ...data.map((d) => cols.map(([k]) => csvCell(d[k])).join(',')),
      ];
      // UTF-8 có BOM (Excel / phần mềm cân đọc đúng tiếng Việt); xuống dòng CRLF
      buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')]);
    } else {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('PLU');
      ws.columns = cols.map(([k, h]) => ({ header: h, key: k, width: 18 }));
      ws.getRow(1).font = { bold: true };
      ws.getColumn('plu').numFmt = '@';
      for (const d of data)
        ws.addRow(
          Object.fromEntries(
            Object.entries(d).map(([k, v]) => [k, typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v]),
          ),
        );
      buf = Buffer.from(await wb.xlsx.writeBuffer());
    }
    const saved = await this.exports.saveExport({
      buf,
      mime: b.format === 'CSV' ? 'text/csv' : XLSX_MIME,
      kind: 'EXPORT_PLU',
      ext: b.format === 'CSV' ? 'csv' : 'xlsx',
      fileName: 'plu',
      exportType: 'PLU',
      filters: { store_id: b.store_id ?? null, format: b.format },
      rows: data.length,
    });
    return { ...saved, format: b.format, rows: data.length, skipped_no_price: noPrice };
  }

  // ───────── thương hiệu ─────────

  async getBrand() {
    const b = await this.tx.brandSettings.findUniqueOrThrow({ where: { id: 1 } });
    return brandWire(b);
  }

  /** Logo: file BRAND_LOGO đã READY (presign → PUT → complete); null = bỏ logo. */
  private async assertLogo(id: string | null | undefined, field: string) {
    if (!id) return;
    const [f] = await this.tx.$queryRaw<{ kind: string; status: string }[]>`
      SELECT kind, status::text FROM core.files WHERE id = ${id}::uuid FOR SHARE`;
    if (!f) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy file logo', { field });
    if (f.kind !== 'BRAND_LOGO' || f.status !== 'READY')
      throw rule('Logo phải là file BRAND_LOGO đã tải xong (READY)', { field });
  }

  async updateBrand(b: BrandUpdate, userId: string) {
    await this.tx.$queryRaw`SELECT id FROM core.brand_settings WHERE id = 1 FOR NO KEY UPDATE`;
    const before = await this.tx.brandSettings.findUniqueOrThrow({ where: { id: 1 } });
    await this.assertLogo(b.logo_mono_file_id, 'logo_mono_file_id');
    await this.assertLogo(b.logo_color_file_id, 'logo_color_file_id');
    const a = await catalogWrite(() =>
      this.tx.brandSettings.update({
        where: { id: 1 },
        data: {
          brandName: b.brand_name,
          hotline: b.hotline,
          displayAddress: b.display_address,
          receiptFooter: b.receipt_footer,
          primaryColor: b.primary_color,
          privacyUrl: b.privacy_url,
          logoMonoFileId: b.logo_mono_file_id,
          logoColorFileId: b.logo_color_file_id,
          updatedBy: userId,
        },
      }),
    );
    await this.ao.recordAudit({
      action: 'brand.update',
      resourceType: 'brand_settings',
      resourceId: '1',
      before: brandWire(before),
      after: brandWire(a),
      // địa chỉ hiển thị trên phiếu / app là thông tin công khai của thương hiệu
      publicKeys: ['display_address'],
    });
    return brandWire(a);
  }

  // ───────── tem giá kệ ─────────

  /**
   * Trang HTML in được (A4) — tem giá kệ hàng loạt: tên thương hiệu, tên SKU, giá (đ/kg hoặc đ/đơn vị, giá cửa hàng nếu có),
   * PLU / mã vạch EAN-13 (SVG). Mọi chữ từ DB được thoát HTML; trang không có script (CSP chặn).
   */
  async shelfLabels(q: { sku_ids?: string[]; category_id?: string; store_id?: string; layout: 'A4_24' | 'A4_10' }) {
    if (q.store_id) await this.scope.assertStore('price:read', q.store_id);
    // không chọn cửa hàng ⇒ giá chung: người chỉ có phạm vi cửa hàng phải chọn cửa hàng mình (như xuất PLU)
    else if (!(await this.scope.isAll('price:read')))
      throw new AppError('ACTION_FORBIDDEN', 'Chọn cửa hàng để in tem (giá chung cần phạm vi toàn chuỗi)');
    const where = q.sku_ids?.length
      ? { id: { in: q.sku_ids }, archivedAt: null }
      : { product: { categoryId: q.category_id }, archivedAt: null };
    const skus = await this.tx.sku.findMany({
      where,
      orderBy: { skuCode: 'asc' },
      take: MAX_LABELS + 1,
      include: {
        // đơn vị đang dùng, để bán — đơn vị gốc trước (UUIDv7 nhỏ nhất)
        units: {
          where: { archivedAt: null, forSale: true },
          orderBy: { id: 'asc' },
          select: { barcode: true, name: true, pricePerUnit: true, factorUnits: true },
        },
        storePrices: q.store_id ? { where: { storeId: q.store_id } } : false,
      },
    });
    if (skus.length > MAX_LABELS) throw new AppError('INVALID_REQUEST', `Tối đa ${MAX_LABELS} tem mỗi lần in`);
    const brand = await this.tx.brandSettings.findUniqueOrThrow({ where: { id: 1 }, select: { brandName: true } });
    const perKg = new Set(['WEIGHT', 'PIECE_BY_WEIGHT', 'PACK_VARIABLE']);
    const cells = skus.map((s) => {
      const kg = perKg.has(s.saleUnitType);
      const sp = (s as { storePrices?: { retailPricePerKg: bigint | null; retailPricePerUnit: bigint | null }[] })
        .storePrices?.[0];
      // MỘT đơn vị hiển thị — giá, tên đơn vị, mã vạch cùng của đơn vị đó (review TS lát 6 vòng 2 C1):
      // hàng cân ⇒ giá/kg + PLU (không in mã vạch của hộp — giá khác); hàng đếm ⇒ đơn vị bán có mã vạch, không thì đơn vị
      // bán đầu tiên; giá = giá riêng của đơn vị, không có thì giá SKU (cửa hàng → chung, giá đơn vị gốc) × số quy đổi
      // (như POS tính dòng bán — lát 3).
      const base = sp?.retailPricePerUnit ?? s.retailPricePerUnit;
      const unit = kg ? undefined : (s.units.find((u) => u.barcode) ?? s.units[0]);
      const price = kg
        ? (sp?.retailPricePerKg ?? s.retailPricePerKg)
        : unit
          ? (unit.pricePerUnit ?? (base !== null && unit.factorUnits !== null ? base * BigInt(unit.factorUnits) : null))
          : base;
      const barcode = unit?.barcode ?? null;
      const per = kg ? '/kg' : unit ? `/${unit.name}` : '';
      const code =
        barcode && isValidEan13(barcode)
          ? ean13Svg(barcode, { moduleWidth: 1.2, height: 22 })
          : `<div class="code">${html(barcode ?? (s.scalePlu ? `PLU ${s.scalePlu}` : s.skuCode))}</div>`;
      return (
        `<div class="label"><div class="brand">${html(brand.brandName)}</div>` +
        `<div class="name">${html(s.name)}</div>` +
        `<div class="price">${price !== null ? `${html(formatVnd(price))}<span class="per">${html(per)}</span>` : '<span class="per">Chưa có giá</span>'}</div>` +
        `${code}<div class="sku">${html(s.skuCode)}${s.scalePlu ? ` · PLU ${html(s.scalePlu)}` : ''}</div></div>`
      );
    });
    // vùng in A4 = 210 × 297 mm trừ lề 8 mm ⇒ 194 × 281 mm. A4_24: 3 × 8 tem 33 mm + 7 khe 1 mm = 271 mm; A4_10: 2 × 5 tem
    // 54 mm + 4 khe 1 mm = 274 mm. Mỗi trang một khối riêng (ngắt trang) — không để trình duyệt tự chia lưới.
    const g =
      q.layout === 'A4_24'
        ? { cols: 3, rows: 8, h: 33, name: 9, price: 14 }
        : { cols: 2, rows: 5, h: 54, name: 13, price: 22 };
    const perPage = g.cols * g.rows;
    const pages: string[] = [];
    for (let i = 0; i < cells.length; i += perPage)
      pages.push(`<div class="page">${cells.slice(i, i + perPage).join('')}</div>`);
    return {
      count: skus.length,
      html:
        '<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Tem giá kệ</title><style>' +
        '@page{size:A4;margin:8mm}html,body{margin:0;padding:0;font-family:Arial,sans-serif}' +
        `.page{display:grid;grid-template-columns:repeat(${g.cols},1fr);grid-auto-rows:${g.h}mm;gap:1mm;break-after:page}` +
        '.page:last-child{break-after:auto}' +
        '.label{box-sizing:border-box;height:100%;border:1px dashed #999;padding:1.5mm;overflow:hidden;display:flex;flex-direction:column}' +
        `.brand{font-size:7pt;color:#555;line-height:1.1}.name{font-size:${g.name}pt;font-weight:bold;line-height:1.15;max-height:2.3em;overflow:hidden}` +
        `.price{font-size:${g.price}pt;font-weight:bold;line-height:1.2}.per{font-size:8pt;font-weight:normal;margin-left:1mm}` +
        '.code{font-family:monospace;font-size:9pt}.sku{font-size:6pt;color:#555;margin-top:auto}svg{max-width:100%;height:auto;display:block}' +
        `</style></head><body>${pages.join('')}</body></html>`,
    };
  }
}

function ruleUnique(e: unknown): never {
  if (e instanceof AppError && e.code === 'VERSION_CONFLICT') {
    const f = (e.details?.['field'] as string | undefined) ?? 'priority';
    throw new AppError('VERSION_CONFLICT', `Trùng ${f} với quy tắc khác`, { reason: 'UNIQUE', field: f });
  }
  throw e;
}
