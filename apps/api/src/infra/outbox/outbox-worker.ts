import { Logger } from '@nestjs/common';
import { type Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { PrismaService } from '../prisma.service';
import { ConsumerRunner } from './consumer-runner';
import { type EventConsumer, type EventEnvelope, OUTBOX_QUEUE } from './events';
import { OutboxRelay } from './outbox-relay';

export interface OutboxWorkerOptions {
  redisUrl: string;
  /** khoảng nghỉ khi outbox rỗng / lỗi (lượt có việc chạy nối tiếp ngay) */
  idleMs?: number;
  sweepEveryMs?: number;
  concurrency?: number;
}

/**
 * Tiến trình worker của outbox (ADR-002, ADR-007, ADR-025): vòng relay (DB → BullMQ), bộ quét job mất trong Redis, và
 * BullMQ Worker chạy consumer. Lỗi không nuốt: ghi log error có giới hạn, vòng lặp tiếp tục (tự hồi phục khi phụ thuộc
 * quay lại). Dừng: chờ lượt relay đang chạy + job đang chạy xong rồi đóng kết nối.
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
  private wake?: () => void;

  constructor(
    prisma: PrismaService,
    private readonly consumers: readonly EventConsumer[],
    private readonly opts: OutboxWorkerOptions,
  ) {
    // BullMQ: kết nối Worker cần maxRetriesPerRequest = null (lệnh chặn); Queue dùng kết nối riêng, lỗi nhanh
    this.conn = new Redis(opts.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
    this.workerConn = new Redis(opts.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    for (const c of [this.conn, this.workerConn]) c.on('error', (e: Error) => this.warn(`Redis: ${e.message}`));
    this.queue = new Queue(OUTBOX_QUEUE, { connection: this.conn });
    this.relay = new OutboxRelay(prisma, this.queue);
    this.runner = new ConsumerRunner(prisma, consumers);
  }

  private lastWarn = 0;
  private warn(msg: string) {
    const now = Date.now();
    if (now - this.lastWarn < 30_000) return;
    this.lastWarn = now;
    this.log.error(msg);
  }

  async start(): Promise<void> {
    await this.conn.connect().catch((e: Error) => this.warn(`Redis chưa sẵn sàng: ${e.message}`));
    this.worker = new Worker(
      OUTBOX_QUEUE,
      async (job: Job<EventEnvelope>) => {
        await this.runner.process(job.data);
      },
      { connection: this.workerConn, concurrency: this.opts.concurrency ?? 4, autorun: true },
    );
    this.worker.on('failed', (job, err) => {
      const final = job && job.attemptsMade >= (job.opts.attempts ?? 1);
      // hết lượt thử ⇒ job nằm ở tập "failed" (giữ lại để xem/chạy lại tay) — luôn ghi error
      if (final)
        this.log.error(
          `sự kiện ${job?.id ?? '?'} (${job?.name ?? '?'}) lỗi hẳn sau ${job?.attemptsMade} lần: ${err.message}`,
        );
    });
    this.worker.on('error', (e) => this.warn(`BullMQ worker: ${e.message}`));
    this.relayLoop = this.loop();
    const sweepEvery = this.opts.sweepEveryMs ?? 5 * 60_000;
    this.sweepTimer = setInterval(() => {
      this.relay
        .sweepOnce(this.consumers)
        .then((n) => n && this.log.warn(`bộ quét đẩy lại ${n} sự kiện mất khỏi Redis`))
        .catch((e: unknown) => this.warn(`bộ quét lỗi: ${e instanceof Error ? e.message : String(e)}`));
    }, sweepEvery);
  }

  /** Đánh thức vòng relay ngay (vd sau khi API ghi outbox — tùy chọn, không bắt buộc). */
  poke(): void {
    this.wake?.();
  }

  private async loop(): Promise<void> {
    const idle = this.opts.idleMs ?? 1_000;
    while (!this.stopped) {
      let n = 0;
      try {
        n = await this.relay.relayOnce();
      } catch (e) {
        this.warn(`relay lỗi: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (n > 0 || this.stopped) continue;
      await new Promise<void>((r) => {
        const t = setTimeout(r, idle);
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
    await this.worker?.close();
    await this.queue.close();
    this.conn.disconnect();
    this.workerConn.disconnect();
  }
}
