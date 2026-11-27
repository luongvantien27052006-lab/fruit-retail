import type { EventConsumer, EventEnvelope } from '../infra/outbox/events';
import type { ImportProcessor } from './import-processor';
import { IMPORT_EVENT } from './imports.service';

/**
 * Consumer `catalog.import_requested` (worker, ADR-025/031). Lượt nhập chạy trong transaction RIÊNG của ImportProcessor
 * (CLS + service API); tính "đúng một lần" do chính trạng thái lượt (chỉ PENDING mới chạy) — `processed_events` của
 * runner chỉ để không gọi lại. Lỗi hệ thống được processor ghi FAILED, không ném ⇒ BullMQ không thử lại lượt hỏng.
 */
export class ImportConsumer implements EventConsumer {
  readonly name = 'catalog-import';
  readonly eventTypes = new Set([IMPORT_EVENT]);
  /** transaction của runner (processed_events) mở trong lúc lượt nhập chạy ⇒ cho dài hơn transaction nhập (4 phút) */
  readonly timeoutMs = 600_000;

  constructor(private readonly processor: ImportProcessor) {}

  async handle(ev: EventEnvelope): Promise<void> {
    const id = (ev.payload as { import_job_id?: unknown }).import_job_id;
    if (typeof id !== 'string') return;
    await this.processor.run(id);
  }
}
