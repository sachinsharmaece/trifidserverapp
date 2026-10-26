import { withTransaction } from '../../db/transaction.js';
import { Counterparty } from '../../models/Counterparty.js';
import { Buyer } from '../../models/Buyer.js';
import { BuyerDealership } from '../../models/BuyerDealership.js';
import { Seller } from '../../models/Seller.js';
import { SellerDealership } from '../../models/SellerDealership.js';
import { Manufacturer } from '../../models/Manufacturer.js';
import { SellerReference } from '../../models/SellerReference.js';
import { SellerArea } from '../../models/SellerArea.js';
import { BankDetail } from '../../models/BankDetail.js';
import { Consent } from '../../models/Consent.js';
import { Tehsil } from '../../models/Tehsil.js';
import { AuditLog } from '../../models/AuditLog.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { isValidGstin, isValidIfsc, namesAreSimilar } from '../../shared/validators.js';
import { env, isProduction } from '../../config/env.js';
import { encryptAccountNumber } from '../../shared/encryption.js';
import { enqueueNotification } from '../notification/notification.outbox.js';
import { toBankDetailDto } from './onboarding.dto.js';
import { checkBuyerIdentity } from './buyer.identity.js';
import { BookAssignment } from '../../models/BookAssignment.js';
import { SellerAssignment } from '../../models/SellerAssignment.js';
import { assertMayAssign, callerCovers } from '../../shared/team.js';
import { recordPincodeIfUnknown, assertLocationChain } from '../territory/territory.masters.js';
import { Employee } from '../../models/Employee.js';
import { panFromGstin } from '../../shared/validators.js';
// DISABLE_INPUT_VALIDATION (see middleware/validate.ts) also lifts these
// service-layer checksum/shape checks, which sit below the Zod boundary and
// so aren't skipped by validateBody alone. Never true in production.
const validationDisabled = !isProduction && env.disableInputValidation;
async function assertGstinAndMobileAreFree(gstin, mobile, skipGstinCheck = false) {
    if (!validationDisabled && !skipGstinCheck && gstin && !isValidGstin(gstin)) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'That GSTIN does not check out.',
            field: 'gstin',
        });
    }
    // Uniqueness is a data-integrity guard (unique indexes), not input
    // validation — kept, but a blank GSTIN never matches anything.
    const existing = await Counterparty.findOne({
        $or: gstin ? [{ gstin }, { mobile }] : [{ mobile }],
        deletedAt: null,
    });
    if (existing) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'An account already exists for this GSTIN or mobile number.',
            field: existing.gstin === gstin ? 'gstin' : 'mobile',
            retryable: false,
            meta: { existingCounterpartyId: existing._id.toString() },
        });
    }
}
// Payout-fraud signal, not a validation gate — a bank account name
// legitimately differs from a trade/firm name often enough (a proprietor's
// personal name on the account vs. the firm's trade name) that this must
// never block registration. It is audit-logged for whoever approves the
// registration to review, per the confirmed soft/audit-only posture.
function accountNameMismatchReason(accountName, ownerName, firm) {
    if (namesAreSimilar(accountName, ownerName) || namesAreSimilar(accountName, firm)) {
        return null;
    }
    return `Bank account name "${accountName}" does not resemble the owner name "${ownerName}" or the firm name "${firm}".`;
}
/**
 * Audit-logs a mismatch for later review AND returns it, so the person
 * registering this account sees the same signal immediately rather than it
 * living only in a log nobody reads until an audit — a payout-fraud
 * signal that stayed invisible at the point someone could actually still
 * ask the seller about it is barely a signal at all. Still never blocks:
 * the return value is a warning to show, not a reason to fail the call.
 */
