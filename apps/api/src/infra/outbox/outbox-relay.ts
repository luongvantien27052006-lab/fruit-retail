import type { Queue } from 'bullmq';
import type { PrismaService } from '../prisma.service';
import type { EventConsumer, EventEnvelope } from './events';

export const RELAY_BATCH = 100;
/** quá số lần đẩy lỗi ⇒ dead_at (giám sát xử lý tay) */
export const RELAY_MAX_ATTEMPTS = 10;
const RELAY_MAX_BACKOFF_S = 3600;
/** một lệnh Redis của relay quá hạn ⇒ coi như lỗi (không giữ khóa dòng outbox vô hạn) */
const ENQUEUE_TIMEOUT_MS = 2_000;
/** sự kiện đã đẩy nhưng consumer chưa xử lý sau chừng này ⇒ bộ quét kiểm job còn trong Redis không */
export const SWEEP_AFTER_S = 600;

/** Tùy chọn job: thử lại lùi dần ở consumer; giữ job xong 7 ngày (khóa trùng jobId), giữ job lỗi để xem lại. */
export const JOB_OPTS = {
  attempts: 8,
  backoff: { type: 'exponential' as const, delay: 2_000 },
  removeOnComplete: { age: 7 * 86400 },
  removeOnFail: false,
};

interface OutboxRow {
  id: string;
  event_type: string;
  schema_version: number;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  occurred_at: Date;
  attempts: number;
}

const envelope = (r: OutboxRow): EventEnvelope => ({
  event_id: r.id,
  event_type: r.event_type,
  schema_version: r.schema_version,
  aggregate_type: r.aggregate_type,
  aggregate_id: r.aggregate_id,
  occurred_at: r.occurred_at.toISOString(),
  payload: r.payload,
});

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        t = setTimeout(() => rej(new Error(`Redis quá ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Relay outbox (ADR-007, ADR-025). Mỗi lượt = MỘT transaction: khóa tối đa 100 dòng chưa gửi, đến hạn
 * (`FOR UPDATE SKIP LOCKED` ⇒ nhiều worker chạy song song không lấy trùng), đẩy từng dòng vào BullMQ với jobId = id sự
 * kiện (đẩy lại cùng jobId là không làm gì ⇒ worker chết sau khi đẩy mà trước khi commit thì lần sau đẩy lại không tạo
 * job trùng), rồi đánh dấu `published_at`. Dòng đẩy lỗi: attempts + 1, lùi dần 2^n giây (trần 1 giờ), quá 10 lần ⇒
 * `dead_at`. Giao "ít nhất một lần"; consumer chống trùng bằng processed_events.
 */
export class OutboxRelay {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: Queue,
    /** chỉ cho test: chạy sau khi đẩy, trước khi commit (mô phỏng worker chết giữa chừng) */
    private readonly afterEnqueue?: () => Promise<void>,
  ) {}

  /** Một lượt; trả số sự kiện đã đánh dấu gửi. */
  async relayOnce(batch = RELAY_BATCH): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<OutboxRow[]>`
          SELECT id::text, event_type, schema_version, aggregate_type, aggregate_id, payload, occurred_at, attempts
          FROM integration.outbox
          WHERE published_at IS NULL AND dead_at IS NULL AND next_attempt_at <= now()
          ORDER BY next_attempt_at, id
          LIMIT ${batch}
          FOR UPDATE SKIP LOCKED`;
        if (rows.length === 0) return 0;
        const ok: string[] = [];
        const failed: string[] = [];
        let lastError = '';
        for (const r of rows) {
          // Redis lỗi một lần ⇒ không thử các dòng còn lại trong lượt này (không giữ khóa dòng chờ timeout từng dòng)
          if (lastError) {
            failed.push(r.id);
            continue;
          }
          try {
            await withTimeout(
              this.queue.add(r.event_type, envelope(r), { ...JOB_OPTS, jobId: r.id }),
              ENQUEUE_TIMEOUT_MS,
            );
            ok.push(r.id);
          } catch (e) {
            lastError = (e instanceof Error ? e.message : String(e)).slice(0, 500) || 'lỗi không rõ';
            failed.push(r.id);
          }
        }
        if (failed.length)
          await tx.$executeRaw`
            UPDATE integration.outbox SET
              attempts = attempts + 1,
              last_error = ${lastError},
              next_attempt_at = now() + make_interval(secs => LEAST(power(2, attempts + 1)::int, ${RELAY_MAX_BACKOFF_S})),
              dead_at = CASE WHEN attempts + 1 >= ${RELAY_MAX_ATTEMPTS} THEN now() ELSE NULL END
            WHERE id = ANY(${failed}::uuid[])`;
        if (this.afterEnqueue) await this.afterEnqueue();
        if (ok.length)
          await tx.$executeRaw`
            UPDATE integration.outbox SET published_at = now(), last_error = NULL
            WHERE id = ANY(${ok}::uuid[])`;
        return ok.length;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  }

  /**
   * Bộ quét (Redis AOF `everysec` có thể mất ≤ 1 giây job khi sập — ADR-025): sự kiện đã đánh dấu gửi > 10 phút mà
   * còn consumer quan tâm chưa xử lý, và job KHÔNG còn trong Redis (không chờ, không chạy, không lỗi) ⇒ đẩy lại cùng
   * jobId. Job còn trong Redis (kể cả đang lỗi chờ xem lại) thì để yên. Trả số sự kiện đẩy lại.
   */
  async sweepOnce(consumers: readonly EventConsumer[], limit = 500): Promise<number> {
    const pairs = consumers.flatMap((c) => [...c.eventTypes].map((t) => ({ consumer: c.name, type: t })));
    if (pairs.length === 0) return 0;
    const rows = await this.prisma.$queryRaw<OutboxRow[]>`
      SELECT o.id::text, o.event_type, o.schema_version, o.aggregate_type, o.aggregate_id, o.payload, o.occurred_at, o.attempts
      FROM integration.outbox o
      JOIN jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS w(consumer text, type text) ON w.type = o.event_type
      WHERE o.published_at IS NOT NULL AND o.dead_at IS NULL
        AND o.published_at < now() - make_interval(secs => ${SWEEP_AFTER_S})
        AND NOT EXISTS (SELECT 1 FROM integration.processed_events p WHERE p.consumer = w.consumer AND p.event_id = o.id)
      GROUP BY o.id
      ORDER BY o.id
      LIMIT ${limit}`;
    let n = 0;
    for (const r of rows) {
      const job = await withTimeout(this.queue.getJob(r.id), ENQUEUE_TIMEOUT_MS);
      if (job) continue;
      await withTimeout(this.queue.add(r.event_type, envelope(r), { ...JOB_OPTS, jobId: r.id }), ENQUEUE_TIMEOUT_MS);
      n++;
    }
    return n;
  }
}
