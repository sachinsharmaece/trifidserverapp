import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { SessionModel } from '../../models/index.js';

/** Name of the cookie that holds the random session token. */
const COOKIE_NAME = 'sid';
const HOUR = 60 * 60 * 1000;
const MAX_AGE_MS = 7 * 24 * HOUR; // a session never lives longer than 7 days
const IDLE_LIMIT_MS = 12 * HOUR; // ...and ends after 12 hours without a request
const TOUCH_EVERY_MS = 60 * 1000; // "last seen" is saved at most once a minute

const cookieOptions = {
  httpOnly: true, // JavaScript in the page cannot read it
  secure: env.isProduction, // HTTPS only in production
  sameSite: 'strict',
  path: '/',
} as const;

/** The database stores only a hash of the token, so a leaked database cannot be used to sign in. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Finds our cookie in the raw `Cookie` header ("a=1; sid=abc; b=2"). */
function readToken(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE_NAME) return value.join('=');
  }
  return undefined;
}

/** Signs a user in: saves a session row and sends the cookie. */
export async function startSession(
  req: Request,
  res: Response,
  userId: Types.ObjectId,
): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  await SessionModel.create({
    _id: hashToken(token),
    userId,
    state: 'ACTIVE', // becomes MFA_PENDING first once MFA is built
    expiresAt: new Date(Date.now() + MAX_AGE_MS),
    ip: req.ip ?? '',
    userAgent: (req.headers['user-agent'] ?? '').slice(0, 300), // the model allows 300 characters
  });
  res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: MAX_AGE_MS });
}

/** Returns the signed-in session for this request, or null (no cookie, unknown, expired or idle too long). */
export async function findSession(req: Request) {
  const token = readToken(req);
  if (!token) return null;

  const session = await SessionModel.findById(hashToken(token));
  if (!session) return null;

  const now = Date.now();
  const expired = session.expiresAt.getTime() <= now;
  const idle = now - session.lastSeenAt.getTime() > IDLE_LIMIT_MS;
  if (expired || idle) {
    await SessionModel.deleteOne({ _id: session._id });
    return null;
  }
  if (session.state !== 'ACTIVE') return null;

  if (now - session.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await SessionModel.updateOne({ _id: session._id }, { lastSeenAt: new Date(now) });
  }
  return session;
}

/** Signs out: removes the session row (so it stops working at once) and the cookie. */
export async function endSession(req: Request, res: Response): Promise<void> {
  const token = readToken(req);
  if (token) await SessionModel.deleteOne({ _id: hashToken(token) });
  res.clearCookie(COOKIE_NAME, cookieOptions);
}
