import * as marketplaceService from './marketplace.service.js';
import { restartListingSchema, stopListingSchema, withdrawQuoteSchema, } from './marketplace.validation.js';
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
// RECTIFY-01 Phase 0 — 🏢 Purchase Leader / Admin. Preview first, then the same call with confirm.
export async function postStopListing(req, res) {
    const input = stopListingSchema.parse(req.body);
    ok(res, req, await marketplaceService.stopListing(req.params.id, input, callerOf(req)));
}
export async function postRestartListing(req, res) {
    const input = restartListingSchema.parse(req.body ?? {});
    ok(res, req, await marketplaceService.restartListing(req.params.id, input, callerOf(req)));
}
export async function postWithdrawQuote(req, res) {
    const input = withdrawQuoteSchema.parse(req.body);
    ok(res, req, await marketplaceService.withdrawQuote(req.params.id, input, callerOf(req)));
}
