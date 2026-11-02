import * as leadService from './lead.service.js';
function actorOf(req) {
    return {
        employeeId: req.auth.employeeId,
        permissions: req.auth.permissions,
        correlationId: req.correlationId,
    };
}
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
export async function getLookup(req, res) {
    ok(res, req, await leadService.lookupLead(req.validatedQuery, actorOf(req)));
}
export async function postBuyerOwner(req, res) {
    const input = req.body;
    ok(res, req, await leadService.changeOwner('sales', req.params.buyerId, input, actorOf(req)));
}
export async function postSellerOwner(req, res) {
    const input = req.body;
    ok(res, req, await leadService.changeOwner('purchase', req.params.sellerId, input, actorOf(req)));
}
