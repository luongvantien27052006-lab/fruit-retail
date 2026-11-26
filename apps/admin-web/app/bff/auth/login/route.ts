import type { NextRequest } from 'next/server';
import { forbidden, json, readBody } from '../../../../lib/server/respond';
import { clearMfa, issueCsrf, originOk, setMfa, setTokens } from '../../../../lib/server/session';
import { publicCall, stripTokens } from '../../../../lib/server/upstream';

export const dynamic = 'force-dynamic';

/**
 * Bước 1 đăng nhập. Chưa có phiên ⇒ chưa có cookie CSRF: chống "login CSRF" bằng kiểm Origin (+ SameSite=Strict).
 * MFA_REQUIRED ⇒ mfa_challenge vào cookie HttpOnly 5 phút; ENROLLMENT_REQUIRED ⇒ phiên đăng ký vào cookie.
 */
export async function POST(req: NextRequest) {
  if (!originOk(req)) return forbidden();
  const b = await readBody(req);
  if ('error' in b) return b.error;
  const r = await publicCall(req, '/auth/login', JSON.parse(b.text));
  if (r.status !== 200 || !r.body || typeof r.body !== 'object') return json(r.status, r.body);
  const body = r.body as Record<string, unknown>;
  if (body['status'] === 'MFA_REQUIRED' && typeof body['mfa_challenge'] === 'string') {
    const res = json(200, { status: 'MFA_REQUIRED', expires_at: body['mfa_challenge_expires_at'] });
    setMfa(res, body['mfa_challenge']);
    return res;
  }
  if (body['status'] === 'ENROLLMENT_REQUIRED') {
    const s = stripTokens(body);
    const res = json(200, {
      status: 'ENROLLMENT_REQUIRED',
      password_change_required: body['password_change_required'] === true,
    });
    setTokens(res, s.tokens);
    issueCsrf(res);
    clearMfa(res);
    return res;
  }
  return json(502, { code: 'INTERNAL_ERROR', message: 'Phản hồi đăng nhập không hợp lệ' });
}
