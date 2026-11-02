import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { param, requireInScope } from '../../shared/scope.js';
import * as pushService from './push.service.js';
import { approvePushSchema, completePushSchema, createPushSchema, listPushesQuerySchema, rejectPushSchema, } from './push.validation.js';
export const pushRouter = Router();
// Phase 6 — Push to Purchase. Sales routes need the Sales "register a buyer"
// right, Purchase routes the Purchase "add a seller" right (a Sales Leader
// holds both through his Purchase Exec position); the service then decides
// by team. Every POST needs an Idempotency-Key.
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
const sales = [authenticate, requirePermission(PERMISSIONS.ONBOARDING_STAFF_ASSIST_BUYER)];
const purchase = [authenticate, requirePermission(PERMISSIONS.ONBOARDING_STAFF_ASSIST_SELLER)];
pushRouter.get('/staff/buyers/:buyerId/push', ...sales, requireInScope('sales', param('buyerId')), async (req, res) => {
    ok(res, req, await pushService.getPushStatus(req.params.buyerId, actorOf(req)));
});
pushRouter.post('/staff/buyers/:buyerId/push', ...sales, requireInScope('sales', param('buyerId')), requireIdempotencyKey(), validateBody(createPushSchema), async (req, res) => {
    const input = req.body;
    ok(res, req, await pushService.createPush(req.params.buyerId, input, actorOf(req)), 201);
});
pushRouter.get('/staff/sales/pushes', ...sales, async (req, res) => {
    ok(res, req, await pushService.listSalesPushes(actorOf(req)));
});
pushRouter.get('/staff/purchase/pushes', ...purchase, validateQuery(listPushesQuerySchema), async (req, res) => {
    const query = req.validatedQuery;
    ok(res, req, await pushService.listPurchasePushes(actorOf(req), query));
});
pushRouter.get('/staff/purchase/pushes/:pushId', ...purchase, async (req, res) => {
    ok(res, req, await pushService.getPush(req.params.pushId, actorOf(req)));
});
pushRouter.post('/staff/purchase/pushes/:pushId/complete', ...purchase, requireIdempotencyKey(), validateBody(completePushSchema), async (req, res) => {
    const input = req.body;
    ok(res, req, await pushService.completePush(req.params.pushId, input, actorOf(req)));
});
pushRouter.post('/staff/purchase/pushes/:pushId/approve', authenticate, requirePermission(PERMISSIONS.SELLER_APPROVE), requireIdempotencyKey(), validateBody(approvePushSchema), async (req, res) => {
    const input = req.body;
    ok(res, req, await pushService.approvePush(req.params.pushId, input, actorOf(req)));
});
pushRouter.post('/staff/purchase/pushes/:pushId/reject', authenticate, requirePermission(PERMISSIONS.SELLER_APPROVE), requireIdempotencyKey(), validateBody(rejectPushSchema), async (req, res) => {
    const { reason } = req.body;
    await pushService.rejectPush(req.params.pushId, reason, actorOf(req));
    ok(res, req, { rejected: true });
});
