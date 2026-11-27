import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import { v7 as uuidv7 } from 'uuid';
import { PiiCipher } from '../auth/pii-cipher';
import { AuditOutboxService, type Tx } from '../common/audit-outbox.service';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { catalogWrite } from '../catalog/catalog-db';
import { escapeLike, rule } from '../catalog/catalog-rules';
import type { Supplier } from '../generated/prisma/client';

export const SUPPLIER_TYPES = ['FARM', 'COOPERATIVE', 'WHOLESALER', 'IMPORTER', 'OTHER'] as const;
export type SupplierType = (typeof SUPPLIER_TYPES)[number];

export interface BankAccountInput {
  account_number: string;
  account_holder: string;
}
export interface SupplierCreate {
  code: string;
  name: string;
  type: SupplierType;
  contact_name?: string | null;
  phone?: string | null;
  bank_name?: string | null;
  bank_account?: BankAccountInput | null;
  payment_terms_days?: number | null;
  note?: string | null;
}
export type SupplierUpdate = Partial<Omit<SupplierCreate, 'code'>> & { archived?: boolean };

/** AAD gắn bản mã với đúng dòng + cột (ADR-015) — chép bản mã sang dòng khác ⇒ giải mã lỗi */
export const supplierPhoneAad = (id: string) => `suppliers:phone_enc:${id}`;
export const supplierBankAad = (id: string) => `suppliers:bank_enc:${id}`;

/**
 * SĐT Việt Nam (di động + cố định) → E.164 `+84…` (9–10 số sau mã nước). Nhận `0912…`, `84…`, `+84…`, `028 3…`, có thể kèm
 * khoảng trắng/chấm/gạch/ngoặc. Không hợp lệ ⇒ null.
 */
export function normalizeSupplierPhone(raw: string): string | null {
  const s = raw.replace(/[\s.()-]/g, '');
  // '+84 (0) 912…' ⇒ '+840912…' cũng nhận (review TS lát 4)
  const m = /^(?:\+?840?|0)([1-9]\d{8,9})$/.exec(s);
  return m?.[1] ? `+84${m[1]}` : null;
}

/** Che SĐT: giữ mã nước + 3 số cuối (`+84•••••••123`) */
const maskPhone = (e164: string) => `${e164.slice(0, 3)}${'•'.repeat(Math.max(0, e164.length - 6))}${e164.slice(-3)}`;
/** Che số tài khoản: 4 số cuối (số ngắn hơn 10 chữ số: 2 số cuối) */
const maskAccount = (n: string) => `••••${n.slice(n.length >= 10 ? -4 : -2)}`;

/**
 * Danh bạ nhà cung cấp (CP04 lát 4, §4.5, NC-27). SĐT + tài khoản ngân hàng mã hóa AES-256-GCM (ADR-015), SĐT có HMAC tra
 * cứu riêng không gian `supplier_phone:` (không nối được với SĐT khách). Đọc thường: SĐT che ở danh sách, đầy đủ ở chi tiết
 * (người nhận hàng cần gọi NCC); số tài khoản LUÔN che — xem đủ qua `reveal` (Master + step-up, có audit). Audit KHÔNG chứa
 * SĐT / số tài khoản / chủ tài khoản — chỉ ghi trường PII nào đổi (`changed_pii`).
 */
@Injectable()
export class SuppliersService {
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly ao: AuditOutboxService,
    private readonly cipher: PiiCipher,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  /** tên ngân hàng + số tài khoản che chỉ cho người có supplier:write — nhân viên kho không cần (review bảo mật G1) */
  private canSeeBank(): boolean {
    return this.cls.get('principal')?.permissions.has('supplier:write') ?? false;
  }

  private get tx() {
    return this.txHost.tx;
  }

  private phoneOf(s: Supplier): string | null {
    return s.phoneEnc ? this.cipher.decrypt(s.phoneEnc, supplierPhoneAad(s.id)).toString('utf8') : null;
  }

  private bankOf(s: Supplier): BankAccountInput | null {
    if (!s.bankEnc) return null;
    return JSON.parse(this.cipher.decrypt(s.bankEnc, supplierBankAad(s.id)).toString('utf8')) as BankAccountInput;
  }

  /**
   * Bản ghi cho AUDIT: không SĐT / tài khoản / tên người liên hệ / ghi chú (người nhập hay dán SĐT, STK vào ghi chú; audit
   * chỉ thêm, không xóa được — review bảo mật lát 4 N1). Trường nào trong số đó đổi ⇒ tên trường ở `changed_pii`.
   */
  private base(s: Supplier) {
    return {
      id: s.id,
      code: s.code,
      name: s.name,
      type: s.type,
      bank_name: s.bankName,
      payment_terms_days: s.paymentTermsDays,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
      archived_at: s.archivedAt ? s.archivedAt.toISOString() : null,
    };
  }

