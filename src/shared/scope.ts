import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { PERMISSIONS } from '../config/permissions.js';
import { Employee } from '../models/Employee.js';
import { Buyer } from '../models/Buyer.js';
import { Seller } from '../models/Seller.js';
import { Counterparty } from '../models/Counterparty.js';
import { BookAssignment } from '../models/BookAssignment.js';
import { SellerAssignment } from '../models/SellerAssignment.js';
import { AppError } from './errors.js';
import { employeesCoveredBy } from './absence.js';
import { isLeaderOf, leaderOf, teamOf, type Side } from './team.js';

/**
 * Phase 5 (DEC-060) — who sees which buyer and seller. One place decides;
 * every list, search and profile route asks it through the middleware
 * below, and `routeScopeRegistry` lists every staff route as scoped or
 * exempt (with the reason), checked by a test.
 *
 *   Executive            his own leads, and those of anyone he covers while away
 *   Leader (that side)   his team's leads + the Queue
 *   Accounts/Logistics   the teams he works for ("all teams" = everything)
 *   Admin/Controller/    everything (LEADS_SEE_ALL, or the side's admin right)
 *   Founder
 *
 * A Sales Leader is also his team's Purchase Executive, so on Purchase
 * screens he sees his own sellers (DEC-059). Read from the database, never
 * the token, so a team change applies at once. Behind
 * OWNERSHIP_SCOPE_ENFORCED: while it is off, everyone sees everything, as
 * before Phase 5.
 */
export interface StaffCaller {
  employeeId: string;
  permissions: string[];
}

export interface LeadScope {
  all: boolean;
  ownerIds: Set<string>;
  includeQueue: boolean;
}

const ADMIN_RIGHT: Record<Side, string> = {
  sales: PERMISSIONS.BUYER_ADMIN,
  purchase: PERMISSIONS.SELLER_ADMIN,
};

export async function scopeFor(side: Side, caller: StaffCaller): Promise<LeadScope> {
  const all: LeadScope = { all: true, ownerIds: new Set(), includeQueue: true };
  if (!env.ownershipScopeEnforced) return all;
  if (
    caller.permissions.includes(PERMISSIONS.LEADS_SEE_ALL) ||
    caller.permissions.includes(ADMIN_RIGHT[side])
  ) {
    return all;
  }
  const me = await Employee.findById(caller.employeeId, {
    worksForAllTeams: 1,
    worksForTeamLeaderIds: 1,
  });
  if (!me) return { all: false, ownerIds: new Set(), includeQueue: false };
  if (me.worksForAllTeams) return all;

  const owners = new Set<string>([caller.employeeId]);
  let includeQueue = false;
  const addLeaderScope = async (employeeId: string) => {
    owners.add(employeeId);
    if (await isLeaderOf(side, employeeId)) {
      for (const id of await teamOf(side, employeeId)) owners.add(id);
      includeQueue = true;
    }
  };
  await addLeaderScope(caller.employeeId);
  // Accounts / Logistics: the Sales Leaders' teams he works for, both sides.
  for (const leaderId of me.worksForTeamLeaderIds ?? []) {
    for (const id of await teamOf('sales', String(leaderId))) owners.add(id);
  }
  // BR-264 — while someone is away, his coverer sees what he would.
  for (const absent of await employeesCoveredBy(caller.employeeId)) {
    await addLeaderScope(absent);
  }
  return { all: false, ownerIds: owners, includeQueue };
}

/** Which buyer / seller documents and counterparties a scope lets through. */
export interface Visibility {
  all: boolean;
  allowsProfile(profileId: string): boolean;
  allowsCounterparty(counterpartyId: string): boolean;
}

const EVERYTHING: Visibility = {
  all: true,
  allowsProfile: () => true,
  allowsCounterparty: () => true,
};