export async function auditAccountNameMismatchIfAny(params, session) {
    const reason = accountNameMismatchReason(params.accountName, params.ownerName, params.firm);
    if (!reason)
        return null;
    await writeAuditLog({
        actorId: params.entityId,
        actorType: 'system',
        entity: 'counterparty',
        entityId: params.entityId,
        field: 'bank_account_name_mismatch',
        reason,
        correlationId: params.correlationId,
    }, session);
    return reason;
}
// Staff-assisted enquiries — a registration raised on a phone call cannot be
// approved until a single OTP to the real phone number has confirmed it is
// genuine, even with every other field filled in correctly. Self-service
// registrations (staffAssisted: false) are untouched by this gate.
export function assertStaffAssistedOtpConfirmed(counterparty) {
    if (counterparty.staffAssisted && !counterparty.staffAssistedOtpVerifiedAt) {
        throw new AppError({
            code: 'OTP_CONFIRMATION_REQUIRED',
            messageEn: 'This registration was staff-assisted and still needs an OTP confirmation to the real phone number before it can be approved.',
            field: 'staffAssistedOtpVerifiedAt',
        });
    }
}
export function assertBankDetailIsWellFormed(bankDetail) {
    if (!validationDisabled && !isValidIfsc(bankDetail.ifsc)) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'That IFSC code is not valid.',
            field: 'ifsc',
        });
    }
}
// BR-340 — three consent records, versioned and timestamped. Marketing is a
// separate opt-in: if declined, no record is written at all (absence is the
// correct "not consented" state under DPDP, not a record saying so).
export async function writeConsents(counterpartyId, consent, session) {
    const now = new Date();
    await Consent.create([
        { counterpartyId, type: 'terms', noticeVersion: consent.noticeVersion, givenAt: now },
        { counterpartyId, type: 'transactional', noticeVersion: consent.noticeVersion, givenAt: now },
        ...(consent.marketingOptIn
            ? [
                {
                    counterpartyId,
                    type: 'marketing',
                    noticeVersion: consent.noticeVersion,
                    givenAt: now,
                },
            ]
            : []),
    ], { session, ordered: true });
}
export async function createPendingBankDetail(counterpartyId, input, session) {
    await BankDetail.create([
        {
            counterpartyId,
            accountEncrypted: encryptAccountNumber(input.accountNumber),
            ifsc: input.ifsc,
            accountName: input.accountName,
            isActive: false,
        },
    ], { session });
}
/** API-010. WF-01 steps 1–5. */
export async function registerBuyer(input, staffAssisted, correlationId = 'unknown') {
    // Blank strings become undefined so the sparse-unique GSTIN index never
    // sees two '' values. The buyer app's mobile is his login, so a mobile in
    // use is refused rather than warned (mode 'self').
    const identity = await checkBuyerIdentity({
        mode: 'self',
        gstin: input.gstin,
        pan: input.pan,
        mobile: input.mobile,
    });
    const gstin = identity.gstin;
    if (input.bankDetail && !staffAssisted)
        assertBankDetailIsWellFormed(input.bankDetail);
    let accountNameWarning = null;
    const registrationId = await withTransaction(async (session) => {
        const [counterparty] = await Counterparty.create([
            {
                mobile: input.mobile,
                contactMobile: input.mobile,
                firm: input.firm || undefined,
                gstin,
                pan: identity.pan,
                ownerName: input.ownerName || undefined,
                licenceNo: input.licenceNo || undefined,
                kind: 'buyer',
                status: 'pending',
                ...(staffAssisted
                    ? {
                        staffAssisted: true,
                        staffAssistedByEmployeeId: staffAssisted.employeeId,
                        staffAssistedCallNote: staffAssisted.callNote,
                    }
                    : {}),
            },
        ], { session });
        if (!counterparty)
            throw new Error('Counterparty.create returned no document.');
        const [buyer] = await Buyer.create([
            {
                counterpartyId: counterparty._id,
                gstPpobAddress: input.gstPpobAddress || undefined,
                address: input.gstPpobAddress || undefined,
            },
        ], { session });
        if (!buyer)
            throw new Error('Buyer.create returned no document.');
        if (input.dealerships && input.dealerships.length > 0) {
            await BuyerDealership.create(input.dealerships.map((dealership) => ({
                buyerId: buyer._id,
                manufacturerId: dealership.manufacturerId,
                isStrong: dealership.isStrong ?? false,
            })), { session, ordered: true });
        }
        if (input.bankDetail) {
            await createPendingBankDetail(counterparty._id, input.bankDetail, session);
        }
        await writeConsents(counterparty._id, input.consent, session);
        if (staffAssisted) {
            await writeAuditLog({
                actorId: counterparty._id.toString(),
                actorType: 'counterparty',
                entity: 'counterparty',
                entityId: counterparty._id,
                field: 'staff_assisted_registration',
                reason: `Logged by staff ${staffAssisted.employeeId}: ${staffAssisted.callNote}`,
                correlationId: staffAssisted.correlationId,
            }, session);
        }
        if (input.bankDetail) {
            accountNameWarning = await auditAccountNameMismatchIfAny({
                accountName: input.bankDetail.accountName,
                ownerName: input.ownerName ?? '',
                firm: input.firm ?? '',
                entityId: counterparty._id,
                correlationId: staffAssisted?.correlationId ?? correlationId,
            }, session);
        }
        return counterparty._id.toString();
    });
    return { registrationId, accountNameWarning };
}
/** API-011. WF-02. */
export async function registerSeller(input, staffAssisted, correlationId = 'unknown', extras) {
    await assertGstinAndMobileAreFree(input.gstin, input.mobile);
    assertBankDetailIsWellFormed(input.bankDetail);
    const dealershipIds = [...new Set((input.dealerships ?? []).map((d) => d.manufacturerId))];
    if (dealershipIds.length > 0) {
        const known = await Manufacturer.countDocuments({ _id: { $in: dealershipIds } });
        if (known !== dealershipIds.length) {
            throw new AppError({
                code: 'VALIDATION_FAILED',
                messageEn: 'One of those companies does not exist.',
                field: 'dealerships',
            });
        }
    }
    let accountNameWarning = null;
    const registrationId = await withTransaction(async (session) => {
        const [counterparty] = await Counterparty.create([
            {
                mobile: input.mobile,
                contactMobile: input.mobile,
                firm: input.firm,
                gstin: input.gstin,
                pan: panFromGstin(input.gstin),
                ownerName: input.ownerName,
                licenceNo: input.licenceNo,
                kind: 'seller',
                status: 'pending',
                ...(staffAssisted
                    ? {
                        staffAssisted: true,
                        staffAssistedByEmployeeId: staffAssisted.employeeId,
                        staffAssistedCallNote: staffAssisted.callNote,
                        ...(extras ? { proprietorAgreedAt: new Date() } : {}),
                    }
                    : {}),
            },
        ], { session });
        if (!counterparty)
            throw new Error('Counterparty.create returned no document.');
        const [seller] = await Seller.create([
            {
                counterpartyId: counterparty._id,
                ...(extras
                    ? {
                        tehsilId: extras.tehsilId,
                        address: extras.location.address,
                        pincode: extras.location.pincode ?? null,
                        margPartyCode: extras.margPartyCode ?? null,
                    }
                    : {}),
            },
        ], { session });
        if (!seller)
            throw new Error('Seller.create returned no document.');
        await SellerReference.create(input.references.map((reference) => ({ sellerId: seller._id, ...reference })), { session, ordered: true });
        if (dealershipIds.length > 0) {
            await SellerDealership.create(dealershipIds.map((manufacturerId) => ({
                sellerId: seller._id,
                manufacturerId,
                setBy: staffAssisted?.employeeId ?? null,
            })), { session, ordered: true });
        }
        await createPendingBankDetail(counterparty._id, input.bankDetail, session);
        await writeConsents(counterparty._id, input.consent, session);
        if (extras?.location.pincode) {
            await recordPincodeIfUnknown({ pincode: extras.location.pincode, tehsilId: extras.location.tehsilId }, extras.caller, session);
        }
        if (extras?.assignee && seller) {
            await SellerAssignment.create([
                {
                    sellerId: seller._id,
                    ownerEmployeeId: extras.assignee,
                    assignedAt: new Date(),
                    assignedBy: extras.caller.employeeId,
                    reason: 'Assigned at registration.',
                },
            ], { session });
        }
        if (staffAssisted) {
            // F10 — the staff member is the actor (the old entry named the seller).
            await writeAuditLog({
                actorId: staffAssisted.employeeId,
                actorType: 'staff',
                entity: 'counterparty',
                entityId: counterparty._id,
                field: 'staff_assisted_registration',
                newValue: extras
                    ? {
                        kind: 'seller',
                        tehsilId: extras.location.tehsilId,
                        assignedToEmployeeId: extras.assignee,
                        proprietorAgreed: true,
                    }
                    : { kind: 'seller' },
                reason: staffAssisted.callNote,
                correlationId: staffAssisted.correlationId,
            }, session);
        }
        accountNameWarning = await auditAccountNameMismatchIfAny({
            accountName: input.bankDetail.accountName,
            ownerName: input.ownerName,
            firm: input.firm,
            entityId: counterparty._id,
            correlationId: staffAssisted?.correlationId ?? correlationId,
        }, session);
        return counterparty._id.toString();
    });
    return { registrationId, accountNameWarning };
}
/** API-012. */
export async function getRegistration(registrationId, requesterCounterpartyId) {
    const counterparty = await Counterparty.findById(registrationId);
    if (!counterparty) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Registration not found.' });
    }
    // A counterparty may only read their own registration; staff (no
    // requesterCounterpartyId) may read any.
    if (requesterCounterpartyId && requesterCounterpartyId !== registrationId) {
        throw new AppError({ code: 'NOT_VISIBLE', messageEn: 'Not found.' });
    }
    const result = {
        registrationId: counterparty._id.toString(),
        kind: counterparty.kind,
        status: counterparty.status,
        firm: counterparty.firm ?? '',
        gstin: counterparty.gstin ?? '',
        staffAssisted: counterparty.staffAssisted ?? false,
        staffAssistedOtpVerifiedAt: counterparty.staffAssistedOtpVerifiedAt ?? null,
    };
    if (counterparty.status === 'rejected') {
        const rejectionEntry = await AuditLog.findOne({
            entity: 'counterparty',
            entityId: counterparty._id,
            field: 'status',
            newValue: 'rejected',
        }).sort({ createdAt: -1 });
        result.rejectionReason = rejectionEntry?.reason ?? undefined;
    }
    return result;
}
/**
 * API-013. Phase 3 — `kinds` limits the list to the desk's own side (F1):
 * Sales staff see buyer registrations, Purchase staff seller ones, the full
 * view both. `kind: 'both'` shows on either side.
 */
