import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, OwnTransaction } from '../common/access';
import { AuditOutboxService } from '../common/audit-outbox.service';
import { ZodPipe } from '../common/zod.pipe';
import { FILE_KINDS, FilesService } from './files.service';

const kinds = Object.keys(FILE_KINDS) as [string, ...string[]];
const PresignBody = z
  .object({
    kind: z.enum(kinds),
    mime: z.enum(['image/jpeg', 'image/webp']),
    bytes: z
      .number()
      .int()
      .min(1)
      .max(5 * 1024 * 1024),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex chữ thường 64 ký tự'),
    capture_source: z.enum(['CAMERA', 'GALLERY']),
    captured_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
const EmptyBody = z.object({}).strict().default({});

/** /v1/files/* — upload 2 bước + tải về ngắn hạn (§3.5, ADR-014, ADR-025). */
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Authenticated()
  @Post('presign')
  @HttpCode(200)
  presign(@Body(new ZodPipe(PresignBody)) b: z.infer<typeof PresignBody>) {
    return this.files.presign(b);
  }

  @Authenticated()
  @OwnTransaction('tải lại object + tính sha256 NGOÀI transaction (không giữ kết nối DB khi đọc S3)')
  @Post(':id/complete')
  @HttpCode(200)
  complete(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(EmptyBody)) body: unknown) {
    void body;
    return this.files.complete(id);
  }

  @Authenticated()
  @Get(':id/download-url')
  downloadUrl(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.files.downloadUrl(id);
  }
}

@Module({ controllers: [FilesController], providers: [FilesService, AuditOutboxService] })
export class FilesModule {}
