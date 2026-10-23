import { withTransaction } from '../../db/transaction.js';
import { env } from '../../config/env.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { Counterparty } from '../../models/Counterparty.js';
import { Buyer } from '../../models/Buyer.js';
import { BuyerDealership } from '../../models/BuyerDealership.js';
import { BookAssignment } from '../../models/BookAssignment.js';
import { Manufacturer } from '../../models/Manufacturer.js';
import { Employee } from '../../models/Employee.js';
import { Tehsil } from '../../models/Tehsil.js';
import { District } from '../../models/District.js';
import { State } from '../../models/State.js';
import { gstinMatchesStateCode } from '../../shared/validators.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { assertMayAssignBuyer, callerCoversBuyer, defaultAssigneeFor, salesLeaderOf, mayChangeOwner, } from '../../shared/team.js';
import { assertLocationChain, recordPincodeIfUnknown } from '../territory/territory.masters.js';
import { enqueueNotification } from '../notification/notification.outbox.js';
import { checkBuyerIdentity } from './buyer.identity.js';
import { assertBankDetailIsWellFormed, assertStaffAssistedOtpConfirmed, auditAccountNameMismatchIfAny, createPendingBankDetail, writeConsents, } from './onboarding.service.js';
const id = (value) => String(value);
async function assertDealershipsExist(dealerships) {
    const ids = [...new Set((dealerships ?? []).map((d) => d.manufacturerId))];
    if (ids.length === 0)
        return;
    const known = await Manufacturer.countDocuments({ _id: { $in: ids } });
    if (known !== ids.length) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'One of those companies does not exist.',
            field: 'dealerships',
        });
    }
}
async function assertMargCodeFree(code, exceptBuyerId) {
    if (!code)
        return;
    const clash = await Buyer.findOne({
        margPartyCode: code,
        ...(exceptBuyerId ? { _id: { $ne: exceptBuyerId } } : {}),
    });
    if (clash) {
        const cp = await Counterparty.findById(clash.counterpartyId, { firm: 1 });
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: `Marg party code ${code} already belongs to ${cp?.firm ?? 'another buyer'}.`,
            field: 'margPartyCode',
            meta: { existingCounterpartyId: id(clash.counterpartyId), existingFirm: cp?.firm ?? '' },
        });
    }
}
async function setAssignment(buyerId, ownerEmployeeId, assignedBy, reason, session) {
    await BookAssignment.findOneAndUpdate({ buyerId }, { $set: { ownerEmployeeId, assignedAt: new Date(), assignedBy, reason } }, { upsert: true, session });
}
export async function registerBuyerByStaff(input, caller) {
    const identity = await checkBuyerIdentity({
        mode: 'staff',
        gstin: input.gstin,
        pan: input.pan,
        mobile: input.mobile,
        stateId: input.location.stateId,
        confirmations: input.confirmations,
    });
    const place = await assertLocationChain(input.location);
    await assertDealershipsExist(input.dealerships);
    await assertMargCodeFree(input.margPartyCode);
    if (input.bankDetail)
        assertBankDetailIsWellFormed(input.bankDetail);
    // Assigned to: left out → the person registering (if he is on the Sales
    // side); null → the Queue; otherwise the assign rule decides.
    const assignee = input.assignedToEmployeeId === undefined
        ? await defaultAssigneeFor(caller.employeeId)
        : input.assignedToEmployeeId;
    await assertMayAssignBuyer(caller, assignee);
    let accountNameWarning = null;
    const registrationId = await withTransaction(async (session) => {
        const [counterparty] = await Counterparty.create([
            {
                mobile: identity.loginMobile,
                contactMobile: identity.contactMobile,
                firm: input.firm,
                gstin: identity.gstin,
                pan: identity.pan,
                ownerName: input.ownerName,
                licenceNo: input.licenceNo,
                kind: 'buyer',
                status: 'pending',
                staffAssisted: true,
                staffAssistedByEmployeeId: caller.employeeId,
                staffAssistedCallNote: input.callNote ?? null,
                proprietorAgreedAt: new Date(),
            },
        ], { session });
        if (!counterparty)
            throw new Error('Counterparty.create returned no document.');
        const counterpartyId = counterparty._id;
        const [buyer] = await Buyer.create([
            {
                counterpartyId,
                category: input.category,
                tehsilId: place.tehsilId,
                address: input.location.address,
                pincode: input.location.pincode ?? null,
                gstPpobAddress: input.location.address,
                margPartyCode: input.margPartyCode ?? null,
            },
        ], { session });
        if (!buyer)
            throw new Error('Buyer.create returned no document.');
        if (input.dealerships?.length) {
            await BuyerDealership.create(input.dealerships.map((d) => ({
                buyerId: buyer._id,
                manufacturerId: d.manufacturerId,
                isStrong: d.isStrong ?? false,
            })), { session, ordered: true });
        }
        if (input.bankDetail)
            await createPendingBankDetail(counterpartyId, input.bankDetail, session);
        await writeConsents(counterpartyId, input.consent, session);
        if (input.location.pincode) {
            await recordPincodeIfUnknown({ pincode: input.location.pincode, tehsilId: input.location.tehsilId }, caller, session);
        }
        if (assignee) {
            await setAssignment(buyer._id, assignee, caller.employeeId, 'Assigned at registration.', session);
        }
        await writeAuditLog({
            actorId: caller.employeeId,
            actorType: 'staff',
            entity: 'counterparty',
            entityId: counterpartyId,
            field: 'staff_assisted_registration',
            newValue: {
                kind: 'buyer',
                category: input.category,
                tehsilId: input.location.tehsilId,
                assignedToEmployeeId: assignee,
                loginMobile: Boolean(identity.loginMobile),
                proprietorAgreed: true,
            },
            reason: input.callNote,
            correlationId: caller.correlationId,
        }, session);
        if (input.bankDetail) {
            accountNameWarning = await auditAccountNameMismatchIfAny({
                accountName: input.bankDetail.accountName,
                ownerName: input.ownerName ?? '',
                firm: input.firm,
                entityId: counterpartyId,
                correlationId: caller.correlationId,
            }, session);
        }
        return id(counterpartyId);
    });
    return { registrationId, accountNameWarning, loginMobile: Boolean(identity.loginMobile) };
}
// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------
/**
 * Approve or reject a buyer registration: a Sales Leader for a buyer in his
 * team or the Queue, or Admin (BUYER_APPROVE is checked on the route).
 */
