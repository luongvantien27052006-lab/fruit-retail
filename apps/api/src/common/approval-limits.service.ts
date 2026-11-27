import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { Principal } from './access';
import type { Tx } from './audit-outbox.service';

export type ApprovalAction =
  | 'LINE_DELETE'
  | 'SALE_VOID'
  | 'REFUND'
  | 'SPOILAGE_APPROVE'
  | 'STOCKTAKE_ADJUST'
  | 'MANUAL_WEIGHT'
  | 'NO_SALE_OPEN'
  | 'MARKDOWN';

export interface LimitRow {
  role: string;
  allowed: boolean;
  maxAmount: bigint | null;
  maxPctBp: number | null;
  limitMode: string;
  sameDayOnly: boolean;
  requiresPin: boolean;
  requiresNote: boolean;
}

export interface ApprovalRequest {
  action: ApprovalAction;
  /** số tiền của thao tác (VND, số nguyên) — bắt buộc khi dòng hạn mức có ngưỡng tiền hoặc % */
  amount?: bigint;
  /** giá trị gốc để tính % (vd giá trị hóa đơn / tồn sổ sách) — bắt buộc khi có ngưỡng % */
  base?: bigint;
  /** thao tác trên chứng từ trong cùng ngày kinh doanh */
  sameDay?: boolean;
}

export type ApprovalDecision =
  | { allowed: true; role: string; requiresPin: boolean; requiresNote: boolean }
  | { allowed: false; reason: 'NO_LIMIT_ROW' | 'NOT_ALLOWED' | 'OVER_LIMIT' | 'SAME_DAY_ONLY' | 'MISSING_INPUT' };

/**
 * Một dòng hạn mức có cho phép yêu cầu này không (§2.3, NC-19(c)): cả hai ngưỡng NULL = không giới hạn; một ngưỡng ⇒
 * phải đạt ngưỡng đó; hai ngưỡng ⇒ ANY: đạt MỘT là được ("≤ 10% hoặc ≤ 50.000đ"), ALL: phải đạt cả hai. Thiếu dữ liệu
 * cần để so ngưỡng ⇒ từ chối (không đoán).
 */
export function evaluateRow(r: LimitRow, q: ApprovalRequest): ApprovalDecision {
  if (!r.allowed) return { allowed: false, reason: 'NOT_ALLOWED' };
  if (r.sameDayOnly && q.sameDay !== true) return { allowed: false, reason: 'SAME_DAY_ONLY' };
  // số tiền / giá trị gốc âm là lỗi của người gọi — không bao giờ coi là "trong hạn mức"
  if ((q.amount !== undefined && q.amount < 0n) || (q.base !== undefined && q.base < 0n))
    return { allowed: false, reason: 'MISSING_INPUT' };
  const checks: boolean[] = [];
  if (r.maxAmount !== null) {
    if (q.amount === undefined) return { allowed: false, reason: 'MISSING_INPUT' };
    checks.push(q.amount <= r.maxAmount);
  }
  if (r.maxPctBp !== null) {
    if (q.amount === undefined || q.base === undefined || q.base <= 0n)
      return { allowed: false, reason: 'MISSING_INPUT' };
    // amount / base ≤ pct/10000 ⇔ amount·10000 ≤ pct·base (số nguyên, không làm tròn — ADR-004)
    checks.push(q.amount * 10000n <= BigInt(r.maxPctBp) * q.base);
  }
  const ok = checks.length === 0 || (r.limitMode === 'ALL' ? checks.every(Boolean) : checks.some(Boolean));
  if (!ok) return { allowed: false, reason: 'OVER_LIMIT' };
  return { allowed: true, role: r.role, requiresPin: r.requiresPin, requiresNote: r.requiresNote };
}

/** Nhiều vai trò: cho phép nếu MỘT vai trò cho phép; ưu tiên dòng ít yêu cầu nhất (không PIN, không ghi chú). */
export function decide(rows: readonly LimitRow[], q: ApprovalRequest): ApprovalDecision {
  if (rows.length === 0) return { allowed: false, reason: 'NO_LIMIT_ROW' };
  const results = rows.map((r) => evaluateRow(r, q));
  const ok = results.filter((d): d is Extract<ApprovalDecision, { allowed: true }> => d.allowed);
  if (ok.length) return ok.sort((a, b) => cost(a) - cost(b))[0] as ApprovalDecision;
  const order = ['OVER_LIMIT', 'SAME_DAY_ONLY', 'MISSING_INPUT', 'NOT_ALLOWED', 'NO_LIMIT_ROW'] as const;
  for (const r of order) if (results.some((d) => !d.allowed && d.reason === r)) return { allowed: false, reason: r };
  return { allowed: false, reason: 'NO_LIMIT_ROW' };
}
const cost = (d: { requiresPin: boolean; requiresNote: boolean }) => Number(d.requiresPin) + Number(d.requiresNote);

/**
 * Hạn mức duyệt đọc từ DỮ LIỆU (`core.approval_limits`, Master sửa qua PUT /admin/approval-limits) — không có hằng số
 * hạn mức trong code (kế hoạch CP03 lát 6). Không có dòng = không được làm. Vai trò lấy từ Principal (nhân viên trên
 * máy POS: chỉ vai trò ở cửa hàng của thiết bị). Người gọi (CP07/CP10/CP17) vẫn phải kiểm mã quyền + phạm vi cửa hàng.
 */
@Injectable()
export class ApprovalLimitsService {
  constructor(@Inject(TransactionHost) private readonly txHost: Tx) {}

  async check(p: Principal, q: ApprovalRequest): Promise<ApprovalDecision> {
    const roles = [...p.roles];
    if (roles.length === 0) return { allowed: false, reason: 'NO_LIMIT_ROW' };
    const rows = await this.txHost.tx.approvalLimit.findMany({
      where: { role: { in: roles as never[] }, action: q.action },
      select: {
        role: true,
        allowed: true,
        maxAmount: true,
        maxPctBp: true,
        limitMode: true,
        sameDayOnly: true,
        requiresPin: true,
        requiresNote: true,
      },
    });
    return decide(rows, q);
  }
}
