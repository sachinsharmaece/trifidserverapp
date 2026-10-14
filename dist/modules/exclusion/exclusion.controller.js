import { AppError } from '../../shared/errors.js';
import * as exclusionService from './exclusion.service.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
function requireSellerCounterpartyId(req) {
    const counterpartyId = req.auth?.counterpartyId;
    if (req.auth?.actorType !== 'counterparty' || !counterpartyId) {
        throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Sellers only.' });
    }
    return counterpartyId;
}
export async function postLookup(req, res) {
    const { gstin } = req.body;
    const result = await exclusionService.lookupGstin(gstin, requireSellerCounterpartyId(req), req.ip ?? 'unknown');
    ok(res, req, result);
}
export async function getExclusions(req, res) {
    const result = await exclusionService.listExclusions(requireSellerCounterpartyId(req));
    ok(res, req, result);
}
export async function postExclusion(req, res) {
    const { gstin } = req.body;
    const result = await exclusionService.createExclusion(requireSellerCounterpartyId(req), gstin);
    ok(res, req, result, 201);
}
export async function deleteExclusion(req, res) {
    await exclusionService.removeExclusion(requireSellerCounterpartyId(req), req.params.id);
    ok(res, req, { removed: true });
}
