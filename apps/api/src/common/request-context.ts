import type { ClsStore } from 'nestjs-cls';
import type { Principal } from './access';

/** Ngữ cảnh mỗi request trong CLS (nestjs-cls) — audit/outbox đọc từ đây, không truyền tay. */
export interface RequestStore extends ClsStore {
  requestId: string;
  ip?: string;
  /** X-Device-Id (đã kiểm định dạng) */
  deviceId?: string;
  principal?: Principal;
  /** số dòng audit.logs đã ghi trong transaction mutation hiện tại */
  auditCount: number;
}

export const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