export async function listRegistrations(stage, cursor, limit, options = {}) {
    const query = {};
    if (stage)
        query.status = stage;
    if (cursor)
        query._id = { $gt: cursor };
    if (options.kinds)
        query.kind = { $in: [...options.kinds, 'both'] };
    // 26 Oct — the search box: part of the firm name, GSTIN, PAN or mobile.
    const term = options.q?.trim();
    if (term) {
        const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const digits = term.replace(/\D/g, '');
        query.$or = [
            { firm: pattern },
            { ownerName: pattern },
            { gstin: pattern },
            { pan: pattern },
            ...(digits.length >= 4
                ? [{ mobile: new RegExp(digits) }, { contactMobile: new RegExp(digits) }]
                : []),
        ];
    }
    const registrations = await Counterparty.find(query)
        .sort({ _id: 1 })
        .limit(limit + 1);
    const hasMore = registrations.length > limit;
    const page = hasMore ? registrations.slice(0, limit) : registrations;
    const buyers = await Buyer.find({ counterpartyId: { $in: page.map((c) => c._id) } }, { counterpartyId: 1, tehsilId: 1 });
    const buyerByCounterparty = new Map(buyers.map((b) => [String(b.counterpartyId), b]));
    const assignments = await BookAssignment.find({ buyerId: { $in: buyers.map((b) => b._id) } });
    const ownerByBuyer = new Map(assignments.map((a) => [String(a.buyerId), String(a.ownerEmployeeId)]));
    const owners = await Employee.find({ _id: { $in: [...ownerByBuyer.values()] } }, { person: 1 });
    const ownerName = new Map(owners.map((e) => [String(e._id), e.person]));
    const tehsils = await Tehsil.find({ _id: { $in: buyers.map((b) => b.tehsilId).filter(Boolean) } }, { district: 1 });
    const districtOfTehsil = new Map(tehsils.map((t) => [String(t._id), t.district]));
    // Phase 4 — the same two columns for seller registrations.
    const sellers = await Seller.find({ counterpartyId: { $in: page.map((c) => c._id) } }, { counterpartyId: 1, tehsilId: 1 });
    const sellerByCounterparty = new Map(sellers.map((x) => [String(x.counterpartyId), x]));
    const sellerAssignments = await SellerAssignment.find({
        sellerId: { $in: sellers.map((x) => x._id) },
    });
    const ownerBySeller = new Map(sellerAssignments.map((a) => [String(a.sellerId), String(a.ownerEmployeeId)]));
    const sellerOwners = await Employee.find({ _id: { $in: [...ownerBySeller.values()] } }, { person: 1 });
    for (const e of sellerOwners)
        ownerName.set(String(e._id), e.person);
    const sellerTehsils = await Tehsil.find({ _id: { $in: sellers.map((x) => x.tehsilId).filter(Boolean) } }, { district: 1 });
    for (const t of sellerTehsils)
        districtOfTehsil.set(String(t._id), t.district);
    const items = page.map((counterparty) => {
        const buyer = buyerByCounterparty.get(String(counterparty._id));
        const seller = counterparty.kind === 'seller'
            ? sellerByCounterparty.get(String(counterparty._id))
            : undefined;
        const ownerId = seller
            ? ownerBySeller.get(String(seller._id))
            : buyer
                ? ownerByBuyer.get(String(buyer._id))
                : undefined;
        const tehsilId = seller?.tehsilId ?? buyer?.tehsilId;
        return {
            registrationId: counterparty._id.toString(),
            firm: counterparty.firm ?? undefined,
            gstin: counterparty.gstin ?? undefined,
            pan: counterparty.pan ?? undefined,
            kind: counterparty.kind,
            status: counterparty.status,
            createdAt: counterparty.createdAt,
            staffAssisted: counterparty.staffAssisted ?? false,
            assignedTo: ownerId ? (ownerName.get(ownerId) ?? null) : null,
            district: tehsilId ? (districtOfTehsil.get(String(tehsilId)) ?? null) : null,
        };
    });
    const nextCursor = hasMore
        ? page[page.length - 1]._id.toString()
        : undefined;
    return { items, nextCursor };
}
// API-014, buyer branch — approveBuyer lives in buyer.registration.ts (Phase 3).
export { approveBuyer } from './buyer.registration.js';
const TRUST_TIER_ORDER = ['New', 'Verified', 'Trusted', 'Committed'];
/** API-014, seller branch. BR-083 — rejects without an area. */
export async function approveSeller(registrationId, input, actor) {
    const tehsils = await Tehsil.find({ _id: { $in: input.tehsilIds } });
    if (tehsils.length !== input.tehsilIds.length) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'One or more tehsils do not exist.',
            field: 'tehsilIds',
        });
    }
    const counterparty = await Counterparty.findOne({
        _id: registrationId,
        kind: { $in: ['seller', 'both'] },
    });
    if (!counterparty) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller registration not found.' });
    }
    if (counterparty.status !== 'pending') {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'This registration has already been decided.',
        });
    }
    // DEC-056 — the OTP wait is off unless REQUIRE_REGISTRATION_OTP is on.
    if (env.requireRegistrationOtp)
        assertStaffAssistedOtpConfirmed(counterparty);
    const seller = await Seller.findOne({ counterpartyId: counterparty._id });
    if (!seller) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller profile not found.' });
    }
    // Phase 4 — a Purchase Leader for his team or the Queue, or Admin.
    await assertCallerMayDecideSeller(seller._id, actor);
    await assertMayAssign('purchase', actor, input.assignedToEmployeeId);
    if (!input.location && !seller.tehsilId) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: "Pick the seller's own location before approving him.",
            field: 'location.tehsilId',
        });
    }
    const place = input.location ? await assertLocationChain(input.location) : null;
    // BR-246 — monotonic: a seed can only ever move the tier forward, never back.
    if (input.trustTier) {
        const currentIndex = TRUST_TIER_ORDER.indexOf(seller.trustTier);
        const requestedIndex = TRUST_TIER_ORDER.indexOf(input.trustTier);
        if (requestedIndex < currentIndex) {
            throw new AppError({
                code: 'VALIDATION_FAILED',
                messageEn: 'A trust tier can only move forward, never back.',
                field: 'trustTier',
            });
        }
    }
    await withTransaction(async (session) => {
        await SellerArea.create(input.tehsilIds.map((tehsilId) => ({
            sellerId: seller._id,
            tehsilId,
            setBy: actor.employeeId,
            setAt: new Date(),
        })), { session, ordered: true });
        seller.dispatchCutoffTime = input.dispatchCutoffTime;
        if (input.location && place) {
            seller.tehsilId = place.tehsilId;
            seller.address = input.location.address;
            seller.pincode = input.location.pincode ?? null;
            if (input.location.pincode) {
                await recordPincodeIfUnknown({ pincode: input.location.pincode, tehsilId: input.location.tehsilId }, actor, session);
            }
        }
        await SellerAssignment.findOneAndUpdate({ sellerId: seller._id }, {
            $set: {
                ownerEmployeeId: input.assignedToEmployeeId,
                assignedAt: new Date(),
                assignedBy: actor.employeeId,
                reason: 'Assigned at approval.',
            },
        }, { upsert: true, session });
        if (input.trustTier && input.trustTier !== seller.trustTier) {
            seller.trustTier = input.trustTier;
            seller.tierSeededBy = actor.employeeId;
            seller.tierSeededReason = input.seedReason ?? null;
        }
        await seller.save({ session });
        counterparty.status = 'active';
        await counterparty.save({ session });
        await enqueueNotification({
            counterpartyId: counterparty._id,
            templateKey: 'registration_invite',
            params: { outcome: 'approved' },
            correlationId: actor.correlationId,
        }, session);
        await writeAuditLog({
            actorId: actor.employeeId,
            actorType: 'staff',
            entity: 'counterparty',
            entityId: counterparty._id,
            field: 'status',
            oldValue: 'pending',
            newValue: 'active',
            correlationId: actor.correlationId,
        }, session);
    });
}
/**
 * Phase 4 — approve or reject a seller registration: a Purchase Leader for a
 * seller in his team or the Queue, or Admin (SELLER_APPROVE is checked on
 * the route).
 */
