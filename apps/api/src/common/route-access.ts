import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, Reflector } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { type Access, ACCESS_KEY } from './access';

export interface RouteInfo {
  controller: string;
  handler: string;
  method: string;
  /** đường dẫn dạng OpenAPI, không có tiền tố /v1: /health, /admin/staff/{id} */
  path: string;
  access?: Access;
}

const joinPath = (...parts: string[]) =>
  '/' +
  parts
    .flatMap((p) => p.split('/'))
    .filter(Boolean)
    .join('/');

/** Liệt kê mọi route HTTP đã đăng ký cùng khai báo quyền. */
export function listRoutes(app: INestApplication): RouteInfo[] {
  const discovery = app.get(DiscoveryService);
  const reflector = app.get(Reflector);
  const out: RouteInfo[] = [];
  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as Record<string, unknown> | undefined;
    const type = wrapper.metatype as (new (...a: unknown[]) => unknown) | undefined;
    if (!instance || !type) continue;
    const base = String(Reflect.getMetadata(PATH_METADATA, type) ?? '');
    const proto = Object.getPrototypeOf(instance) as object;
    for (const name of Object.getOwnPropertyNames(proto)) {
      // chỉ method thật — không gọi getter/setter trên prototype
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      const fn: unknown = desc?.value;
      if (name === 'constructor' || typeof fn !== 'function') continue;
      const m = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
      if (m === undefined) continue;
      const sub = String(Reflect.getMetadata(PATH_METADATA, fn) ?? '');
      const access = reflector.getAllAndOverride<Access | undefined>(ACCESS_KEY, [fn, type]);
      out.push({
        controller: type.name,
        handler: name,
        method: RequestMethod[m],
        path: joinPath(base, sub).replace(/:([A-Za-z0-9_]+)/g, '{$1}'),
        ...(access ? { access } : {}),
      });
    }
  }
  return out;
}

/** Deny-by-default lúc khởi động: có route thiếu khai báo quyền ⇒ ném lỗi, app không chạy. */
export function assertRoutesDeclareAccess(app: INestApplication): void {
  const missing = listRoutes(app).filter((r) => !r.access);
  if (missing.length)
    throw new Error(
      `Route chưa khai báo quyền (@Public/@Authenticated/@RequirePermission): ${missing
        .map((r) => `${r.method} ${r.path} (${r.controller}.${r.handler})`)
        .join(', ')}`,
    );
}
