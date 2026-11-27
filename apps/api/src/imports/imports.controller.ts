import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { MasterOnly, RequirePermission, RequireStepUp } from '../common/access';
import { ZodPipe } from '../common/zod.pipe';
import { XLSX_MIME } from '../files/files.service';
import { uuid } from '../org/org-fields';
import { templateXlsx } from './import-columns';
import { EXPORT_LISTS, ImportsService } from './imports.service';

const TYPES = ['CATALOG', 'SUPPLIER'] as const;
const CreateImport = z
  .object({
    type: z.enum(TYPES),
    file_id: uuid,
    mode_on_duplicate: z.enum(['SKIP', 'UPDATE', 'STOP']),
    dry_run: z.boolean(),
  })
  .strict();
const ListImports = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();
const CreateExport = z.object({ list: z.enum(EXPORT_LISTS) }).strict();

/** /v1/admin/imports — nhập Excel (dry-run / chạy) chạy nền ở worker; /v1/admin/catalog-exports — xuất danh sách. */
@Controller('admin')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  /**
   * Tạo lượt nhập (worker chạy). Chỉ Master + step-up: nhập ghi giá lẻ hàng loạt (như PUT /admin/prices) và SĐT / tài
   * khoản NCC.
   */
  @RequirePermission('import:run')
  @MasterOnly()
  @RequireStepUp()
  @Post('imports')
  create(@Body(new ZodPipe(CreateImport)) b: z.infer<typeof CreateImport>) {
    return this.imports.create(b);
  }

  @RequirePermission('import:run')
  @MasterOnly()
  @Get('imports')
  list(@Query(new ZodPipe(ListImports)) q: z.infer<typeof ListImports>) {
    return this.imports.list(q.limit);
  }

  /** File mẫu .xlsx (tĩnh — không đọc DB) */
  @RequirePermission('import:run')
  @MasterOnly()
  @Get('imports/templates/:type')
  async template(@Param('type', new ZodPipe(z.enum(TYPES))) type: (typeof TYPES)[number], @Res() res: Response) {
    const buf = await templateXlsx(type);
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="mau-nhap-${type.toLowerCase()}.xlsx"`);
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  }

  @RequirePermission('import:run')
  @MasterOnly()
  @Get('imports/:id')
  get(@Param('id', new ZodPipe(uuid)) id: string) {
    return this.imports.get(id);
  }

  /** Xuất danh sách ra .xlsx (lưu S3, URL tải 60 giây); cần thêm quyền đọc của danh sách đó */
  @RequirePermission('report:export')
  @HttpCode(201)
  @Post('catalog-exports')
  export(@Body(new ZodPipe(CreateExport)) b: z.infer<typeof CreateExport>) {
    return this.imports.export(b.list);
  }
}
