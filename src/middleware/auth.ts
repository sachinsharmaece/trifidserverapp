import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from '../shared/errors.js';
import { verifyAccessToken, type AccessTokenClaims } from '../shared/tokens.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AccessTokenClaims;
  }
}

function extractBearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

/**
 * ARCHITECTURE.md §5.3 — verifies the 15-minute access token and attaches its
 * claims to the request. This is layer 1 of the wall (CH §17.4): every
 * downstream guard reads `req.auth`, never a client-supplied ID.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) {
    throw new AppError({ code: 'REAUTH_REQUIRED', messageEn: 'Sign in to continue.' });
  }
  try {
    req.auth = verifyAccessToken(token);
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new AppError({
        code: 'REAUTH_REQUIRED',
        messageEn: 'Your session has expired. Sign in again.',
      });
    }
    throw new AppError({ code: 'REAUTH_REQUIRED', messageEn: 'Invalid session. Sign in again.' });
  }
  next();
}

// For routes that behave differently when a caller is logged in but must not
// 401 an anonymous caller (none in this session yet, kept for completeness).
export function authenticateOptional(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (token) {
    try {
      req.auth = verifyAccessToken(token);
    } catch {
      // Ignored deliberately — an invalid token on an optional route is the
      // same as no token, not an error.
    }
  }
  next();
}