export async function visibilityFor(side: Side, caller: StaffCaller): Promise<Visibility> {
  const scope = await scopeFor(side, caller);
  if (scope.all) return EVERYTHING;
  const [assignments, profiles] =
    side === 'sales'
      ? await Promise.all([
          BookAssignment.find({}, { buyerId: 1, ownerEmployeeId: 1 }).lean(),
          Buyer.find({}, { counterpartyId: 1 }).lean(),
        ])
      : await Promise.all([
          SellerAssignment.find({}, { sellerId: 1, ownerEmployeeId: 1 }).lean(),
          Seller.find({}, { counterpartyId: 1 }).lean(),
        ]);
  const ownerByProfile = new Map<string, string>(
    (assignments as Array<{ buyerId?: unknown; sellerId?: unknown; ownerEmployeeId: unknown }>).map(
      (a) => [String(a.buyerId ?? a.sellerId), String(a.ownerEmployeeId)],
    ),
  );
  const profileByCounterparty = new Map(
    (profiles as Array<{ _id: unknown; counterpartyId: unknown }>).map((p) => [
      String(p.counterpartyId),
      String(p._id),
    ]),
  );
  const allowsProfile = (profileId: string) => {
    const owner = ownerByProfile.get(profileId);
    return owner ? scope.ownerIds.has(owner) : scope.includeQueue;
  };
  return {
    all: false,
    allowsProfile,
    // A counterparty with no profile on this side is not this side's lead.
    allowsCounterparty: (counterpartyId) => {
      const profileId = profileByCounterparty.get(counterpartyId);
      return profileId ? allowsProfile(profileId) : true;
    },
  };
}

// ---------------------------------------------------------------------------
// Refusal
// ---------------------------------------------------------------------------

/**
 * The staff-facing refusal: the firm and its leader, nothing else — the same
 * two facts the exact lookup gives (DEC-060), so the screen can say whom to ask.
 */
