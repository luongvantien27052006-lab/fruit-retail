import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { ClsService } from 'nestjs-cls';
import { v7 as uuidv7 } from 'uuid';
import { Prisma } from '../generated/prisma/client';
import type { TxPrisma } from '../infra/tx-prisma';
import { toJsonSafe } from './json-safe';
import type { RequestStore } from './request-context';

export type Tx = TransactionHost<TransactionalAdapterPrisma<TxPrisma>>;

const ACTION_RE = /^[a-z_]+(\.[a-z_]+)+$/;
const EVENT_TYPE_RE = /^[a-z_]+\.[a-z_]+$/;
const IPV4_OR_6_RE = /^[0-9a-fA-F:.]+$/;

export interface AuditEntry {
  /** vd `store.rename`, `user.role_assign` */
  action: string;
  resourceType: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

export interface OutboxEvent {
  /** khớp tên file packages/contracts/events/<event_type>.json */
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

/**
 * Ghi audit + outbox CÙNG transaction nghiệp vụ (FR-INV-10, ADR-007, ADR-016). Gọi ngoài transaction ⇒ ném lỗi
 * (không bao giờ ghi lẻ). Người thực hiện, IP, thiết bị, request_id lấy từ CLS.
 */
@Injectable()
export class AuditOutboxService {
  constructor(
    @Inject(TransactionHost) private readonly txHost: Tx,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  private requireTx(what: string): void {
    if (!this.txHost.isTransactionActive()) throw new Error(`${what} chỉ được gọi trong transaction đang mở (ADR-016)`);
  }

  async recordAudit(e: AuditEntry): Promise<string> {
    this.requireTx('recordAudit');
    if (!ACTION_RE.test(e.action)) throw new Error(`action audit sai định dạng: ${e.action}`);
    const p = this.cls.get('principal');
    const ip = this.cls.get('ip');
    const id = uuidv7();
    await this.txHost.tx.auditLog.create({
      data: {
        id,
        actorId: p?.userId ?? null,
        actorType: p?.userType ?? null,
        role: p?.role ?? null,
        ip: ip && IPV4_OR_6_RE.test(ip) ? ip : null,
        // chỉ thiết bị POS đã xác minh (khóa thiết bị); X-Device-Id client tự khai không ghi vào nhật ký
        deviceId: p?.posDeviceId ?? null,
        requestId: this.cls.get('requestId') ?? null,
        action: e.action,
        resourceType: e.resourceType,
        resourceId: e.resourceId ?? null,
        before: jsonOrNull(e.before),
        after: jsonOrNull(e.after),
        reason: e.reason ?? null,
      },
      select: { id: true },
    });
    this.cls.set('auditCount', (this.cls.get('auditCount') ?? 0) + 1);
    return id;
  }

  async emitEvent(e: OutboxEvent): Promise<string> {
    this.requireTx('emitEvent');
    if (!EVENT_TYPE_RE.test(e.eventType)) throw new Error(`event_type sai định dạng: ${e.eventType}`);
    if (!Number.isInteger(e.schemaVersion) || e.schemaVersion < 1) throw new Error('schema_version phải ≥ 1');
    const id = uuidv7();
    await this.txHost.tx.outbox.create({
      data: {
        id,
        eventType: e.eventType,
        schemaVersion: e.schemaVersion,
        aggregateType: e.aggregateType,
        aggregateId: e.aggregateId,
        // payload sự kiện: tiền là chuỗi (codec); có khóa nhạy cảm ⇒ ném lỗi (sự kiện đi qua BullMQ/log — ADR-015/016)
        payload: toJsonSafe(e.payload, 'reject') as Prisma.InputJsonValue,
        occurredAt: new Date(),
      },
      select: { id: true },
    });
    return id;
  }
}

function jsonOrNull(v: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (v === undefined || v === null) return Prisma.JsonNull;
  return toJsonSafe(v, 'redact') as Prisma.InputJsonValue;
}
