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
/** cửa sổ quét: job xong giữ 7 ngày ⇒ quét tới 8 ngày (cũ hơn: không tự backfill — xem ADR-025) */
export const SWEEP_WINDOW_S = 8 * 86400;
/** trần thời gian đẩy trong một lượt relay (transaction 60 s) */
const RELAY_BUDGET_MS = 40_000;

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
    private readonly opts: {
      /** Redis còn trả lời không (PING) — phân biệt lỗi hạ tầng với lỗi riêng của dòng; thiếu ⇒ coi như sập (an toàn) */
      ping?: () => Promise<boolean>;
      /** báo sự kiện vừa chuyển dead_at (worker ghi log error, không qua bộ hãm) */
      onDead?: (d: { id: string; eventType: string; error: string }) => void;
      /** chỉ cho test: chạy sau khi đẩy, trước khi commit (mô phỏng worker chết giữa chừng) */
      afterEnqueue?: () => Promise<void>;
    } = {},
  ) {}

  /** lượt relay gần nhất gặp Redis không dùng được (vòng lặp lùi dần, không cộng attempts) */
  redisDown = false;
  /** lỗi RIÊNG của dòng ở lượt gần nhất (chưa tới dead) — worker ghi log có hãm; null nếu không có */
  lastRowError: { id: string; eventType: string; error: string } | null = null;

  /**
   * Một lượt; trả số sự kiện đã đánh dấu gửi, hoặc `REDIS_DOWN` khi Redis không dùng được (người gọi lùi cả vòng lặp).
   * C1 (kiểm thử lát 7): lỗi HẠ TẦNG (Redis không kết nối / quá hạn, PING cũng lỗi) KHÔNG cộng attempts, KHÔNG bao giờ
   * đặt dead_at — Redis sập lâu không được giết sự kiện. Chỉ lỗi RIÊNG của dòng (Redis vẫn PING được) mới cộng attempts /
   * lùi dần / dead_at; dòng chưa thử trong lượt không bị đụng tới.
   */
  async relayOnce(batch = RELAY_BATCH): Promise<number> {
    this.redisDown = false;
    this.lastRowError = null;
    let dead: { id: string; eventType: string; error: string } | null = null;
    const n = await this.prisma.$transaction(
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
        let failedRow: { id: string; error: string } | null = null;
        let down = false;
        const started = Date.now();
        for (const r of rows) {
          // T6: trần thời gian cả lượt — Redis chậm đều không làm transaction quá hạn rồi rollback lặp mãi
          if (Date.now() - started > RELAY_BUDGET_MS) break;
          try {
            await withTimeout(
              this.queue.add(r.event_type, envelope(r), { ...JOB_OPTS, jobId: r.id }),
              ENQUEUE_TIMEOUT_MS,
            );
            ok.push(r.id);
          } catch (e) {
            const error = (e instanceof Error ? e.message : String(e)).slice(0, 500) || 'lỗi không rõ';
            // lỗi hạ tầng theo NỘI DUNG lỗi (kiểm thử lần 2): Redis PING được mà vẫn từ chối ghi (OOM, MISCONF, READONLY…)
            // hoặc quá hạn ⇒ không phải lỗi của dòng; PING lỗi cũng là hạ tầng
            down = isInfraError(e) || !(await this.redisAlive());
            if (!down) {
              failedRow = { id: r.id, error };
              this.lastRowError = { id: r.id, eventType: r.event_type, error };
            }
            break; // không thử tiếp trong lượt này
          }
        }
        if (failedRow) {
          const [d] = await tx.$queryRaw<{ dead: boolean; event_type: string }[]>`
            UPDATE integration.outbox SET
              attempts = attempts + 1,
              last_error = ${failedRow.error},
              next_attempt_at = now() + make_interval(secs => LEAST(power(2, attempts + 1)::int, ${RELAY_MAX_BACKOFF_S})),
              dead_at = CASE WHEN attempts + 1 >= ${RELAY_MAX_ATTEMPTS} THEN now() ELSE NULL END
            WHERE id = ${failedRow.id}::uuid
            RETURNING dead_at IS NOT NULL AS dead, event_type`;
          // dòng chết: luôn báo (không qua bộ hãm tần suất) — cần người xử lý
          if (d?.dead) dead = { id: failedRow.id, eventType: d.event_type, error: failedRow.error };
        }
        if (this.opts.afterEnqueue) await this.opts.afterEnqueue();
        if (ok.length)
          await tx.$executeRaw`
            UPDATE integration.outbox SET published_at = now(), last_error = NULL
            WHERE id = ANY(${ok}::uuid[])`;
        this.redisDown = down;
        return ok.length;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    // báo SAU commit (commit lỗi ⇒ không báo động giả)
    if (dead) this.opts.onDead?.(dead);
    return n;
  }

  private async redisAlive(): Promise<boolean> {
    if (!this.opts.ping) return false;
    try {
      return await withTimeout(this.opts.ping(), 1_000);
    } catch {
      return false;
    }
  }

  private sweepCursor: string | null = null;

  /**
   * Bộ quét (ADR-025; C3/C4 kiểm thử lát 7). Ứng viên: sự kiện đã gửi 10 phút – 8 ngày trước (job xong giữ 7 ngày), còn
   * consumer quan tâm chưa có processed_events. Duyệt theo CON TRỎ id (mỗi lượt tiếp từ chỗ cũ, hết thì vòng lại) ⇒ job
   * lỗi tồn đọng không chặn đầu hàng mãi.
   * - job không còn trong Redis (mất do AOF) ⇒ đẩy lại cùng jobId;
   * - job đã XONG mà consumer quan tâm vẫn chưa xử lý (consumer mới thêm sau — backfill) ⇒ xóa job cũ, đẩy lại (an toàn
   *   nhờ processed_events);
   * - job đang chờ/chạy ⇒ để yên; job LỖI HẲN ⇒ để yên (đã báo khi lỗi), đếm vào `failed`.
   */
  async sweepOnce(
    consumers: readonly EventConsumer[],
    limit = 500,
  ): Promise<{ requeued: number; failed: number; scanned: number }> {
    const pairs = consumers.flatMap((c) => [...c.eventTypes].map((t) => ({ consumer: c.name, type: t })));
    if (pairs.length === 0) return { requeued: 0, failed: 0, scanned: 0 };
    const after = this.sweepCursor;
    const rows = await this.prisma.$queryRaw<OutboxRow[]>`
      SELECT o.id::text, o.event_type, o.schema_version, o.aggregate_type, o.aggregate_id, o.payload, o.occurred_at, o.attempts
      FROM integration.outbox o
      JOIN jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS w(consumer text, type text) ON w.type = o.event_type
      WHERE o.published_at IS NOT NULL AND o.dead_at IS NULL
        AND o.published_at < now() - make_interval(secs => ${SWEEP_AFTER_S})
        AND o.published_at > now() - make_interval(secs => ${SWEEP_WINDOW_S})
        AND (${after}::uuid IS NULL OR o.id > ${after}::uuid)
        AND NOT EXISTS (SELECT 1 FROM integration.processed_events p WHERE p.consumer = w.consumer AND p.event_id = o.id)
      GROUP BY o.id
      ORDER BY o.id
      LIMIT ${limit}`;
    this.sweepCursor = rows.length < limit ? null : (rows.at(-1)?.id ?? null);
    let requeued = 0;
    let failed = 0;
    for (const r of rows) {
      const job = await withTimeout(this.queue.getJob(r.id), ENQUEUE_TIMEOUT_MS);
      if (job) {
        const state = await withTimeout(job.getState(), ENQUEUE_TIMEOUT_MS);
        if (state === 'failed') {
          failed++;
          continue;
        }
        if (state !== 'completed') continue;
        await withTimeout(job.remove(), ENQUEUE_TIMEOUT_MS);
      }
      await withTimeout(this.queue.add(r.event_type, envelope(r), { ...JOB_OPTS, jobId: r.id }), ENQUEUE_TIMEOUT_MS);
      requeued++;
    }
    return { requeued, failed, scanned: rows.length };
  }
}

/**
 * Lỗi HẠ TẦNG của Redis (không phải của dòng): quá hạn / kết nối, hoặc ReplyError mà Redis vẫn PING được nhưng từ chối
 * ghi — OOM (maxmemory), MISCONF (đĩa/AOF), READONLY (replica sau failover), LOADING, NOAUTH, CLUSTERDOWN, BUSY,
 * MASTERDOWN, NOREPLICAS. Dữ liệu một dòng (jsonb, uuid) gần như không thể làm Redis lỗi ⇒ mặc định nghiêng về hạ tầng.
 */
export function isInfraError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? '';
  const msg = e instanceof Error ? e.message : String(e);
  if (name !== 'ReplyError') return true; // timeout, ECONNREFUSED, Connection is closed, MaxRetriesPerRequest…
  return /^(TRYAGAIN|OOM|MISCONF|READONLY|LOADING|NOAUTH|WRONGPASS|CLUSTERDOWN|BUSY|MASTERDOWN|NOREPLICAS|NOPERM)\b/.test(
    msg,
  );
}
