import type { Prisma } from '../../generated/prisma/client';

/** Hàng đợi BullMQ nhận sự kiện từ outbox (ADR-007, ADR-025). Một job = một sự kiện, jobId = id sự kiện. */
export const OUTBOX_QUEUE = 'outbox-events';

/** Phong bì sự kiện gửi cho consumer — khớp `packages/contracts/events/*.json` (event_id, event_type, …). */
export interface EventEnvelope {
  event_id: string;
  event_type: string;
  schema_version: number;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  payload: unknown;
}

/** Client transaction Prisma thô của worker (không qua TX_PRISMA/CLS — worker không có request). */
export type WorkerTx = Prisma.TransactionClient;

/**
 * Consumer sự kiện (ADR-007): `handle` chạy trong CÙNG transaction với dòng `integration.processed_events(consumer,
 * event_id)` ⇒ tác dụng xảy ra đúng một lần dù sự kiện được giao nhiều lần. Ném lỗi ⇒ rollback cả hai, BullMQ thử lại.
 */
export interface EventConsumer {
  /** tên ổn định, ghi vào processed_events — đổi tên = consumer mới (xử lý lại từ đầu) */
  readonly name: string;
  /** loại sự kiện quan tâm; sự kiện khác bỏ qua (không ghi processed_events) */
  readonly eventTypes: ReadonlySet<string>;
  handle(event: EventEnvelope, tx: WorkerTx): Promise<void>;
  /**
   * Consumer TỰ QUẢN idempotency (việc dài — nhập file): runner KHÔNG mở transaction quanh `handle` (kết nối "idle in
   * transaction" bị Postgres cắt sau 30 s); bỏ qua nếu đã có processed_events, chạy `handle` (tx = null), xong mới ghi
   * processed_events. Consumer phải tự bảo đảm chạy lại không gây tác dụng lặp (vd trạng thái lượt PENDING → RUNNING).
   */
  readonly selfManaged?: boolean;
}

export const EVENT_CONSUMERS = Symbol('EVENT_CONSUMERS');
