import { Counterparty } from '../../models/Counterparty.js';
import { AppError } from '../../shared/errors.js';
import * as onboardingService from './onboarding.service.js';
import * as buyers from './buyer.registration.js';
import * as sellers from './seller.registration.js';
import { Seller } from '../../models/Seller.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { Buyer } from '../../models/Buyer.js';
import { approveBuyerSchema, approveSellerSchema } from './onboarding.validation.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
function callerOf(req) {
    return {
        employeeId: req.auth.employeeId,
        permissions: req.auth.permissions,
        correlationId: req.correlationId,
    };
}
// F1 - a registration is decided by its own side: a buyer by BUYER_APPROVE
// (Sales Leaders, Admin), a seller by SELLER_APPROVE (Purchase).
function assertMayDecide(req, kind) {
    const needed = kind === 'seller' ? PERMISSIONS.SELLER_APPROVE : PERMISSIONS.BUYER_APPROVE;
    if (!req.auth.permissions.includes(needed)) {
        throw new AppError({
            code: 'PERMISSION_DENIED',
            messageEn: kind === 'seller'
                ? 'Only Purchase can approve or reject a seller.'
                : "Only the buyer's Sales Leader, or Admin, can approve or reject a buyer.",
        });
    }
}
/** The sides of the Registrations list this caller may see (F1). */
function registrationKindsFor(req) {
    const p = req.auth.permissions;
    if (p.includes(PERMISSIONS.CHAIN_READ_FULL))
        return undefined; // the full view
    const kinds = [];
    if (p.includes(PERMISSIONS.SALES_WORKLIST_READ) || p.includes(PERMISSIONS.BUYER_APPROVE)) {
        kinds.push('buyer');
    }
    if (p.includes(PERMISSIONS.PROXY_SELLER_CALL) || p.includes(PERMISSIONS.SELLER_APPROVE)) {
        kinds.push('seller');
    }
    return kinds;
}
export async function postRegisterBuyer(req, res) {
    const result = await onboardingService.registerBuyer(req.body, undefined, req.correlationId);
    ok(res, req, result, 201);
}
export async function postRegisterSeller(req, res) {
    const result = await onboardingService.registerSeller(req.body, undefined, req.correlationId);
    ok(res, req, result, 201);
}
// Staff-assisted enquiries — Sales raises a buyer registration on a phone
// call. Body validated by staffRegisterBuyerSchema (validateBody middleware
// on the route); calls the exact same registerBuyer used by API-010, plus
// the mandatory call note.
export async function postStaffRegisterBuyer(req, res) {
    const result = await buyers.registerBuyerByStaff(req.body, callerOf(req));
    ok(res, req, result, 201);
}
export async function postStaffRegisterSeller(req, res) {
    const result = await sellers.registerSellerByStaff(req.body, callerOf(req));
    ok(res, req, result, 201);
}
export async function getRegistration(req, res) {
    const requesterCounterpartyId = req.auth?.actorType === 'counterparty' ? req.auth.counterpartyId : undefined;
    const result = await onboardingService.getRegistration(req.params.id, requesterCounterpartyId);
    ok(res, req, result);
}
export async function getRegistrations(req, res) {
    const { stage, cursor, limit, q, kind } = req.validatedQuery;
    // A desk sees its own side (F1); `kind` narrows that further, never widens it.
    const allowed = registrationKindsFor(req);
    const kinds = kind ? (allowed ?? ['buyer', 'seller']).filter((k) => k === kind) : allowed;
    const result = await onboardingService.listRegistrations(stage, cursor, limit ?? 25, {
        kinds,
        q,
    });
    res.status(200).json({
        data: result.items,
        meta: { correlationId: req.correlationId, nextCursor: result.nextCursor, total: result.total },
    });
}
// API-014 — the request body shape depends on whether the registration is a
// buyer or a seller, so this route validates against the matching schema
// itself rather than through the usual validateBody middleware.
export async function postApprove(req, res) {
    const registrationId = req.params.id;
    const counterparty = await Counterparty.findById(registrationId);
    if (!counterparty) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Registration not found.' });
    }
    assertMayDecide(req, counterparty.kind);
    if (counterparty.kind === 'seller') {
        const input = approveSellerSchema.parse(req.body);
        await onboardingService.approveSeller(registrationId, input, callerOf(req));
    }
    else {
        const input = approveBuyerSchema.parse(req.body);
        await buyers.approveBuyer(registrationId, input, callerOf(req));
    }
    ok(res, req, { approved: true });
}
export async function postReject(req, res) {
    const { reason } = req.body;
    const counterparty = await Counterparty.findById(req.params.id);
    if (!counterparty) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Registration not found.' });
    }
    assertMayDecide(req, counterparty.kind);
    if (counterparty.kind === 'seller') {
        const seller = await Seller.findOne({ counterpartyId: counterparty._id }, { _id: 1 });
        if (seller)
            await onboardingService.assertCallerMayDecideSeller(seller._id, callerOf(req));
    }
    else {
        const buyer = await Buyer.findOne({ counterpartyId: counterparty._id }, { _id: 1 });
        if (buyer)
            await buyers.assertCallerMayDecideBuyer(buyer._id, callerOf(req));
    }
    await onboardingService.rejectRegistration(req.params.id, reason, {
        employeeId: req.auth.employeeId,
        correlationId: req.correlationId,
    });
    ok(res, req, { rejected: true });
}
export async function getBankDetail(req, res) {
    const result = await onboardingService.getBankDetail(req.params.id);
    ok(res, req, result);
}
export async function postBankDetailChange(req, res) {
    const result = await onboardingService.changeBankDetail(req.params.id, req.body, { employeeId: req.auth.employeeId, correlationId: req.correlationId });
    ok(res, req, result, 201);
}
export async function postBankDetailCallback(req, res) {
    const result = await onboardingService.logBankDetailCallback(req.params.bankDetailId, {
        employeeId: req.auth.employeeId,
        correlationId: req.correlationId,
    });
    ok(res, req, result);
}
/** Phase 3 - the buyer profile behind a registration (approval prefill). */
export async function getRegistrationBuyerProfile(req, res) {
    ok(res, req, await buyers.getBuyerProfile({ counterpartyId: req.params.id }, callerOf(req)));
}
export async function getBuyerProfile(req, res) {
    ok(res, req, await buyers.getBuyerProfile({ buyerId: req.params.buyerId }, callerOf(req)));
}
export async function putBuyerProfile(req, res) {
    ok(res, req, await buyers.updateBuyerProfile(req.params.buyerId, req.body, callerOf(req)));
}
/** Phase 4 — the seller profile behind a registration (approval prefill). */
export async function getRegistrationSellerProfile(req, res) {
    ok(res, req, await sellers.getSellerProfile({ counterpartyId: req.params.id }, callerOf(req)));
}
export async function getSellerProfile(req, res) {
    ok(res, req, await sellers.getSellerProfile({ sellerId: req.params.sellerId }, callerOf(req)));
}
export async function putSellerProfile(req, res) {
    ok(res, req, await sellers.updateSellerProfile(req.params.sellerId, req.body, callerOf(req)));
}