async function outOfScope(side: Side, profileId: string): Promise<AppError> {
  const lead = side === 'sales' ? 'buyer' : 'seller';
  const profile =
    side === 'sales' ? await Buyer.findById(profileId) : await Seller.findById(profileId);
  const counterparty = profile
    ? await Counterparty.findById(profile.counterpartyId, { firm: 1 })
    : null;
  const assignment =
    side === 'sales'
      ? await BookAssignment.findOne({ buyerId: profileId })
      : await SellerAssignment.findOne({ sellerId: profileId });
  const leaderId = assignment ? await leaderOf(side, String(assignment.ownerEmployeeId)) : null;
  const leader = leaderId ? await Employee.findById(leaderId, { person: 1 }) : null;
  return new AppError({
    code: 'OUT_OF_SCOPE',
    messageEn: assignment
      ? `This ${lead} is assigned to another team${leader ? ` (${leader.person}'s)` : ''}. Ask your leader if you need him.`
      : `This ${lead} is in the Queue — only a leader can open him. Ask your leader to assign him.`,
    meta: { firm: counterparty?.firm ?? null, leader: leader?.person ?? null },
  });
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

declare module 'express-serve-static-core' {
  interface Request {
    leadVisibility?: Partial<Record<Side, Visibility>>;
  }
}

export type LeadRef = { profileId: string } | { counterpartyId: string } | null | undefined;

type Resolver = (req: Request) => Promise<LeadRef> | LeadRef;

function callerOf(req: Request): StaffCaller {
  return { employeeId: req.auth!.employeeId!, permissions: req.auth!.permissions };
}

async function visibilityOn(req: Request, side: Side): Promise<Visibility> {
  req.leadVisibility ??= {};
  req.leadVisibility[side] ??= await visibilityFor(side, callerOf(req));
  return req.leadVisibility[side]!;
}

/** Tags a middleware with what it scopes, for the route registry test. */
function tag<T extends object>(fn: T, side: Side, kind: 'one' | 'list'): T {
  Object.assign(fn, { leadScope: { side, kind } });
  return fn;
}

/**
 * Refuses (OUT_OF_SCOPE) when the one buyer/seller this route acts on is
 * outside the caller's scope. `resolve` names him — from a route param, the
 * body, or a record (an order, an ask) that belongs to him.
 */
export function requireInScope(side: Side, resolve: Resolver) {
  return tag(
    async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
      if (!env.ownershipScopeEnforced) return next();
      const visibility = await visibilityOn(req, side);
      if (visibility.all) return next();
      const ref = await resolve(req);
      if (!ref) return next();
      let profileId: string | null = null;
      if ('profileId' in ref) profileId = ref.profileId;
      else {
        const profile =
          side === 'sales'
            ? await Buyer.findOne({ counterpartyId: ref.counterpartyId }, { _id: 1 })
            : await Seller.findOne({ counterpartyId: ref.counterpartyId }, { _id: 1 });
        if (!profile) return next();
        profileId = String(profile._id);
      }
      if (!visibility.allowsProfile(profileId)) throw await outOfScope(side, profileId);
      next();
    },
    side,
    'one',
  );
}

/**
 * Drops the rows of a list response that name a buyer/seller outside the
 * caller's scope. `pick` says which id a row carries; a row with none (an
 * aggregate, a product line) is kept.
 */
export function scopeList(
  side: Side,
  pick: (row: Record<string, unknown>) => LeadRef,
  // When the rows sit in an array inside the response object (a product's
  // open asks, a pool's commitments), its key.
  path?: string,
) {
  return tag(
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      if (!env.ownershipScopeEnforced) return next();
      const visibility = await visibilityOn(req, side);
      if (visibility.all) return next();
      const originalJson = res.json.bind(res);
      const keep = (row: Record<string, unknown>) => {
        const ref = pick(row);
        if (!ref) return true;
        return 'profileId' in ref
          ? visibility.allowsProfile(ref.profileId)
          : visibility.allowsCounterparty(ref.counterpartyId);
      };
      res.json = ((body: { data?: unknown }) => {
        if (body && !path && Array.isArray(body.data)) {
          body.data = (body.data as Array<Record<string, unknown>>).filter(keep);
        }
        if (body && path && body.data && typeof body.data === 'object') {
          const holder = body.data as Record<string, unknown>;
          if (Array.isArray(holder[path])) {
            holder[path] = (holder[path] as Array<Record<string, unknown>>).filter(keep);
          }
        }
        return originalJson(body);
      }) as typeof res.json;
      next();
    },
    side,
    'list',
  );
}

// Common pickers.
export const byBuyerId = (row: Record<string, unknown>): LeadRef =>
  typeof row.buyerId === 'string' && row.buyerId
    ? { profileId: row.buyerId }
    : typeof row.buyerCounterpartyId === 'string' && row.buyerCounterpartyId
      ? { counterpartyId: row.buyerCounterpartyId }
      : null;
export const bySellerId = (row: Record<string, unknown>): LeadRef =>
  typeof row.sellerId === 'string' && row.sellerId
    ? { profileId: row.sellerId }
    : typeof row.sellerCounterpartyId === 'string' && row.sellerCounterpartyId
      ? { counterpartyId: row.sellerCounterpartyId }
      : null;
export const param =
  (name: string, as: 'profile' | 'counterparty' = 'profile'): Resolver =>
  (req) => {
    const value = req.params[name];
    if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) return null;
    return as === 'profile' ? { profileId: value } : { counterpartyId: value };
  };
export const field =
  (
    where: 'body' | 'query',
    name: string,
    as: 'profile' | 'counterparty' = 'counterparty',
  ): Resolver =>
  (req) => {
    const source = (where === 'body' ? req.body : req.query) as Record<string, unknown> | undefined;
    const value = source?.[name];
    if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) return null;
    return as === 'profile' ? { profileId: value } : { counterpartyId: value };
  };
