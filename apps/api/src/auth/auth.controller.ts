import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';
import {
  AllowWithoutMfa,
  Authenticated,
  MfaChallenge,
  OwnTransaction,
  type Principal,
  Public,
  RequireStepUp,
} from '../common/access';
import { AppError } from '../common/errors';
import type { RequestStore } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { AuthService } from './auth.service';
import { MAX_SECRET_LEN } from './password';

const totpCode = z.string().regex(/^\d{6}$/, 'mã 6 chữ số');
const LoginBody = z
  .object({ email: z.string().min(3).max(254), password: z.string().min(1).max(MAX_SECRET_LEN) })
  .strict();
const CodeBody = z.object({ code: totpCode }).strict();
const RecoverBody = z.object({ recovery_code: z.string().min(16).max(40) }).strict();
const RefreshBody = z.object({ refresh_token: z.string().min(1).max(128) }).strict();
const EmptyBody = z.object({}).strict().default({});

const OWN_TX = 'luồng xác thực: lần sai phải được ghi (đếm sai/khóa/thu hồi) dù request trả lỗi';
const OWN_TX_HASH = 'băm mã khôi phục (Argon2) trước khi mở transaction — không giữ kết nối khi chờ suất';
const MFA_BEARER_RE = /^Bearer ([A-Za-z0-9_-]{43})$/;

/** /v1/auth/* cho Master/Viewer (SEC1, SEC2, SEC4, SEC5 — ADR-012, ADR-021). POS/khách: lát 4/5. */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cls: ClsService<RequestStore>,
  ) {}

  private principal(): Principal {
    const p = this.cls.get('principal');
    if (!p) throw new AppError('AUTHENTICATION_REQUIRED', 'Cần đăng nhập');
    return p;
  }

  @Public()
  @OwnTransaction(OWN_TX)
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(LoginBody)) b: z.infer<typeof LoginBody>) {
    return this.auth.login(b.email, b.password);
  }

  @MfaChallenge()
  @OwnTransaction(OWN_TX)
  @Post('2fa/verify')
  @HttpCode(200)
  verify(@Req() req: Request, @Body(new ZodPipe(CodeBody)) b: z.infer<typeof CodeBody>) {
    return this.auth.verifyMfa(mfaChallenge(req), b.code);
  }

  @MfaChallenge()
  @OwnTransaction(OWN_TX)
  @Post('2fa/recover')
  @HttpCode(200)
  recover(@Req() req: Request, @Body(new ZodPipe(RecoverBody)) b: z.infer<typeof RecoverBody>) {
    return this.auth.recover(mfaChallenge(req), b.recovery_code);
  }

  @Authenticated()
  @AllowWithoutMfa()
  @Post('2fa/setup')
  @HttpCode(200)
  setup(@Body(new ZodPipe(EmptyBody)) body: unknown) {
    void body; // chỉ kiểm thân rỗng (strict)
    return this.auth.setupTotp(this.principal());
  }

  @Authenticated()
  @AllowWithoutMfa()
  @OwnTransaction(OWN_TX_HASH)
  @Post('2fa/confirm')
  @HttpCode(200)
  confirm(@Body(new ZodPipe(CodeBody)) b: z.infer<typeof CodeBody>) {
    return this.auth.confirmTotp(this.principal(), b.code);
  }

  @Authenticated()
  @RequireStepUp()
  @OwnTransaction(OWN_TX_HASH)
  @Post('2fa/recovery-codes')
  @HttpCode(200)
  recoveryCodes(@Body(new ZodPipe(EmptyBody)) body: unknown) {
    void body;
    return this.auth.regenerateRecoveryCodes(this.principal());
  }

  @Authenticated()
  @OwnTransaction(OWN_TX)
  @Post('step-up')
  @HttpCode(200)
  stepUp(@Body(new ZodPipe(CodeBody)) b: z.infer<typeof CodeBody>) {
    return this.auth.stepUp(this.principal(), b.code);
  }

  @Public()
  @OwnTransaction(OWN_TX)
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(new ZodPipe(RefreshBody)) b: z.infer<typeof RefreshBody>) {
    return this.auth.refresh(b.refresh_token);
  }

  @Authenticated()
  @AllowWithoutMfa()
  @Post('logout')
  @HttpCode(200)
  async logout(@Body(new ZodPipe(EmptyBody)) body: unknown) {
    void body;
    await this.auth.logout(this.principal());
    return { ok: true };
  }

  @Authenticated()
  @Get('sessions')
  sessions() {
    return this.auth.listSessions(this.principal());
  }

  @Authenticated()
  @Delete('sessions/:id')
  @HttpCode(204)
  async revoke(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.auth.revokeOwnSession(this.principal(), id);
  }
}

function mfaChallenge(req: Request): string {
  const m = MFA_BEARER_RE.exec(req.headers.authorization ?? '');
  if (!m?.[1]) throw new AppError('MFA_CHALLENGE_INVALID', 'Thiếu token thử thách 2FA (Authorization: Bearer)');
  return m[1];
}
