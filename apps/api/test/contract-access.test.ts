import type { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createApp } from '../src/bootstrap';
import { listRoutes } from '../src/common/route-access';
import { loadEnv } from '../src/config/env';
import { testAuthEnv } from './helpers/auth-env';

// CP03 lát 6 (ADR-024): mọi route ĐÃ hiện thực phải khai báo quyền KHỚP hợp đồng — x-permission, x-scope: store,
// x-master-only, x-step-up. Route quên phạm vi cửa hàng / quên chỉ-Master / quên step-up ⇒ đỏ ngay ở CI. App không kết
// nối DB khi chỉ khởi tạo nên dùng URL giả.

interface Op {
  'x-permission'?: string;
  'x-scope'?: string;
  'x-master-only'?: boolean;
  'x-step-up'?: boolean;
}
const spec = parse(readFileSync(resolve(process.cwd(), '../../packages/contracts/openapi.yaml'), 'utf8')) as {
  paths: Record<string, Record<string, Op>>;
};

describe('khai báo quyền của route khớp OpenAPI', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL_APP: 'postgresql://u:p@127.0.0.1:1/none',
      REDIS_URL: 'redis://127.0.0.1:1',
      PORT: '0',
      LOG_LEVEL: 'silent',
      ...testAuthEnv(),
    });
    app = await createApp(env, { logger: false });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('mọi route (trừ /health) có trong hợp đồng với cùng quyền, phạm vi, chỉ-Master, step-up', () => {
    const routes = listRoutes(app).filter((r) => !r.path.startsWith('/health'));
    expect(routes.length).toBeGreaterThan(20);
    const diffs: string[] = [];
    for (const r of routes) {
      const op = spec.paths[r.path]?.[r.method.toLowerCase()];
      const id = `${r.method} ${r.path}`;
      if (!op) {
        diffs.push(`${id}: không có trong openapi`);
        continue;
      }
      const a = r.access;
      const perm =
        a?.kind === 'public'
          ? 'public'
          : a?.kind === 'mfa'
            ? 'mfa:challenge'
            : a?.kind === 'authenticated'
              ? 'auth:*'
              : a?.code;
      if (perm !== op['x-permission']) diffs.push(`${id}: quyền code=${perm} openapi=${op['x-permission']}`);
      const scope = a?.kind === 'permission' ? a.scope : undefined;
      if ((scope === 'store') !== (op['x-scope'] === 'store'))
        diffs.push(`${id}: phạm vi code=${scope ?? '-'} openapi=${op['x-scope'] ?? '-'}`);
      if (!!r.masterOnly !== !!op['x-master-only'])
        diffs.push(`${id}: chỉ-Master code=${!!r.masterOnly} openapi=${!!op['x-master-only']}`);
      if (!!r.stepUp !== !!op['x-step-up'])
        diffs.push(`${id}: step-up code=${!!r.stepUp} openapi=${!!op['x-step-up']}`);
    }
    expect(diffs).toEqual([]);
  });
});
