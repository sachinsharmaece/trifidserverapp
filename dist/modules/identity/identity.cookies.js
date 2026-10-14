import { env, isProduction } from '../../config/env.js';
import { REFRESH_TOKEN_COOKIE_NAME } from '../../shared/tokens.js';
// TD-006 — httpOnly; Secure; SameSite=Lax. Never localStorage.
export function setRefreshTokenCookie(res, token) {
    res.cookie(REFRESH_TOKEN_COOKIE_NAME, token, {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        domain: env.cookieDomain,
        maxAge: env.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
        path: '/api/v1/auth',
    });
}
export function clearRefreshTokenCookie(res) {
    res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, {
        domain: env.cookieDomain,
        path: '/api/v1/auth',
    });
}
export function readRefreshTokenCookie(req) {
    const cookies = req.cookies;
    return cookies?.[REFRESH_TOKEN_COOKIE_NAME];
}
