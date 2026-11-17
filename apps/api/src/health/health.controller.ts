import { Controller, Get, HttpException, HttpStatus, Req } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';

type Check = 'ok' | 'down';

const TIMEOUT_MS = 2000;
function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS))]);
}

/** GET /v1/health — public (OpenAPI x-permission: public). Báo đúng trạng thái phụ thuộc, không giả thành công. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async health(@Req() req: Request): Promise<{ status: 'ok'; checks: Record<string, Check> }> {
    const [db, redis] = await Promise.all([
      withTimeout(this.prisma.$queryRaw`SELECT 1`).then(
        (): Check => 'ok',
        (): Check => 'down',
      ),
      withTimeout(this.pingRedis()).then(
        (): Check => 'ok',
        (): Check => 'down',
      ),
    ]);
    const checks = { db, redis };
    if (db === 'down' || redis === 'down') {
      throw new HttpException(
        {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'Phụ thuộc hạ tầng không sẵn sàng',
          details: { checks },
          request_id: String(req.id ?? ''),
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { status: 'ok', checks };
  }

  private async pingRedis(): Promise<void> {
    const c = this.redis.client;
    if (c.status === 'wait' || c.status === 'end') await c.connect();
    const pong = await c.ping();
    if (pong !== 'PONG') throw new Error('redis ping');
  }
}
