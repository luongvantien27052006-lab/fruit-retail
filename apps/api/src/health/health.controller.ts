import { Controller, Get, HttpException, HttpStatus, Logger, Req } from '@nestjs/common';
import { Public } from '../common/access';
import type { Request } from 'express';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';

type Check = 'ok' | 'down';

const TIMEOUT_MS = 2000;
async function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`quá ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** GET /v1/health — public (OpenAPI x-permission: public). Báo đúng trạng thái phụ thuộc, không giả thành công. */
@Controller('health')
export class HealthController {
  private readonly log = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get()
  async health(@Req() req: Request): Promise<{ status: 'ok'; checks: Record<string, Check> }> {
    const [db, redis] = await Promise.all([
      this.check('db', () => this.prisma.$queryRaw`SELECT 1`),
      this.check('redis', () => this.pingRedis()),
    ]);
    const checks = { db, redis };
    if (db === 'down' || redis === 'down') {
      throw new HttpException(
        {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'Phụ thuộc hạ tầng không sẵn sàng',
          details: { checks },
          request_id: String(req.id),
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { status: 'ok', checks };
  }

  /** Chạy một kiểm tra; khi lỗi ghi warn kèm lý do (không ghi URL/secret) rồi trả 'down'. */
  private async check(name: string, fn: () => Promise<unknown>): Promise<Check> {
    try {
      await withTimeout(fn());
      return 'ok';
    } catch (err) {
      this.log.warn(`health: ${name} down — ${err instanceof Error ? err.message : String(err)}`);
      return 'down';
    }
  }

  private async pingRedis(): Promise<void> {
    await this.redis.ensureConnected();
    const pong = await this.redis.client.ping();
    if (pong !== 'PONG') throw new Error('redis ping không trả PONG');
  }
}
