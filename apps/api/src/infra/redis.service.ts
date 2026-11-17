import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ENV, type Env } from '../config/env';

/** Redis chỉ queue/cache/pub-sub — không là nguồn quyết định (ADR-002). */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(ENV) env: Env) {
    this.client = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    // Lỗi kết nối được báo qua health check; sự kiện 'error' không được làm sập process.
    this.client.on('error', () => undefined);
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
