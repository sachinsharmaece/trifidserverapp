import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { PartyAccountModel, PartySessionModel } from '../../models/index.js';
import type { PartyType } from '../../shared/enums.js';
import { HttpError } from '../../shared/errors.js';

/**
 * Portal sessions (reference lib/partySession.ts), kept apart from staff sessions: a different cookie (`psid`), a
 * different collection. A portal session never signs anyone in to the staff app, and a staff session never opens
 * the portal. A suspended login stops working at once (checked on every request).
 */
const COOKIE_NAME = 'psid';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const cookieOptions = {
  httpOnly: true,
  secure: env.isProduction,
  sameSite: 'lax',
  path: '/',
} as const;

export interface PartySessionInfo {
  partyType: PartyType;
  partyAccountId: string;
  buyerId: string | null;
  sellerId: string | null;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function readToken(req: Request) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE_NAME) return value.join('=');
  }
  return undefined;
}

export async function startPartySession(
  res: Response,
  account: {
    _id: Types.ObjectId;
    partyType: PartyType;
    buyerId?: Types.ObjectId | null;
    sellerId?: Types.ObjectId | null;
  },
) {
  const token = randomBytes(32).toString('base64url');
  await PartySessionModel.create({
    _id: hashToken(token),
    partyAccountId: account._id,
    partyType: account.partyType,
    ...(account.buyerId ? { buyerId: account.buyerId } : {}),
    ...(account.sellerId ? { sellerId: account.sellerId } : {}),
    expiresAt: new Date(Date.now() + MAX_AGE_MS),
  });
  res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: MAX_AGE_MS });
}

export async function findPartySession(req: Request): Promise<PartySessionInfo | null> {
  const token = readToken(req);
  if (!token) return null;
  const session = await PartySessionModel.findById(hashToken(token));
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  const account = await PartyAccountModel.findById(session.partyAccountId);
  if (!account?.active) return null;
  return {
    partyType: session.partyType,
    partyAccountId: String(session.partyAccountId),
    buyerId: session.buyerId ? String(session.buyerId) : null,
    sellerId: session.sellerId ? String(session.sellerId) : null,
  };
}

export async function endPartySession(req: Request, res: Response) {
  const token = readToken(req);
  if (token) await PartySessionModel.deleteOne({ _id: hashToken(token) });
  res.clearCookie(COOKIE_NAME, cookieOptions);
}

/** Put in front of a portal route: the right kind of portal login, or 401 "Sign in required". */
export function requirePartySession(partyType: PartyType) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const party = await findPartySession(req);
    if (!party || party.partyType !== partyType) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
    }
    req.party = party;
    next();
  };
}

export function partyOf(req: Request): PartySessionInfo {
  if (!req.party) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
  return req.party;
}
