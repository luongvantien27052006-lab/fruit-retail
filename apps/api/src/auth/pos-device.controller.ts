import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import { OwnTransaction, type Principal, RequirePermission } from '../common/access';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { PosDeviceService } from './pos-device.service';

const ListQuery = z.object({ status: z.enum(['PENDING', 'ACTIVE', 'REVOKED']).optional() }).strict();
const ActivateBody = z
  .object({
    pairing_code: z
      .string()
      .regex(/^[A-Za-z2-7]{5}-?[A-Za-z2-7]{5}$/, 'mã ghép đôi XXXXX-XXXXX hiển thị trên thiết bị'),
    register_id: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const RevokeBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

/** /v1/admin/pos-devices — kích hoạt/thu hồi thiết bị POS (SEC3), quyền `device:write` theo phạm vi cửa hàng. */
@Controller('admin/pos-devices')
export class PosDeviceController {
  constructor(
    private readonly devices: PosDeviceService,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  private principal(): Principal {
    const p = this.cls.get('principal');
    if (!p) throw new AppError('AUTHENTICATION_REQUIRED', 'Cần đăng nhập');
    return p;
  }

  @RequirePermission('device:write')
  @Get()
  list(@Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.devices.list(this.principal(), q.status);
  }

  @RequirePermission('device:write')
  @Post(':id/activate')
  @HttpCode(200)
  activate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(ActivateBody)) b: z.infer<typeof ActivateBody>,
  ) {
    return this.devices.activate(this.principal(), id, b);
  }

  @RequirePermission('device:write')
  @OwnTransaction('thu hồi thiết bị: thử lại cả transaction khi deadlock 40P01 (khóa phiên trước, thiết bị sau)')
  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(RevokeBody)) b: z.infer<typeof RevokeBody>) {
    return this.devices.revoke(this.principal(), id, b.reason);
  }
}