  private wire(s: Supplier, fullPhone: boolean) {
    const phone = this.phoneOf(s);
    const bankOk = this.canSeeBank();
    const bank = bankOk ? this.bankOf(s) : null;
    return {
      ...this.base(s),
      bank_name: bankOk ? s.bankName : null,
      contact_name: s.contactName,
      note: s.note,
      phone: fullPhone ? phone : null,
      phone_masked: phone ? maskPhone(phone) : null,
      bank_account_masked: bank ? maskAccount(bank.account_number) : null,
    };
  }

  private phoneHash(e164: string) {
    return this.cipher.hmac(`supplier_phone:${e164}`);
  }

  private normalizePhone(raw: string): string {
    const p = normalizeSupplierPhone(raw);
    if (!p) throw new AppError('INVALID_REQUEST', 'Số điện thoại không hợp lệ', { field: 'phone' });
    return p;
  }

  async list(q: { q?: string; type?: SupplierType; include_archived: boolean; limit: number; after?: string }) {
    const term = q.q?.trim();
    const phone = term ? normalizeSupplierPhone(term) : null;
    const rows = await this.tx.supplier.findMany({
      where: {
        ...(q.include_archived ? {} : { archivedAt: null }),
        ...(q.type ? { type: q.type } : {}),
        ...(q.after ? { code: { gt: q.after } } : {}),
        ...(term
          ? {
              OR: [
                { name: { contains: escapeLike(term), mode: 'insensitive' as const } },
                { code: { contains: escapeLike(term.toUpperCase()) } },
                ...(phone ? [{ phoneHash: this.phoneHash(phone) }] : []),
              ],
            }
          : {}),
      },
      orderBy: { code: 'asc' },
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((s) => this.wire(s, false)),
      next_after: rows.length > q.limit ? (page.at(-1)?.code ?? null) : null,
    };
  }

  async get(id: string) {
    const s = await this.tx.supplier.findUnique({ where: { id } });
    if (!s) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy nhà cung cấp');
    return this.wire(s, true);
  }

  async create(b: SupplierCreate) {
    const id = uuidv7();
    const phone = b.phone ? this.normalizePhone(b.phone) : null;
    const s = await catalogWrite(() =>
      this.tx.supplier.create({
        data: {
          id,
          code: b.code,
          name: b.name,
          type: b.type,
          contactName: b.contact_name ?? null,
          phoneEnc: phone ? this.cipher.encrypt(phone, supplierPhoneAad(id)) : null,
          phoneHash: phone ? this.phoneHash(phone) : null,
          bankName: b.bank_name ?? null,
          bankEnc: b.bank_account ? this.cipher.encrypt(JSON.stringify(b.bank_account), supplierBankAad(id)) : null,
          paymentTermsDays: b.payment_terms_days ?? null,
          note: b.note ?? null,
        },
      }),
    );
    const changed = [
      ...(phone ? ['phone'] : []),
      ...(b.bank_account ? ['bank_account'] : []),
      ...(b.contact_name ? ['contact_name'] : []),
      ...(b.note ? ['note'] : []),
    ];
    await this.ao.recordAudit({
      action: 'supplier.create',
      resourceType: 'supplier',
      resourceId: id,
      after: { ...this.base(s), changed_pii: changed },
    });
    return this.wire(s, true);
  }

  async update(id: string, b: SupplierUpdate) {
    const locked = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM core.suppliers WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
    if (!locked.length) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy nhà cung cấp');
    const before = await this.tx.supplier.findUniqueOrThrow({ where: { id } });
    const phone = b.phone === undefined ? undefined : b.phone === null ? null : this.normalizePhone(b.phone);
    const s = await catalogWrite(() =>
      this.tx.supplier.update({
        where: { id },
        data: {
          name: b.name,
          type: b.type,
          contactName: b.contact_name,
          ...(phone !== undefined
            ? {
                phoneEnc: phone ? this.cipher.encrypt(phone, supplierPhoneAad(id)) : null,
                phoneHash: phone ? this.phoneHash(phone) : null,
              }
            : {}),
          bankName: b.bank_name,
          ...(b.bank_account !== undefined
            ? {
                bankEnc: b.bank_account
                  ? this.cipher.encrypt(JSON.stringify(b.bank_account), supplierBankAad(id))
                  : null,
              }
            : {}),
          paymentTermsDays: b.payment_terms_days,
          note: b.note,
          archivedAt: b.archived === undefined ? undefined : b.archived ? (before.archivedAt ?? new Date()) : null,
        },
      }),
    );
    const changed = [
      ...(phone !== undefined ? ['phone'] : []),
      ...(b.bank_account !== undefined ? ['bank_account'] : []),
      ...(b.contact_name !== undefined ? ['contact_name'] : []),
      ...(b.note !== undefined ? ['note'] : []),
    ];
    await this.ao.recordAudit({
      action: 'supplier.update',
      resourceType: 'supplier',
      resourceId: id,
      before: this.base(before),
      after: { ...this.base(s), changed_pii: changed },
    });
    return this.wire(s, true);
  }

  /** Xem đủ số tài khoản (chuẩn bị chuyển khoản) — Master + step-up; ghi audit (không chứa số). */
  async revealBank(id: string) {
    const s = await this.tx.supplier.findUnique({ where: { id } });
    if (!s) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy nhà cung cấp');
    const bank = this.bankOf(s);
    if (!bank) throw new AppError('RESOURCE_NOT_FOUND', 'Nhà cung cấp chưa có tài khoản ngân hàng');
    await this.ao.recordAudit({
      action: 'supplier.bank_reveal',
      resourceType: 'supplier',
      resourceId: id,
    });
    return {
      supplier_id: id,
      bank_name: s.bankName,
      account_number: bank.account_number,
      account_holder: bank.account_holder,
    };
  }

  // ───────── SKU cung cấp ─────────

  async listSkus(id: string) {
    const s = await this.tx.supplier.findUnique({ where: { id }, select: { id: true } });
    if (!s) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy nhà cung cấp');
    const rows = await this.tx.supplierSku.findMany({
      where: { supplierId: id },
      include: { sku: { select: { skuCode: true, name: true, archivedAt: true } } },
      orderBy: { sku: { skuCode: 'asc' } },
      take: 5000,
    });
    // giá tham khảo gần nhất: tính từ phiếu nhận (CP05) — chưa có ⇒ không trả
    return {
      items: rows.map((r) => ({
        sku_id: r.skuId,
        sku_code: r.sku.skuCode,
        sku_name: r.sku.name,
        sku_archived: r.sku.archivedAt !== null,
        supplier_sku_code: r.supplierSkuCode,
        created_at: r.createdAt.toISOString(),
      })),
    };
  }

  async setSku(id: string, skuId: string, code: string | null) {
    // ERD §6.2: skus (FOR SHARE) trước, rồi nhà cung cấp (FOR SHARE) — chặn lưu trữ song song
    const sku = await this.tx.$queryRaw<{ archived: boolean }[]>`
      SELECT archived_at IS NOT NULL AS archived FROM core.skus WHERE id = ${skuId}::uuid FOR SHARE`;
    if (!sku.length) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy SKU');
    if (sku[0]?.archived) throw rule('SKU đã lưu trữ', { field: 'sku_id' });
    const sup = await this.tx.$queryRaw<{ archived: boolean }[]>`
      SELECT archived_at IS NOT NULL AS archived FROM core.suppliers WHERE id = ${id}::uuid FOR SHARE`;
    if (!sup.length) throw new AppError('RESOURCE_NOT_FOUND', 'Không tìm thấy nhà cung cấp');
    if (sup[0]?.archived) throw rule('Nhà cung cấp đã lưu trữ', { field: 'supplier_id' });
    // advisory theo (NCC, SKU): hai lần đặt song song lần đầu không cùng ghi audit before = null
    await this.tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${`supplier_sku:${id}:${skuId}`}, 0))`;
    const [before] = await this.tx.$queryRaw<{ supplier_sku_code: string | null }[]>`
      SELECT supplier_sku_code FROM core.supplier_skus
      WHERE supplier_id = ${id}::uuid AND sku_id = ${skuId}::uuid FOR UPDATE`;
    await catalogWrite(
      () => this.tx.$executeRaw`
        INSERT INTO core.supplier_skus (supplier_id, sku_id, supplier_sku_code)
        VALUES (${id}::uuid, ${skuId}::uuid, ${code})
        ON CONFLICT (supplier_id, sku_id) DO UPDATE SET supplier_sku_code = EXCLUDED.supplier_sku_code`,
    );
    const after = { supplier_id: id, sku_id: skuId, supplier_sku_code: code };
    await this.ao.recordAudit({
      action: 'supplier_sku.set',
      resourceType: 'supplier_sku',
      resourceId: `${id}:${skuId}`,
      before: before ? { ...after, supplier_sku_code: before.supplier_sku_code } : null,
      after,
    });
    return after;
  }

  async removeSku(id: string, skuId: string) {
    const [before] = await this.tx.$queryRaw<{ supplier_sku_code: string | null }[]>`
      DELETE FROM core.supplier_skus WHERE supplier_id = ${id}::uuid AND sku_id = ${skuId}::uuid
      RETURNING supplier_sku_code`;
    if (!before) throw new AppError('RESOURCE_NOT_FOUND', 'SKU không có trong danh sách của nhà cung cấp');
    await this.ao.recordAudit({
      action: 'supplier_sku.remove',
      resourceType: 'supplier_sku',
      resourceId: `${id}:${skuId}`,
      before: { supplier_id: id, sku_id: skuId, supplier_sku_code: before.supplier_sku_code },
    });
    return { supplier_id: id, sku_id: skuId, removed: true };
  }
}
