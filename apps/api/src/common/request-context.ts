import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ClsStore } from 'nestjs-cls';
import type { Principal } from './access';

/** Ngữ cảnh mỗi request trong CLS (nestjs-cls) — audit/outbox đọc từ đây, không truyền tay. */
export interface RequestStore extends ClsStore {
  requestId: string;
  ip?: string;
  /** X-Device-Id (đã kiểm định dạng) */
  deviceId?: string;
  /** User-Agent (cắt 512 ký tự) — chỉ để hiển thị danh sách phiên/nhật ký đăng nhập */
  userAgent?: string;
  principal?: Principal;
  /** phạm vi cửa hàng theo mã quyền, nhớ trong request (ScopeService) */
  scopeCache?: Map<string, 'ALL' | ReadonlySet<string>>;
  /** route /v1/viewer/*: cấm mọi truy vấn qua pool app_rw (chỉ pool viewer_ro — ADR-024) */
  appDbBlocked?: boolean;
  /** số dòng audit.logs đã ghi trong transaction mutation hiện tại */
  auditCount: number;
  /**
   * Dấu vết của route @OwnTransaction: OBJECT dùng chung theo tham chiếu — withTransaction chạy trong CLS con (bản sao
   * nông của store) nên đếm bằng `cls.set` bên trong không lên tới interceptor; tăng trường của object thì lên.
   */
  ownTxTrace?: { audit: number; login: number };
}

export const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

/** Một request_id duy nhất cho log, audit, envelope lỗi: X-Request-Id hợp lệ hoặc UUID mới (gán vào req.id). */
export function resolveRequestId(req: IncomingMessage & { id?: unknown }): string {
  if (typeof req.id === 'string' && req.id) return req.id;
  const h = req.headers['x-request-id'];
  const id = typeof h === 'string' && REQUEST_ID_RE.test(h) ? h : randomUUID();
  req.id = id;
  return id;
}
