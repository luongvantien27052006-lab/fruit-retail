import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isIPv6 } from 'node:net';
import { AppError } from '../common/errors';
import { RedisService } from './redis.service';

/** Một giới hạn cửa sổ cố định: tối đa `max` lần trong `windowS` giây cho một định danh. */
export interface Limit {
  /** tên giới hạn (vd `otp.send.phone`) — vào khóa Redis và log */
  name: string;
  /** định danh (SĐT đã HMAC, IP, X-Device-Id…) — băm SHA-256 trước khi vào Redis, không lưu giá trị gốc */
  id: string;
  max: number;
  windowS: number;
}

/**
 * Lua nguyên tử: kiểm MỌI khóa trước, chỉ khi tất cả còn suất mới cộng (lần bị từ chối không ăn suất của khóa khác).
 * KEYS = khóa; ARGV = [mode, max1, win1, max2, win2, …]; mode 1 = kiểm + cộng, 0 = chỉ kiểm, 2 = chỉ cộng.
 * Trả 0 nếu cho qua, ngược lại số giây còn lại của khóa đầu tiên đã đầy.
 */
const SCRIPT = `
local mode = tonumber(ARGV[1])
if mode ~= 2 then
  for i, k in ipairs(KEYS) do
    local max = tonumber(ARGV[i * 2])
    local n = tonumber(redis.call('GET', k) or '0')
    if n >= max then
      local ttl = redis.call('TTL', k)
      if ttl < 1 then ttl = 1 end
      return ttl
    end
  end
end
if mode ~= 0 then
  for i, k in ipairs(KEYS) do
    local n = redis.call('INCR', k)
    if n == 1 then redis.call('EXPIRE', k, tonumber(ARGV[i * 2 + 1])) end
  end
end
return 0
`;

export type LimitMode = 'hit' | 'check' | 'add';
/** Redis treo (kết nối còn nhưng không trả lời) ⇒ coi như lỗi sau 500 ms (kiểm thử lát 5 L4) */
export const LIMIT_TIMEOUT_MS = 500;

/**
 * Giới hạn tần suất dùng chung (CP03 lát 5, ADR-023) trên Redis. Redis không là nguồn quyết định nghiệp vụ (ADR-002):
 * nó chỉ chặn bớt tần suất. Redis lỗi ⇒ `failOpen` (luồng đã có khóa theo tài khoản trong DB: login/PIN/refresh) cho qua
 * và ghi cảnh báo có giới hạn; ngược lại (gửi OTP — tốn tiền, không có khóa DB thay thế) ⇒ 503.
 */
@Injectable()
export class RateLimiter {
  private readonly log = new Logger('RateLimiter');
  private lastWarnAt = 0;

  constructor(private readonly redis: RedisService) {}

  /**
   * `hit`: kiểm + cộng; `check`: chỉ kiểm (vd. còn được thử OTP không); `add`: chỉ cộng (vd. đếm lần nhập sai).
   * Vượt ⇒ AppError `errorCode` (429) kèm `retry_after_s`.
   */
  async apply(
    limits: readonly Limit[],
    o: { mode?: LimitMode; failOpen: boolean; errorCode?: 'RATE_LIMITED' | 'OTP_RATE_LIMITED' },
  ): Promise<void> {
    if (limits.length === 0) return;
    const mode = o.mode ?? 'hit';
    let wait: number;
    try {
      await this.redis.ensureConnected();
      const args: (string | number)[] = [mode === 'hit' ? 1 : mode === 'check' ? 0 : 2];
      for (const l of limits) args.push(l.max, l.windowS);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Redis quá hạn')), LIMIT_TIMEOUT_MS);
      });
      try {
        wait = Number(
          await Promise.race([this.redis.client.eval(SCRIPT, limits.length, ...limits.map(keyOf), ...args), timeout]),
        );
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      const now = Date.now();
      if (now - this.lastWarnAt > 30_000) {
        this.lastWarnAt = now;
        this.log.warn(`Redis lỗi khi giới hạn tần suất (${o.failOpen ? 'cho qua' : 'từ chối 503'})`);
      }
      if (o.failOpen) return;
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'Tạm thời không xử lý được — thử lại sau');
    }
    if (wait > 0)
      throw new AppError(o.errorCode ?? 'RATE_LIMITED', 'Quá nhiều yêu cầu — thử lại sau', { retry_after_s: wait });
  }
}

const keyOf = (l: Limit) =>
  `rl:${l.name}:${l.windowS}:${createHash('sha256').update(l.id, 'utf8').digest('base64url').slice(0, 32)}`;

/**
 * Định danh IP cho giới hạn: IPv4 (kể cả dạng `::ffff:a.b.c.d`) giữ nguyên; IPv6 gộp theo /64 (một thuê bao thường có
 * cả /64 — không cho xoay địa chỉ trong mạng con để né giới hạn, kiểm thử lát 3 T5).
 */
export function ipBucket(ip: string | undefined): string {
  if (!ip) return 'ip:?';
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4?.[1]) return `ip4:${v4[1]}`;
  if (!isIPv6(ip)) return `ip4:${ip}`;
  return `ip6:${expandV6(ip).slice(0, 4).join(':')}`;
}

/**
 * Các tầng IP cho giới hạn gửi OTP (kiểm thử lát 5 L2): IPv4 một tầng; IPv6 ba tầng /64, /56, /48 — kẻ có cả /48 (dễ xin
 * từ tunnel broker/VPS) không có 65.536 "IP" riêng biệt.
 */
export function ipTiers(ip: string | undefined): { tier: 'v4' | 'p64' | 'p56' | 'p48'; id: string }[] {
  const b = ipBucket(ip);
  if (!b.startsWith('ip6:')) return [{ tier: 'v4', id: b }];
  const h = expandV6(ip ?? '');
  return [
    { tier: 'p64', id: b },
    { tier: 'p56', id: `ip6/56:${h.slice(0, 3).join(':')}:${(h[3] ?? '0000').slice(0, 2)}` },
    { tier: 'p48', id: `ip6/48:${h.slice(0, 3).join(':')}` },
  ];
}

function expandV6(ip: string): string[] {
  const [head = '', tail] = ip.split('%')[0]?.split('::') ?? [''];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail !== undefined ? Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => x.toLowerCase().padStart(4, '0'));
}
