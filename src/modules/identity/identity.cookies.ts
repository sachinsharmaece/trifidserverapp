import type { CookieOptions, Request, Response } from 'express';
import { env, isProduction } from '../../config/env.js';
import { REFRESH_TOKEN_COOKIE_NAME } from '../../shared/tokens.js';

// TD-006 — httpOnly; Secure; SameSite=Lax. Never localStorage.
// SameSite=None (COOKIE_SAMESITE=none) is only for a cross-site front end; the
// browser rejects it without Secure, so it forces Secure on.
function baseOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction || env.cookieSameSite === 'none',
    sameSite: env.cookieSameSite,
    domain: env.cookieDomain,
    path: '/api/v1/auth',
  };
}

export function setRefreshTokenCookie(res: Response, token: string): void {
  res.cookie(REFRESH_TOKEN_COOKIE_NAME, token, {
    ...baseOptions(),
    maxAge: env.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
  });
}

export function clearRefreshTokenCookie(res: Response): void {
  res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, baseOptions());
}

export function readRefreshTokenCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string> | undefined;
  return cookies?.[REFRESH_TOKEN_COOKIE_NAME];
}