export async function assertCallerMayDecideBuyer(buyerId, caller) {
    const current = await BookAssignment.findOne({ buyerId });
    const covered = await callerCoversBuyer(caller, current ? id(current.ownerEmployeeId) : null, {
        queueAllowed: true,
    });
    if (!covered) {
        throw new AppError({
            code: 'PERMISSION_DENIED',
            messageEn: "Only the Sales Leader of this buyer's team, or Admin, can decide on him.",
        });
    }
}
/**
 * API-014, buyer branch. Only a Sales Leader (for a buyer in his team or the
 * Queue) or Admin approves. Category, location and "Assigned to" are
 * prefilled from the registration and editable; Assigned to is required
 * (DEC-062). BR-081 — the tehsil is required by the schema.
 */
export async function approveBuyer(registrationId, input, caller) {
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
    const buyer = await Buyer.findOne({ counterpartyId: counterparty._id });
    if (!buyer)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Buyer profile not found.' });
    await assertCallerMayDecideBuyer(buyer._id, caller);
    // B-28 backstop — a record that predates the real form (or was written
    // outside it) cannot become an active account without a firm and an
    // identity. GSTIN *or* PAN now (DEC-054), which un-sticks the staff
    // registrations that had neither (F2) once they are edited.
    if (!counterparty.firm?.trim() || !(counterparty.gstin?.trim() || counterparty.pan?.trim())) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'This registration has no firm name, or neither a GSTIN nor a PAN — add them before approving.',
        });
    }
    // DEC-056 — the OTP wait is off unless REQUIRE_REGISTRATION_OTP is on.
    if (env.requireRegistrationOtp)
        assertStaffAssistedOtpConfirmed(counterparty);
    await assertMayAssignBuyer(caller, input.assignedToEmployeeId);
    const place = await assertLocationChain(input.location);
    if (counterparty.gstin) {
        // Same state-code rule as at registration, against the approved location.
        await checkBuyerIdentityStateOnly(counterparty.gstin, input.location.stateId);
    }
    await withTransaction(async (session) => {
        await Buyer.updateOne({ _id: buyer._id }, {
            $set: {
                category: input.category,
                tehsilId: place.tehsilId,
                address: input.location.address,
                pincode: input.location.pincode ?? null,
                gstPpobAddress: input.location.address,
                classified: true,
            },
        }, { session });
        if (input.location.pincode) {
            await recordPincodeIfUnknown({ pincode: input.location.pincode, tehsilId: input.location.tehsilId }, caller, session);
        }
        await setAssignment(buyer._id, input.assignedToEmployeeId, caller.employeeId, 'Assigned at approval.', session);
        counterparty.status = 'active';
        await counterparty.save({ session });
        await enqueueNotification({
            counterpartyId: counterparty._id,
            templateKey: 'registration_invite',
            params: { outcome: 'approved' },
            correlationId: caller.correlationId,
        }, session);
        await writeAuditLog({
            actorId: caller.employeeId,
            actorType: 'staff',
            entity: 'counterparty',
            entityId: counterparty._id,
            field: 'status',
            oldValue: 'pending',
            newValue: 'active',
            reason: `Approved as ${input.category}, assigned to ${input.assignedToEmployeeId}.`,
            correlationId: caller.correlationId,
        }, session);
    });
}
async function checkBuyerIdentityStateOnly(gstin, stateId) {
    const state = await State.findById(stateId);
    if (state && !gstinMatchesStateCode(gstin, state.gstStateCode)) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: `This buyer's GSTIN starts with state code ${gstin.slice(0, 2)}, but the location picked is in ${state.name} (${state.gstStateCode}).`,
            field: 'location.stateId',
        });
    }
}
export async function getBuyerProfile(buyerOrCounterpartyId, caller) {
    const buyer = buyerOrCounterpartyId.buyerId
        ? await Buyer.findById(buyerOrCounterpartyId.buyerId)
        : await Buyer.findOne({ counterpartyId: buyerOrCounterpartyId.counterpartyId });
    if (!buyer)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Buyer not found.' });
    const counterparty = await Counterparty.findById(buyer.counterpartyId);
    if (!counterparty)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Buyer not found.' });
    const tehsil = buyer.tehsilId ? await Tehsil.findById(buyer.tehsilId) : null;
    const district = tehsil?.districtId ? await District.findById(tehsil.districtId) : null;
    const assignment = await BookAssignment.findOne({ buyerId: buyer._id });
    const owner = assignment
        ? await Employee.findById(assignment.ownerEmployeeId, { person: 1 })
        : null;
    const leaderId = owner ? await salesLeaderOf(id(owner._id)) : null;
    const leader = leaderId ? await Employee.findById(leaderId, { person: 1 }) : null;
    const dealerships = await BuyerDealership.find({ buyerId: buyer._id });
    const manufacturers = await Manufacturer.find({ _id: { $in: dealerships.map((d) => d.manufacturerId) } }, { name: 1 });
    const ownerId = owner ? id(owner._id) : null;
    const isAdmin = caller.permissions.includes(PERMISSIONS.BUYER_ADMIN);
    const canEdit = await callerCoversBuyer(caller, ownerId, { queueAllowed: false });
    const leaderOfOwner = Boolean(leaderId && leaderId === caller.employeeId);
    return {
        buyerId: id(buyer._id),
        counterpartyId: id(counterparty._id),
        status: counterparty.status,
        firm: counterparty.firm ?? '',
        ownerName: counterparty.ownerName ?? null,
        gstin: counterparty.gstin ?? null,
        pan: counterparty.pan ?? null,
        registered: Boolean(counterparty.gstin),
        loginMobile: counterparty.mobile ?? null,
        contactMobile: counterparty.contactMobile ?? counterparty.mobile ?? null,
        category: buyer.category ?? null,
        location: {
            address: buyer.address ?? buyer.gstPpobAddress ?? null,
            pincode: buyer.pincode ?? null,
            stateId: district ? id(district.stateId) : null,
            districtId: tehsil?.districtId ? id(tehsil.districtId) : null,
            tehsilId: tehsil ? id(tehsil._id) : null,
            tehsil: tehsil?.name ?? null,
            district: tehsil?.district ?? null,
            state: tehsil?.state ?? null,
        },
        licenceNo: counterparty.licenceNo ?? null,
        margPartyCode: buyer.margPartyCode ?? null,
        companies: manufacturers.map((m) => ({ manufacturerId: id(m._id), name: m.name })),
        assignedTo: owner ? { employeeId: id(owner._id), person: owner.person } : null,
        assignedLeader: leader ? { employeeId: id(leader._id), person: leader.person } : null,
        canEdit,
        canEditCategory: isAdmin || (canEdit && (leaderOfOwner || (await isLeader(caller.employeeId)))),
        canEditIdentity: isAdmin,
        canChangeOwner: await mayChangeOwner('sales', caller, ownerId),
    };
}
async function isLeader(employeeId) {
    return Boolean(await Employee.exists({ _id: employeeId, positions: 'SALES_LEADER' }));
}
/**
 * Phase 3 — Edit on the buyer profile. The assigned executive, his leader and
 * Admin may edit; only a leader or Admin changes the category; only Admin
 * changes GSTIN or PAN. A field the caller may not change must arrive
 * unchanged, or the save is refused naming it.
 */
