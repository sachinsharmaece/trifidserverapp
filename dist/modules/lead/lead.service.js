import { Buyer } from '../../models/Buyer.js';
import { Seller } from '../../models/Seller.js';
import { Counterparty } from '../../models/Counterparty.js';
import { Employee } from '../../models/Employee.js';
import { BookAssignment } from '../../models/BookAssignment.js';
import { SellerAssignment } from '../../models/SellerAssignment.js';
import { bumpCounter } from '../../middleware/rateLimit.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { visibilityFor } from '../../shared/scope.js';
import { assertMayAssign, callerCovers, isLeaderOf, leaderOf, } from '../../shared/team.js';
import { PERMISSIONS } from '../../config/permissions.js';
const ADMIN_RIGHT = {
    sales: PERMISSIONS.BUYER_ADMIN,
    purchase: PERMISSIONS.SELLER_ADMIN,
};
const LEAD = { sales: 'buyer', purchase: 'seller' };
// Enough for a working day of calls; a scrape of the book trips it.
const LOOKUPS_PER_HOUR = 60;
async function personOf(employeeId) {
    if (!employeeId)
        return null;
    const employee = await Employee.findById(employeeId, { person: 1 });
    return employee?.person ?? null;
}
async function ownerOf(side, profileId) {
    const assignment = side === 'sales'
        ? await BookAssignment.findOne({ buyerId: profileId }, { ownerEmployeeId: 1 })
        : await SellerAssignment.findOne({ sellerId: profileId }, { ownerEmployeeId: 1 });
    return assignment ? String(assignment.ownerEmployeeId) : null;
}
export async function lookupLead(query, actor) {
    const used = await bumpCounter(`lead-lookup:${actor.employeeId}`, 60 * 60);
    if (used > LOOKUPS_PER_HOUR) {
        throw new AppError({
            code: 'RATE_LIMITED',
            messageEn: `That is ${LOOKUPS_PER_HOUR} look-ups this hour — try again later.`,
        });
    }
    const filter = query.gstin
        ? { gstin: query.gstin }
        : query.pan
            ? { pan: query.pan }
            : { $or: [{ mobile: query.mobile }, { contactMobile: query.mobile }] };
    const counterparties = await Counterparty.find(filter, { firm: 1 }).limit(10);
    const matches = [];
    for (const counterparty of counterparties) {
        for (const side of ['sales', 'purchase']) {
            const profile = side === 'sales'
                ? await Buyer.findOne({ counterpartyId: counterparty._id }, { _id: 1 })
                : await Seller.findOne({ counterpartyId: counterparty._id }, { _id: 1 });
            if (!profile)
                continue;
            const profileId = String(profile._id);
            const owner = await ownerOf(side, profileId);
            const leaderId = owner ? await leaderOf(side, owner) : null;
            const visible = (await visibilityFor(side, actor)).allowsProfile(profileId);
            matches.push({
                firm: counterparty.firm ?? '',
                side: side === 'sales' ? 'buyer' : 'seller',
                leader: await personOf(leaderId),
                inQueue: !owner,
                profileId: visible ? profileId : null,
            });
        }
    }
    await writeAuditLog({
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'lead_lookup',
        entityId: actor.employeeId,
        field: query.gstin ? 'gstin' : query.pan ? 'pan' : 'mobile',
        newValue: { value: query.gstin ?? query.pan ?? query.mobile, matches: matches.length },
        correlationId: actor.correlationId,
    });
    return matches;
}
// ---------------------------------------------------------------------------
// Change owner
// ---------------------------------------------------------------------------
/**
 * Moves a lead to `target` (null = the Queue), under the assign rule
 * (DEC-062): the caller must cover whoever holds him now, and may hand him
 * only to someone he may assign to. `leadersOnly` is the Change owner action
 * itself; "Add to my book" lets anyone take an unowned buyer for himself.
 */
export async function moveLead(side, profileId, target, actor, options) {
    const field = options.field ?? 'ownerEmployeeId';
    const profile = side === 'sales' ? await Buyer.findById(profileId) : await Seller.findById(profileId);
    if (!profile) {
        throw new AppError({
            code: side === 'sales' && !options.leadersOnly ? 'VALIDATION_FAILED' : 'NOT_FOUND',
            messageEn: `${LEAD[side] === 'buyer' ? 'Buyer' : 'Seller'} not found.`,
            ...(options.leadersOnly ? {} : { field: 'buyerId' }),
        });
    }
    if (options.leadersOnly &&
        !actor.permissions.includes(ADMIN_RIGHT[side]) &&
        !(await isLeaderOf(side, actor.employeeId))) {
        throw new AppError({
            code: 'PERMISSION_DENIED',
            messageEn: `Only his leader or Admin can change who owns a ${LEAD[side]}.`,
        });
    }
    const current = await ownerOf(side, profileId);
    if (current !== target) {
        const mayTake = current === null && !options.leadersOnly;
        if (!mayTake && !(await callerCovers(side, actor, current, { queueAllowed: true }))) {
            const leader = current ? await personOf(await leaderOf(side, current)) : null;
            throw new AppError({
                code: 'OUT_OF_SCOPE',
                messageEn: `This ${LEAD[side]} is assigned to another team${leader ? ` (${leader}'s)` : ''}. Ask his leader or Admin to move him.`,
                meta: { leader },
            });
        }
        await assertMayAssign(side, actor, target, field);
    }
    const before = { ownerEmployeeId: current };
    const Assignment = side === 'sales' ? BookAssignment : SellerAssignment;
    const key = side === 'sales' ? { buyerId: profile._id } : { sellerId: profile._id };
    let assignmentId = profile._id;
    if (target) {
        const assignment = await Assignment.findOneAndUpdate(key, {
            $set: {
                ownerEmployeeId: target,
                assignedAt: new Date(),
                assignedBy: actor.employeeId,
                reason: options.reason ?? 'Owner changed.',
            },
        }, { upsert: true, new: true });
        assignmentId = assignment._id;
    }
    else {
        await Assignment.deleteOne(key);
    }
    await writeAuditLog({
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: side === 'sales' ? 'book_assignment' : 'seller_assignment',
        entityId: assignmentId,
        field: 'owner',
        oldValue: before,
        newValue: { [side === 'sales' ? 'buyerId' : 'sellerId']: profileId, ownerEmployeeId: target },
        reason: options.reason,
        correlationId: actor.correlationId,
    });
    return { ownerEmployeeId: target, owner: await personOf(target) };
}
export const changeOwner = (side, profileId, input, actor) => moveLead(side, profileId, input.ownerEmployeeId, actor, {
    reason: input.note || 'Owner changed.',
    leadersOnly: true,
});
