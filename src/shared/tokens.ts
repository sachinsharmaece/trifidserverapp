import { randomBytes, createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/**
 * TD-006 — access token: JWT, 15 minutes, in memory on the client. Refresh
 * token: opaque, rotating, stored hashed server-side, revocable, in an
 * httpOnly cookie. Never localStorage.
 */

export type ActorType = 'counterparty' | 'staff';

export interface AccessTokenClaims {
  sub: string;
  actorType: ActorType;
  counterpartyId?: string;
  employeeId?: string;
  roles: string[];
  permissions: string[];
  status: string;
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.jwtAccessSecret, {
    expiresIn: env.jwtAccessTtl as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  return jwt.verify(token, env.jwtAccessSecret) as unknown as AccessTokenClaims;
}

// Opaque refresh token — a random string, never a JWT, so it carries no
// inspectable claims if it leaks. Only its hash is ever stored.
export function generateRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const REFRESH_TOKEN_COOKIE_NAME = 'trifid_refresh_token';

/**
 * API-007 `POST /auth/reauth` — CH §24.2 requires re-authentication
 * immediately before a money-moving action. This short-lived assertion is
 * issued on a fresh password (+ MFA) check and must be presented again on
 * the money-moving call itself; it is deliberately separate from the access
 * token so a stolen access token alone can never move money.
 */
const REAUTH_TOKEN_TTL_SECONDS = 5 * 60;

export interface ReauthTokenClaims {
  sub: string;
  type: 'reauth';
}

export function signReauthToken(employeeId: string): string {
  const claims: ReauthTokenClaims = { sub: employeeId, type: 'reauth' };
  return jwt.sign(claims, env.jwtAccessSecret, { expiresIn: REAUTH_TOKEN_TTL_SECONDS });
}

export function verifyReauthToken(token: string): ReauthTokenClaims {
  const claims = jwt.verify(token, env.jwtAccessSecret) as unknown as ReauthTokenClaims;
  if (claims.type !== 'reauth') {
    throw new Error('Not a reauth token');
  }
  return claims;
}

export const REAUTH_TOKEN_TTL_SECONDS_EXPORTED = REAUTH_TOKEN_TTL_SECONDS;

/**
 * API-003/API-004 — the gap between "password checked out" and "MFA checked
 * out" for Controller/Admin/Founder logins. Carries no roles or permissions,
 * so it cannot be used in place of a real access token even if it leaks.
 */
const MFA_PENDING_TOKEN_TTL_SECONDS = 5 * 60;

export interface MfaPendingTokenClaims {
  sub: string;
  type: 'mfa_pending';
}

export function signMfaPendingToken(employeeId: string): string {
  const claims: MfaPendingTokenClaims = { sub: employeeId, type: 'mfa_pending' };
  return jwt.sign(claims, env.jwtAccessSecret, { expiresIn: MFA_PENDING_TOKEN_TTL_SECONDS });
}

export function verifyMfaPendingToken(token: string): MfaPendingTokenClaims {
  const claims = jwt.verify(token, env.jwtAccessSecret) as unknown as MfaPendingTokenClaims;
  if (claims.type !== 'mfa_pending') {
    throw new Error('Not an mfa_pending token');
  }
  return claims;
}

export const MFA_PENDING_TOKEN_TTL_SECONDS_EXPORTED = MFA_PENDING_TOKEN_TTL_SECONDS;