export async function assertCallerMayDecideSeller(sellerId, caller) {
    const current = await SellerAssignment.findOne({ sellerId });
    const covered = await callerCovers('purchase', caller, current ? String(current.ownerEmployeeId) : null, { queueAllowed: true });
    if (!covered) {
        throw new AppError({
            code: 'PERMISSION_DENIED',
            messageEn: "Only the Purchase Leader of this seller's team, or Admin, can decide on him.",
        });
    }
}
/** API-015. */
export async function rejectRegistration(registrationId, reason, actor) {
    const counterparty = await Counterparty.findById(registrationId);
    if (!counterparty) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Registration not found.' });
    }
    if (counterparty.status !== 'pending') {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'This registration has already been decided.',
        });
    }
    // TD-004 — the rejection, its audit line and the notification API-015 promises
    // ("Fires a notification") commit together.
    await withTransaction(async (session) => {
        counterparty.status = 'rejected';
        await counterparty.save({ session });
        await enqueueNotification({
            counterpartyId: counterparty._id,
            templateKey: 'registration_invite',
            params: { outcome: 'rejected' }, // A coded outcome only — the free-text reason stays internal.
            correlationId: actor.correlationId,
        }, session);
        await writeAuditLog({
            actorId: actor.employeeId,
            actorType: 'staff',
            entity: 'counterparty',
            entityId: counterparty._id,
            field: 'status',
            oldValue: 'pending',
            newValue: 'rejected',
            reason,
            correlationId: actor.correlationId,
        }, session);
    });
}
/** Staff-facing: masked bank detail for a counterparty (new — see API_CONTRACT.md). */
export async function getBankDetail(counterpartyId) {
    const details = await BankDetail.find({ counterpartyId }).sort({ createdAt: -1 });
    return details.map(toBankDetailDto);
}
/**
 * BR-017 — a change does not become payable-to until 24 hours after a
 * verified call-back to the number already on file. This creates the
 * pending replacement; `logBankDetailCallback` below starts the clock.
 */
