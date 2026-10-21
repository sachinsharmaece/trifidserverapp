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
async function auditAccountNameMismatchIfAny(params, session) {
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
function assertStaffAssistedOtpConfirmed(counterparty) {
    if (counterparty.staffAssisted && !counterparty.staffAssistedOtpVerifiedAt) {
        throw new AppError({
            code: 'OTP_CONFIRMATION_REQUIRED',
            messageEn: 'This registration was staff-assisted and still needs an OTP confirmation to the real phone number before it can be approved.',
            field: 'staffAssistedOtpVerifiedAt',
        });
    }
}
function assertBankDetailIsWellFormed(bankDetail) {
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
async function writeConsents(counterpartyId, consent, session) {
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
async function createPendingBankDetail(counterpartyId, input, session) {
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
    // sees two '' values.
    const gstin = input.gstin?.trim() || undefined;
    await assertGstinAndMobileAreFree(gstin, input.mobile, Boolean(staffAssisted));
    if (input.bankDetail && !staffAssisted)
        assertBankDetailIsWellFormed(input.bankDetail);
    let accountNameWarning = null;
    const registrationId = await withTransaction(async (session) => {
        const [counterparty] = await Counterparty.create([
            {
                mobile: input.mobile,
                firm: input.firm || undefined,
                gstin,
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
        const [buyer] = await Buyer.create([{ counterpartyId: counterparty._id, gstPpobAddress: input.gstPpobAddress || undefined }], { session });
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
export async function registerSeller(input, staffAssisted, correlationId = 'unknown') {
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
                firm: input.firm,
                gstin: input.gstin,
                ownerName: input.ownerName,
                licenceNo: input.licenceNo,
                kind: 'seller',
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
        const [seller] = await Seller.create([{ counterpartyId: counterparty._id }], { session });
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
/** API-013. */
export async function listRegistrations(stage, cursor, limit) {
    const query = {};
    if (stage)
        query.status = stage;
    if (cursor)
        query._id = { $gt: cursor };
    const registrations = await Counterparty.find(query)
        .sort({ _id: 1 })
        .limit(limit + 1);
    const hasMore = registrations.length > limit;
    const page = hasMore ? registrations.slice(0, limit) : registrations;
    const items = page.map((counterparty) => ({
        registrationId: counterparty._id.toString(),
        firm: counterparty.firm ?? undefined,
        gstin: counterparty.gstin ?? undefined,
        kind: counterparty.kind,
        status: counterparty.status,
        createdAt: counterparty.createdAt,
        staffAssisted: counterparty.staffAssisted ?? false,
    }));
    const nextCursor = hasMore
        ? page[page.length - 1]._id.toString()
        : undefined;
    return { items, nextCursor };
}
/** API-014, buyer branch. BR-081 — rejects without a tehsil, enforced by the required field on the schema. */
export async function approveBuyer(registrationId, input, actor) {
    const tehsil = await Tehsil.findById(input.tehsilId);
    if (!tehsil) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'That tehsil does not exist.',
            field: 'tehsilId',
        });
    }
    const counterparty = await Counterparty.findOne({
        _id: registrationId,
        kind: { $in: ['buyer', 'both'] },
    });
    if (!counterparty) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Buyer registration not found.' });
    }
    if (counterparty.status !== 'pending') {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'This registration has already been decided.',
        });
    }
    // B-28 — registration-time validation already requires both (min(1) on
    // the schema); this is the backstop for a record that predates it or was
    // written outside that path, so approval can't turn a blank firm/GSTIN
    // into an active account.
    if (!counterparty.firm?.trim() || !counterparty.gstin?.trim()) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'This registration is missing a firm name or GSTIN and cannot be approved as is.',
        });
    }
    // TEMP: buyer OTP gate disabled 2026-09-28 at product's request — re-enable
    // by restoring this call before launch. Seller keeps the gate (below).
    // assertStaffAssistedOtpConfirmed(counterparty);
    await withTransaction(async (session) => {
        await Buyer.updateOne({ counterpartyId: counterparty._id }, {
            $set: {
                tehsilId: input.tehsilId,
                tradePosition: input.tradePosition,
                isTrader: input.isTrader,
                classified: true,
            },
        }, { session });
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
    assertStaffAssistedOtpConfirmed(counterparty);
    const seller = await Seller.findOne({ counterpartyId: counterparty._id });
    if (!seller) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller profile not found.' });
    }
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
