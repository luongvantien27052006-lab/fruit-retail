import type { NextRequest } from 'next/server';
import { badRequest, forbidden, json, readBody } from '../../../../lib/server/respond';
import { COOKIE, clearMfa, issueCsrf, originOk, setTokens } from '../../../../lib/server/session';
import { publicCall, stripTokens } from '../../../../lib/server/upstream';

export const dynamic = 'force-dynamic';

/** Bước 2: `{code}` (TOTP) hoặc `{recovery_code}` — mfa_challenge lấy từ cookie HttpOnly, không qua JS. */
export async function POST(req: NextRequest) {
  if (!originOk(req)) return forbidden();
  const challenge = req.cookies.get(COOKIE.mfa)?.value;
  if (!challenge) return json(401, { code: 'MFA_CHALLENGE_INVALID', message: 'Phiên xác minh đã hết — đăng nhập lại' });
  const b = await readBody(req);
  if ('error' in b) return b.error;
  const parsed: unknown = JSON.parse(b.text);
  const input = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  let r;
  if (typeof input['code'] === 'string')
    r = await publicCall(req, '/auth/2fa/verify', { code: input['code'] }, challenge);
  else if (typeof input['recovery_code'] === 'string')
    r = await publicCall(req, '/auth/2fa/recover', { recovery_code: input['recovery_code'] }, challenge);
  else return badRequest('Cần code hoặc recovery_code');

  if (r.status !== 200) {
    const res = json(r.status, r.body);
    const code = r.body && typeof r.body === 'object' ? (r.body as { code?: unknown }).code : undefined;
    if (code === 'MFA_CHALLENGE_INVALID' || code === 'ACCOUNT_LOCKED') clearMfa(res);
    return res;
  }
  const s = stripTokens(r.body);
  const out = s.body as Record<string, unknown>;
  const res = json(200, {
    ok: true,
    ...(typeof out['recovery_codes_remaining'] === 'number'
      ? { recovery_codes_remaining: out['recovery_codes_remaining'] }
      : {}),
  });
  setTokens(res, s.tokens);
  issueCsrf(res);
  clearMfa(res);
  return res;
}
