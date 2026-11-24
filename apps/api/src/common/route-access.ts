import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
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
  /** khai báo ở method (nếu có) và ở class (nếu có) — để phát hiện @Public method trong class cần quyền */
  methodAccess?: Access;
  classAccess?: Access;
}

const joinPath = (...parts: string[]) =>
  '/' +
  parts
    .flatMap((p) => p.split('/'))
    .filter(Boolean)
    .join('/');

const asPaths = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [String(v ?? '')]);

/** Tên mọi method thật trên chuỗi prototype (gồm method kế thừa từ class cha; không gọi getter). */
function allMethodNames(proto: object | null): string[] {
  const names = new Set<string>();
  for (let p = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p) as object | null) {
    for (const name of Object.getOwnPropertyNames(p)) {
      if (name === 'constructor' || names.has(name)) continue;
      const desc = Object.getOwnPropertyDescriptor(p, name);
      if (typeof desc?.value === 'function') names.add(name);
    }
  }
  return [...names];
}

/** Liệt kê mọi route HTTP đã đăng ký cùng khai báo quyền. */
export function listRoutes(app: INestApplication): RouteInfo[] {
  const discovery = app.get(DiscoveryService);
  const reflector = app.get(Reflector);
  const out: RouteInfo[] = [];
  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as object | undefined;
    const type = wrapper.metatype as (new (...a: unknown[]) => unknown) | undefined;
    if (!instance || !type) continue;
    if (Reflect.getMetadata(VERSION_METADATA, type) !== undefined)
      throw new Error(`${type.name}: dự án dùng tiền tố /v1 cố định, không dùng versioning của Nest`);
    const bases = asPaths(Reflect.getMetadata(PATH_METADATA, type));
    const proto = Object.getPrototypeOf(instance) as object;
    for (const name of allMethodNames(proto)) {
      // tìm hàm theo chuỗi prototype (method kế thừa vẫn mang metadata route của class cha)
      const fn = (proto as Record<string, unknown>)[name] as object;
      const m = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
      if (m === undefined) continue;
      const methodAccess = Reflect.getMetadata(ACCESS_KEY, fn) as Access | undefined;
      const classAccess = Reflect.getMetadata(ACCESS_KEY, type) as Access | undefined;
      const access = reflector.getAllAndOverride<Access | undefined>(ACCESS_KEY, [fn as never, type]);
      for (const base of bases)
        for (const sub of asPaths(Reflect.getMetadata(PATH_METADATA, fn)))
          out.push({
            controller: type.name,
            handler: name,
            method: RequestMethod[m],
            path: joinPath(base, sub).replace(/:([A-Za-z0-9_]+)/g, '{$1}'),
            ...(access ? { access } : {}),
            ...(methodAccess ? { methodAccess } : {}),
            ...(classAccess ? { classAccess } : {}),
          });
    }
  }
  return out;
}

/**
 * Deny-by-default lúc khởi động: route thiếu khai báo quyền ⇒ ném lỗi, app không chạy. Khai báo ở method thắng class
 * (quy ước Nest `getAllAndOverride`) nhưng method KHÔNG được nới lỏng hơn class (vd `@Public`/`@Authenticated` trong
 * controller có `@RequirePermission`) ⇒ chặn; route lỏng hơn đặt ở controller riêng.
 */
export function assertRoutesDeclareAccess(app: INestApplication): void {
  const routes = listRoutes(app);
  const missing = routes.filter((r) => !r.access);
  if (missing.length)
    throw new Error(
      `Route chưa khai báo quyền (@Public/@Authenticated/@RequirePermission): ${missing
        .map((r) => `${r.method} ${r.path} (${r.controller}.${r.handler})`)
        .join(', ')}`,
    );
  // Khai báo ở method không được NỚI LỎNG hơn class (public < authenticated < permission): nhầm lẫn nguy hiểm
  const rank = (x: Access) => (x.kind === 'public' ? 0 : x.kind === 'authenticated' ? 1 : 2);
  const loosened = routes.filter((r) => r.methodAccess && r.classAccess && rank(r.methodAccess) < rank(r.classAccess));
  if (loosened.length)
    throw new Error(
      `Khai báo quyền ở method nới lỏng hơn class (@Public/@Authenticated trong controller cần quyền): ${loosened
        .map((r) => `${r.method} ${r.path} (${r.controller}.${r.handler})`)
        .join(', ')}`,
    );
}
