import type { Request, Response } from 'express';
import * as authService from './auth.service.js';
import {
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
  readRefreshTokenCookie,
} from './identity.cookies.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

export async function otpRequest(req: Request, res: Response): Promise<void> {
  const { mobile } = req.body as { mobile: string };
  const result = await authService.requestOtp(mobile, req.ip ?? 'unknown');
  ok(res, req, result);
}

export async function otpVerify(req: Request, res: Response): Promise<void> {
  const { requestId, code, deviceFingerprint } = req.body as {
    requestId: string;
    code: string;
    deviceFingerprint: string;
  };
  const result = await authService.verifyOtp(requestId, code, deviceFingerprint, req.correlationId);
  if (result.refreshToken) setRefreshTokenCookie(res, result.refreshToken);
  ok(res, req, { accessToken: result.accessToken, me: result.me });
}

export async function staffLogin(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as { email: string; password: string };
  const result = await authService.staffLogin(email, password);
  if (result.mfaRequired) {
    ok(res, req, { mfaRequired: true, mfaToken: result.mfaToken, expiresIn: result.expiresIn });
    return;
  }
  if (result.refreshToken) setRefreshTokenCookie(res, result.refreshToken);
  ok(res, req, { mfaRequired: false, accessToken: result.accessToken, me: result.me });
}

export async function staffMfaVerify(req: Request, res: Response): Promise<void> {
  const { mfaToken, code } = req.body as { mfaToken: string; code: string };
  const result = await authService.staffMfaVerify(mfaToken, code, req.correlationId);
  setRefreshTokenCookie(res, result.refreshToken);
  ok(res, req, { accessToken: result.accessToken, me: result.me });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const presented = readRefreshTokenCookie(req);
  if (!presented) {
    clearRefreshTokenCookie(res);
    res.status(401).json({
      error: {
        code: 'SESSION_REPLACED',
        message_en: 'Session expired. Sign in again.',
        retryable: false,
        correlationId: req.correlationId,
      },
    });
    return;
  }
  const result = await authService.refreshSession(presented);
  setRefreshTokenCookie(res, result.refreshToken);
  ok(res, req, { accessToken: result.accessToken });
}

export async function logout(req: Request, res: Response): Promise<void> {
  const { allDevices } = req.body as { allDevices?: boolean };
  const presented = readRefreshTokenCookie(req);
  await authService.logout(presented, allDevices ?? false);
  clearRefreshTokenCookie(res);
  ok(res, req, { loggedOut: true });
}

export async function reauth(req: Request, res: Response): Promise<void> {
  const { password, mfaCode } = req.body as { password: string; mfaCode?: string };
  const employeeId = req.auth!.employeeId!;
  const result = await authService.reauth(employeeId, password, mfaCode);
  ok(res, req, result);
}

export async function me(req: Request, res: Response): Promise<void> {
  const result = await authService.getMe(req.auth!);
  ok(res, req, result);
}
