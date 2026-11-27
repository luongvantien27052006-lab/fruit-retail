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
  /** runner không giữ transaction trong lúc lượt chạy (review TS lát 5 C4) — đúng một lần nhờ trạng thái lượt */
  readonly selfManaged = true;

  constructor(private readonly processor: ImportProcessor) {}

  async handle(ev: EventEnvelope): Promise<void> {
    const id = (ev.payload as { import_job_id?: unknown }).import_job_id;
    if (typeof id !== 'string') return;
    await this.processor.run(id);
  }
}