export async function changeBankDetail(counterpartyId, input, actor) {
    assertBankDetailIsWellFormed(input);
    const counterparty = await Counterparty.findById(counterpartyId);
    if (!counterparty) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Counterparty not found.' });
    }
    const pending = await BankDetail.create({
        counterpartyId,
        accountEncrypted: encryptAccountNumber(input.accountNumber),
        ifsc: input.ifsc,
        accountName: input.accountName,
        isActive: false,
    });
    await writeAuditLog({
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'bank_detail',
        entityId: pending._id,
        field: 'create_pending_change',
        correlationId: actor.correlationId,
    });
    await auditAccountNameMismatchIfAny({
        accountName: input.accountName,
        ownerName: counterparty.ownerName ?? '',
        firm: counterparty.firm ?? '',
        entityId: counterparty._id,
        correlationId: actor.correlationId,
    });
    return toBankDetailDto(pending);
}
/**
 * Logs the call-back to the number already on file and starts the
 * 24-hour cooling clock (BR-017). It does not flip `isActive` itself —
 * `isBankDetailPayable` below is the read-time check M4's payout gate will
 * call once money exists.
 */
export async function logBankDetailCallback(bankDetailId, actor) {
    const pending = await BankDetail.findById(bankDetailId);
    if (!pending) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Bank detail not found.' });
    }
    if (pending.callbackLoggedAt) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'A call-back was already logged for this change.',
        });
    }
    const now = new Date();
    pending.callbackLoggedAt = now;
    pending.verifiedAt = now;
    pending.verifiedBy = actor.employeeId;
    pending.effectiveFrom = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await pending.save();
    await writeAuditLog({
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'bank_detail',
        entityId: pending._id,
        field: 'callback_logged',
        newValue: { effectiveFrom: pending.effectiveFrom },
        correlationId: actor.correlationId,
    });
    return toBankDetailDto(pending);
}
// Read-time payability check — BR-017. Nothing consumes this yet (payout is
// M4), but it is the single place that answers "is this bank detail
// payable-to right now", so a later payout gate never has to re-derive it.
export function isBankDetailPayable(detail) {
    if (!detail.verifiedAt || !detail.effectiveFrom)
        return false;
    return detail.effectiveFrom.getTime() <= Date.now();
}
