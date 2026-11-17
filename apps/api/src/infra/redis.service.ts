import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ENV, type Env } from '../config/env';

const ERROR_LOG_INTERVAL_MS = 30_000;

/** Redis chỉ queue/cache/pub-sub — không là nguồn quyết định (ADR-002). */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis;
  private readonly log = new Logger(RedisService.name);
  private lastErrorLogAt = 0;
  private connecting: Promise<void> | null = null;

  constructor(@Inject(ENV) env: Env) {
    this.client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 5_000,
    });
    // Không nuốt lỗi: ghi warn có giới hạn tần suất (chỉ mã lỗi, không ghi URL/mật khẩu). Process không sập.
    this.client.on('error', (err: NodeJS.ErrnoException) => {
      const now = Date.now();
      if (now - this.lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
      this.lastErrorLogAt = now;
      this.log.warn(`Redis lỗi kết nối: ${err.code ?? err.name} — ${err.message}`);
    });
    this.client.on('ready', () => this.log.log('Redis sẵn sàng'));
  }

  onModuleInit(): void {
    // Kết nối nền một lần lúc khởi động; health check dùng chung promise này (không connect chồng nhau).
    void this.ensureConnected().catch(() => undefined);
  }

  /** Bảo đảm đã kết nối; nhiều lời gọi đồng thời dùng chung một promise. */
  async ensureConnected(): Promise<void> {
    const status = this.client.status;
    if (status === 'ready') return;
    if (!this.connecting && (status === 'wait' || status === 'end' || status === 'close')) {
      this.connecting = this.client.connect().finally(() => {
        this.connecting = null;
      });
    }
    if (this.connecting) {
      await this.connecting;
      return;
    }
    // Đang tự kết nối lại (connecting/reconnecting) mà không do mình khởi tạo → báo chưa sẵn sàng, không chờ vô hạn.
    throw new Error(`Redis chưa sẵn sàng (${status})`);
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
