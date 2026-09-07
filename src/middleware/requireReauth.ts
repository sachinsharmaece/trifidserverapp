import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../shared/errors.js';
import { verifyReauthToken } from '../shared/tokens.js';

/**
 * CH §24.2 — required before any future money-moving action: releasing a
 * payment run, approving a refund, moving a rate outside band, reposting a
 * bank entry. No such route exists yet in M1/M2, but the guard is built now
 * so those routes only need to add one line later.
 *
 * Must run after `authenticate`. Expects the header `X-Reauth-Token`, issued
 * by a recent `POST /auth/reauth` for the same employee.
 */
export function requireReauth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth || req.auth.actorType !== 'staff') {
    throw new AppError({ code: 'REAUTH_REQUIRED', messageEn: 'Re-authentication required.' });
  }
  const token = req.header('x-reauth-token');
  if (!token) {
    throw new AppError({ code: 'REAUTH_REQUIRED', messageEn: 'Re-authentication required.' });
  }
  let claims;
  try {
    claims = verifyReauthToken(token);
  } catch {
    throw new AppError({ code: 'REAUTH_REQUIRED', messageEn: 'Re-authentication has expired.' });
  }
  if (claims.sub !== req.auth.sub) {
    throw new AppError({ code: 'REAUTH_REQUIRED', messageEn: 'Re-authentication required.' });
  }
  next();
}
