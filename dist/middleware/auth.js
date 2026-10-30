import jwt from 'jsonwebtoken';
import { AppError } from '../shared/errors.js';
import { verifyAccessToken } from '../shared/tokens.js';
import { isStaffActive } from '../shared/staffActive.js';
function extractBearerToken(req) {
    const header = req.header('authorization');
    if (!header || !header.startsWith('Bearer '))
        return null;
    return header.slice('Bearer '.length).trim();
}
/**
 * ARCHITECTURE.md §5.3 — verifies the 15-minute access token and attaches its
 * claims to the request. This is layer 1 of the wall (CH §17.4): every
 * downstream guard reads `req.auth`, never a client-supplied ID.
 */
export async function authenticate(req, _res, next) {
    const token = extractBearerToken(req);
    if (!token) {
        throw new AppError({ code: 'REAUTH_REQUIRED', messageEn: 'Sign in to continue.' });
    }
    try {
        req.auth = verifyAccessToken(token);
    }
    catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
            throw new AppError({
                code: 'REAUTH_REQUIRED',
                messageEn: 'Your session has expired. Sign in again.',
            });
        }
        throw new AppError({ code: 'REAUTH_REQUIRED', messageEn: 'Invalid session. Sign in again.' });
    }
    // Phase 2 — a switched-off employee's token stops working within 30 s
    // (shared/staffActive.ts), not when it expires.
    if (req.auth.actorType === 'staff' && req.auth.employeeId) {
        if (!(await isStaffActive(req.auth.employeeId))) {
            req.auth = undefined;
            throw new AppError({ code: 'ACCOUNT_NOT_ACTIVE', messageEn: 'This account is not active.' });
        }
    }
    next();
}
// For routes that behave differently when a caller is logged in but must not
// 401 an anonymous caller (none in this session yet, kept for completeness).
export function authenticateOptional(req, _res, next) {
    const token = extractBearerToken(req);
    if (token) {
        try {
            req.auth = verifyAccessToken(token);
        }
        catch {
            // Ignored deliberately — an invalid token on an optional route is the
            // same as no token, not an error.
        }
    }
    next();
}
