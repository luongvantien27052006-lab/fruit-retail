import { Logger } from '@nestjs/common';
import { type Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { PrismaService } from '../prisma.service';
import { ConsumerRunner } from './consumer-runner';
import { type EventConsumer, type EventEnvelope, OUTBOX_QUEUE } from './events';
import { OutboxRelay } from './outbox-relay';

export interface OutboxWorkerOptions {
  redisUrl: string;
  /** khoảng nghỉ khi outbox rỗng (lượt có việc chạy nối tiếp ngay) */
  idleMs?: number;
  sweepEveryMs?: number;
  concurrency?: number;
}

const REDIS_DOWN_MAX_BACKOFF_MS = 30_000;
const LOG_WINDOW_MS = 30_000;

/**
 * Tiến trình worker của outbox (ADR-002, ADR-007, ADR-025): vòng relay (DB → BullMQ), bộ quét, BullMQ Worker chạy
 * consumer. Lỗi không nuốt (kiểm thử lát 7):
 * - log lỗi lặp lại được HÃM THEO TỪNG KHÓA (30 giây/khóa) và báo số dòng đã bỏ — lỗi loại này không che lỗi loại khác;
 * - sự kiện chuyển dead_at và job lỗi HẲN (hết lượt thử, stalled quá giới hạn, UnrecoverableError) luôn ghi error;
 * - Redis sập ⇒ vòng relay lùi dần (1 s → 30 s), không cộng attempts của sự kiện.
 */
export class OutboxWorker {
  private readonly log = new Logger('OutboxWorker');
  private readonly conn: Redis;
  private readonly workerConn: Redis;
  readonly queue: Queue;
  private worker?: Worker;
  readonly relay: OutboxRelay;
  readonly runner: ConsumerRunner;
  private stopped = false;
  private relayLoop?: Promise<void>;
  private sweepTimer?: NodeJS.Timeout;
  private sweeping?: Promise<void>;
  private wake?: () => void;
  private readonly throttle = new Map<string, { at: number; dropped: number }>();

  constructor(
    prisma: PrismaService,
    private readonly consumers: readonly EventConsumer[],
    private readonly opts: OutboxWorkerOptions,
  ) {
    // BullMQ: kết nối Worker cần maxRetriesPerRequest = null (lệnh chặn); Queue dùng kết nối riêng, lỗi nhanh.
    // Queue tự kết nối — không gọi connect() lần nữa (trước: lỗi giả "already connecting" mỗi lần khởi động).
    this.conn = new Redis(opts.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.workerConn = new Redis(opts.redisUrl, { maxRetriesPerRequest: null });
    this.conn.on('error', (e: Error) => this.error('redis-queue', `Redis (queue): ${e.message}`));
    this.workerConn.on('error', (e: Error) => this.error('redis-worker', `Redis (worker): ${e.message}`));
    this.queue = new Queue(OUTBOX_QUEUE, { connection: this.conn });
    this.relay = new OutboxRelay(prisma, this.queue, {
      ping: async () => (await this.conn.ping()) === 'PONG',
      onDead: (d) =>
        this.log.error(`sự kiện ${d.id} (${d.eventType}) chuyển dead_at (đẩy lỗi quá số lần cho phép): ${d.error}`),
    });
    this.runner = new ConsumerRunner(prisma, consumers);
  }

  /** log error hãm theo khóa; lần mở cửa sổ sau báo số dòng đã bỏ */
  private error(key: string, msg: string) {
    const now = Date.now();
    const t = this.throttle.get(key);
    if (t && now - t.at < LOG_WINDOW_MS) {
      t.dropped++;
      return;
    }
    const dropped = t?.dropped ?? 0;
    this.throttle.set(key, { at: now, dropped: 0 });
    this.log.error(dropped ? `${msg} (bỏ ${dropped} dòng cùng loại trong ${LOG_WINDOW_MS / 1000} s trước)` : msg);
  }

  async start(): Promise<void> {
    this.worker = new Worker(
      OUTBOX_QUEUE,
      async (job: Job<EventEnvelope>) => {
        await this.runner.process(job.data);
      },
      // stalled (worker chết khi đang xử lý) tới 3 lần mới coi là lỗi hẳn — mặc định BullMQ là 1
      { connection: this.workerConn, concurrency: this.opts.concurrency ?? 4, maxStalledCount: 3 },
    );
    this.worker.on('failed', (job, err) => {
      // lỗi HẲN khi không còn được thử lại: hết lượt, stalled quá giới hạn, UnrecoverableError ⇒ job nằm tập "failed"
      const willRetry =
        !!job && err.name !== 'UnrecoverableError' && job.attemptsMade < (job.opts.attempts ?? 1) && !job.finishedOn;
      if (!willRetry)
        this.log.error(
          `sự kiện ${job?.id ?? '?'} (${job?.name ?? '?'}) lỗi hẳn sau ${job?.attemptsMade ?? '?'} lần: ${err.message}`,
        );
      else this.error(`consumer:${job?.name ?? '?'}`, `sự kiện ${job?.id ?? '?'} lỗi, sẽ thử lại: ${err.message}`);
    });
    this.worker.on('error', (e) => this.error('bullmq-worker', `BullMQ worker: ${e.message}`));
    this.relayLoop = this.loop();
    const sweepEvery = this.opts.sweepEveryMs ?? 5 * 60_000;
    this.sweepTimer = setInterval(() => {
      if (this.sweeping) return; // lượt trước chưa xong ⇒ không chồng
      this.sweeping = this.relay
        .sweepOnce(this.consumers)
        .then((r) => {
          if (r.requeued) this.log.warn(`bộ quét đẩy lại ${r.requeued} sự kiện (mất khỏi Redis / consumer mới)`);
          if (r.failed) this.error('sweep-failed', `bộ quét thấy ${r.failed} sự kiện có job lỗi hẳn chưa xử lý`);
        })
        .catch((e: unknown) => this.error('sweep', `bộ quét lỗi: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => {
          this.sweeping = undefined;
        });
    }, sweepEvery);
  }

  /** Đánh thức vòng relay ngay (tùy chọn — không có thì chậm tối đa idleMs). */
  poke(): void {
    this.wake?.();
  }

  private async loop(): Promise<void> {
    const idle = this.opts.idleMs ?? 1_000;
    let backoff = idle;
    while (!this.stopped) {
      let n = 0;
      let failed = false;
      try {
        n = await this.relay.relayOnce();
      } catch (e) {
        failed = true;
        this.error('relay', `relay lỗi: ${e instanceof Error ? e.message : String(e)}`);
      }
      const re = this.relay.lastRowError;
      if (re)
        this.error(
          `relay-row:${re.eventType}`,
          `relay: sự kiện ${re.id} (${re.eventType}) đẩy lỗi, sẽ thử lại: ${re.error}`,
        );
      if (this.relay.redisDown) {
        failed = true;
        this.error('relay-redis', 'relay: Redis không dùng được — sự kiện giữ nguyên trong outbox, thử lại sau');
      }
      if (n > 0 && !failed) {
        backoff = idle;
        continue;
      }
      if (this.stopped) break;
      backoff = failed ? Math.min(backoff * 2, REDIS_DOWN_MAX_BACKOFF_MS) : idle;
      await new Promise<void>((r) => {
        const t = setTimeout(r, backoff);
        this.wake = () => {
          clearTimeout(t);
          r();
        };
      });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    clearInterval(this.sweepTimer);
    await this.relayLoop;
    await this.sweeping;
    await this.worker?.close();
    await this.queue.close();
    this.conn.disconnect();
    this.workerConn.disconnect();
  }
}
