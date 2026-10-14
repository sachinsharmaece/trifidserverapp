import { Counterparty } from '../../models/Counterparty.js';
import { AppError } from '../../shared/errors.js';
import * as onboardingService from './onboarding.service.js';
import { approveBuyerSchema, approveSellerSchema } from './onboarding.validation.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
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
    const { callNote, ...input } = req.body;
    const result = await onboardingService.registerBuyer(input, {
        employeeId: req.auth.employeeId,
        callNote,
        correlationId: req.correlationId,
    });
    ok(res, req, result, 201);
}
export async function postStaffRegisterSeller(req, res) {
    const { callNote, ...input } = req.body;
    const result = await onboardingService.registerSeller(input, {
        employeeId: req.auth.employeeId,
        callNote,
        correlationId: req.correlationId,
    });
    ok(res, req, result, 201);
}
export async function getRegistration(req, res) {
    const requesterCounterpartyId = req.auth?.actorType === 'counterparty' ? req.auth.counterpartyId : undefined;
    const result = await onboardingService.getRegistration(req.params.id, requesterCounterpartyId);
    ok(res, req, result);
}
export async function getRegistrations(req, res) {
    const { stage, cursor, limit } = req.validatedQuery;
    const result = await onboardingService.listRegistrations(stage, cursor, limit ?? 25);
    res.status(200).json({
        data: result.items,
        meta: { correlationId: req.correlationId, nextCursor: result.nextCursor },
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
    const actor = { employeeId: req.auth.employeeId, correlationId: req.correlationId };
    if (counterparty.kind === 'seller') {
        const input = approveSellerSchema.parse(req.body);
        await onboardingService.approveSeller(registrationId, input, actor);
    }
    else {
        const input = approveBuyerSchema.parse(req.body);
        await onboardingService.approveBuyer(registrationId, input, actor);
    }
    ok(res, req, { approved: true });
}
export async function postReject(req, res) {
    const { reason } = req.body;
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
