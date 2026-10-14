import * as poolService from './pool.service.js';
import { commitToPoolSchema, resolvePoolShortfallSchema } from './pool.validation.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
// API-060 — 👤B.
export async function getPools(req, res) {
    const { skuIds } = req.validatedQuery;
    const result = await poolService.getPoolsForProduct(skuIds.split(','));
    ok(res, req, result);
}
export async function getPool(req, res) {
    const result = await poolService.getPool(req.auth?.counterpartyId ?? null, req.params.id);
    ok(res, req, result);
}
// API-061 — 👤B. Idempotency-Key required — may create a chain (post-trigger joiner).
export async function postCommit(req, res) {
    const input = commitToPoolSchema.parse(req.body);
    const result = await poolService.commitToPool(req.auth.counterpartyId, req.params.id, input);
    ok(res, req, result, 201);
}
// API-062 — 👤B.
export async function postReconfirm(req, res) {
    await poolService.reconfirmPool(req.auth.counterpartyId, req.params.id);
    ok(res, req, { reconfirmed: true });
}
export async function postWithdraw(req, res) {
    await poolService.withdrawFromPool(req.auth.counterpartyId, req.params.id);
    ok(res, req, { withdrawn: true });
}
// API-063 — 👤S. Idempotency-Key required — creates a chain per binding buyer.
export async function postTriggerEarly(req, res) {
    await poolService.triggerPoolEarly(req.auth.counterpartyId, req.params.id);
    ok(res, req, { triggered: true });
}
// New — BR-158. 🏢 — a desk action; kept here rather than in trifid-adminapp
// since it operates on M5's own pool entities. See pool.service.ts's
// resolvePoolShortfall doc comment for why this is on-demand, not scheduled.
export async function postResolveShortfall(req, res) {
    const input = resolvePoolShortfallSchema.parse(req.body);
    const result = await poolService.resolvePoolShortfall(req.params.id, input.sellerWillShipLowerQty, {
        employeeId: req.auth.employeeId,
        correlationId: req.correlationId,
    });
    ok(res, req, result);
}
