import type { PrismaService } from '../prisma.service';
import type { EventConsumer, EventEnvelope } from './events';

/**
 * Chạy MỘT sự kiện qua mọi consumer quan tâm (ADR-007, ADR-025). Mỗi consumer một transaction riêng: chèn
 * `processed_events(consumer, event_id)` (trùng ⇒ bỏ qua, đã xử lý) rồi `handle` — cùng commit hoặc cùng rollback.
 * Consumer A lỗi không làm mất tác dụng đã commit của consumer B; lỗi được ném lên để BullMQ thử lại cả job, consumer đã
 * xong sẽ tự bỏ qua nhờ processed_events.
 */
export class ConsumerRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consumers: readonly EventConsumer[],
  ) {}

  /** Trả danh sách consumer thực sự xử lý lần này (không gồm consumer đã xử lý trước đó / không quan tâm). */
  async process(ev: EventEnvelope): Promise<string[]> {
    const done: string[] = [];
    const errors: { consumer: string; err: unknown }[] = [];
    for (const c of this.consumers) {
      if (!c.eventTypes.has(ev.event_type)) continue;
      try {
        const ran = await this.prisma.$transaction(
          async (tx) => {
            const ins = await tx.$executeRaw`
              INSERT INTO integration.processed_events (consumer, event_id) VALUES (${c.name}, ${ev.event_id}::uuid)
              ON CONFLICT DO NOTHING`;
            if (ins !== 1) return false;
            await c.handle(ev, tx);
            return true;
          },
          { timeout: 30_000, maxWait: 10_000 },
        );
        if (ran) done.push(c.name);
      } catch (err) {
        errors.push({ consumer: c.name, err });
      }
    }
    if (errors.length) {
      const first = errors[0];
      const e = new Error(
        `consumer lỗi: ${errors.map((x) => x.consumer).join(', ')} — ${first?.err instanceof Error ? first.err.message : String(first?.err)}`,
      );
      (e as Error & { cause?: unknown }).cause = first?.err;
      throw e;
    }
    return done;
  }
}