export async function updateBuyerProfile(buyerId, input, caller) {
    const before = await getBuyerProfile({ buyerId }, caller);
    if (!before.canEdit) {
        throw new AppError({
            code: 'PERMISSION_DENIED',
            messageEn: 'Only his assigned executive, that executive’s leader, or Admin can edit this buyer.',
        });
    }
    const sameIdentity = (input.gstin ?? null) === before.gstin &&
        (input.gstin ? true : (input.pan ?? null) === before.pan);
    if (!sameIdentity && !before.canEditIdentity) {
        throw new AppError({
            code: 'PERMISSION_DENIED',
            messageEn: 'Only Admin can change a buyer’s GSTIN or PAN.',
            field: input.gstin !== (before.gstin ?? undefined) ? 'gstin' : 'pan',
        });
    }
    if (input.category !== before.category && !before.canEditCategory) {
        throw new AppError({
            code: 'PERMISSION_DENIED',
            messageEn: 'Only a Sales Leader or Admin can change the category.',
            field: 'category',
        });
    }
    const identity = await checkBuyerIdentity({
        mode: 'edit',
        gstin: input.gstin,
        pan: input.pan,
        mobile: input.contactMobile,
        stateId: input.location.stateId,
        exceptCounterpartyId: before.counterpartyId,
        confirmations: input.contactMobile === before.contactMobile
            ? { ...input.confirmations, sharedMobile: true }
            : input.confirmations,
    });
    const place = await assertLocationChain(input.location);
    await assertDealershipsExist(input.dealerships);
    await assertMargCodeFree(input.margPartyCode, buyerId);
    await withTransaction(async (session) => {
        await Counterparty.updateOne({ _id: before.counterpartyId }, {
            $set: {
                firm: input.firm,
                ownerName: input.ownerName ?? null,
                contactMobile: identity.contactMobile,
                gstin: identity.gstin ?? undefined,
                pan: identity.pan,
                licenceNo: input.licenceNo ?? null,
            },
            ...(identity.gstin ? {} : { $unset: { gstin: 1 } }),
        }, { session });
        await Buyer.updateOne({ _id: buyerId }, {
            $set: {
                category: input.category,
                tehsilId: place.tehsilId,
                address: input.location.address,
                pincode: input.location.pincode ?? null,
                gstPpobAddress: input.location.address,
                margPartyCode: input.margPartyCode ?? null,
                ...(before.category ? {} : { classified: true }),
            },
        }, { session });
        if (input.dealerships) {
            await BuyerDealership.deleteMany({ buyerId }, { session });
            if (input.dealerships.length) {
                await BuyerDealership.create(input.dealerships.map((d) => ({
                    buyerId,
                    manufacturerId: d.manufacturerId,
                    isStrong: d.isStrong ?? false,
                })), { session, ordered: true });
            }
        }
        if (input.location.pincode) {
            await recordPincodeIfUnknown({ pincode: input.location.pincode, tehsilId: input.location.tehsilId }, caller, session);
        }
        await writeAuditLog({
            actorId: caller.employeeId,
            actorType: 'staff',
            entity: 'buyer',
            entityId: buyerId,
            field: 'edit',
            oldValue: {
                firm: before.firm,
                gstin: before.gstin,
                pan: before.pan,
                category: before.category,
                tehsilId: before.location.tehsilId,
                contactMobile: before.contactMobile,
                margPartyCode: before.margPartyCode,
            },
            newValue: {
                firm: input.firm,
                gstin: identity.gstin ?? null,
                pan: identity.pan,
                category: input.category,
                tehsilId: input.location.tehsilId,
                contactMobile: identity.contactMobile,
                margPartyCode: input.margPartyCode ?? null,
            },
            correlationId: caller.correlationId,
        }, session);
    });
    return getBuyerProfile({ buyerId }, caller);
}
