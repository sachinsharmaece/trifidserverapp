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
import { isLeaderOf, leaderOf, teamOf } from './team.js';
const ADMIN_RIGHT = {
    sales: PERMISSIONS.BUYER_ADMIN,
    purchase: PERMISSIONS.SELLER_ADMIN,
};
export async function scopeFor(side, caller) {
    const all = { all: true, ownerIds: new Set(), includeQueue: true };
    if (!env.ownershipScopeEnforced)
        return all;
    if (caller.permissions.includes(PERMISSIONS.LEADS_SEE_ALL) ||
        caller.permissions.includes(ADMIN_RIGHT[side])) {
        return all;
    }
    const me = await Employee.findById(caller.employeeId, {
        worksForAllTeams: 1,
        worksForTeamLeaderIds: 1,
    });
    if (!me)
        return { all: false, ownerIds: new Set(), includeQueue: false };
    if (me.worksForAllTeams)
        return all;
    const owners = new Set([caller.employeeId]);
    let includeQueue = false;
    const addLeaderScope = async (employeeId) => {
        owners.add(employeeId);
        if (await isLeaderOf(side, employeeId)) {
            for (const id of await teamOf(side, employeeId))
                owners.add(id);
            includeQueue = true;
        }
    };
    await addLeaderScope(caller.employeeId);
    // Accounts / Logistics: the Sales Leaders' teams he works for, both sides.
    for (const leaderId of me.worksForTeamLeaderIds ?? []) {
        for (const id of await teamOf('sales', String(leaderId)))
            owners.add(id);
    }
    // BR-264 — while someone is away, his coverer sees what he would.
    for (const absent of await employeesCoveredBy(caller.employeeId)) {
        await addLeaderScope(absent);
    }
    return { all: false, ownerIds: owners, includeQueue };
}
const EVERYTHING = {
    all: true,
    allowsProfile: () => true,
    allowsCounterparty: () => true,
};
export async function visibilityFor(side, caller) {
    const scope = await scopeFor(side, caller);
    if (scope.all)
        return EVERYTHING;
    const [assignments, profiles] = side === 'sales'
        ? await Promise.all([
            BookAssignment.find({}, { buyerId: 1, ownerEmployeeId: 1 }).lean(),
            Buyer.find({}, { counterpartyId: 1 }).lean(),
        ])
        : await Promise.all([
            SellerAssignment.find({}, { sellerId: 1, ownerEmployeeId: 1 }).lean(),
            Seller.find({}, { counterpartyId: 1 }).lean(),
        ]);
    const ownerByProfile = new Map(assignments.map((a) => [String(a.buyerId ?? a.sellerId), String(a.ownerEmployeeId)]));
    const profileByCounterparty = new Map(profiles.map((p) => [
        String(p.counterpartyId),
        String(p._id),
    ]));
    const allowsProfile = (profileId) => {
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
async function outOfScope(side, profileId) {
    const lead = side === 'sales' ? 'buyer' : 'seller';
    const profile = side === 'sales' ? await Buyer.findById(profileId) : await Seller.findById(profileId);
    const counterparty = profile
        ? await Counterparty.findById(profile.counterpartyId, { firm: 1 })
        : null;
    const assignment = side === 'sales'
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
function callerOf(req) {
    return { employeeId: req.auth.employeeId, permissions: req.auth.permissions };
}
async function visibilityOn(req, side) {
    req.leadVisibility ??= {};
    req.leadVisibility[side] ??= await visibilityFor(side, callerOf(req));
    return req.leadVisibility[side];
}
/** Tags a middleware with what it scopes, for the route registry test. */
function tag(fn, side, kind) {
    Object.assign(fn, { leadScope: { side, kind } });
    return fn;
}
/**
 * Refuses (OUT_OF_SCOPE) when the one buyer/seller this route acts on is
 * outside the caller's scope. `resolve` names him — from a route param, the
 * body, or a record (an order, an ask) that belongs to him.
 */
export function requireInScope(side, resolve) {
    return tag(async (req, _res, next) => {
        if (!env.ownershipScopeEnforced)
            return next();
        const visibility = await visibilityOn(req, side);
        if (visibility.all)
            return next();
        const ref = await resolve(req);
        if (!ref)
            return next();
        let profileId = null;
        if ('profileId' in ref)
            profileId = ref.profileId;
        else {
            const profile = side === 'sales'
                ? await Buyer.findOne({ counterpartyId: ref.counterpartyId }, { _id: 1 })
                : await Seller.findOne({ counterpartyId: ref.counterpartyId }, { _id: 1 });
            if (!profile)
                return next();
            profileId = String(profile._id);
        }
        if (!visibility.allowsProfile(profileId))
            throw await outOfScope(side, profileId);
        next();
    }, side, 'one');
}
/**
 * Drops the rows of a list response that name a buyer/seller outside the
 * caller's scope. `pick` says which id a row carries; a row with none (an
 * aggregate, a product line) is kept.
 */
export function scopeList(side, pick, 
// When the rows sit in an array inside the response object (a product's
// open asks, a pool's commitments), its key.
path) {
    return tag(async (req, res, next) => {
        if (!env.ownershipScopeEnforced)
            return next();
        const visibility = await visibilityOn(req, side);
        if (visibility.all)
            return next();
        const originalJson = res.json.bind(res);
        const keep = (row) => {
            const ref = pick(row);
            if (!ref)
                return true;
            return 'profileId' in ref
                ? visibility.allowsProfile(ref.profileId)
                : visibility.allowsCounterparty(ref.counterpartyId);
        };
        res.json = ((body) => {
            if (body && !path && Array.isArray(body.data)) {
                body.data = body.data.filter(keep);
            }
            if (body && path && body.data && typeof body.data === 'object') {
                const holder = body.data;
                if (Array.isArray(holder[path])) {
                    holder[path] = holder[path].filter(keep);
                }
            }
            return originalJson(body);
        });
        next();
    }, side, 'list');
}
// Common pickers.
export const byBuyerId = (row) => typeof row.buyerId === 'string' && row.buyerId
    ? { profileId: row.buyerId }
    : typeof row.buyerCounterpartyId === 'string' && row.buyerCounterpartyId
        ? { counterpartyId: row.buyerCounterpartyId }
        : null;
export const bySellerId = (row) => typeof row.sellerId === 'string' && row.sellerId
    ? { profileId: row.sellerId }
    : typeof row.sellerCounterpartyId === 'string' && row.sellerCounterpartyId
        ? { counterpartyId: row.sellerCounterpartyId }
        : null;
export const param = (name, as = 'profile') => (req) => {
    const value = req.params[name];
    if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value))
        return null;
    return as === 'profile' ? { profileId: value } : { counterpartyId: value };
};
export const field = (where, name, as = 'counterparty') => (req) => {
    const source = (where === 'body' ? req.body : req.query);
    const value = source?.[name];
    if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value))
        return null;
    return as === 'profile' ? { profileId: value } : { counterpartyId: value };
};
