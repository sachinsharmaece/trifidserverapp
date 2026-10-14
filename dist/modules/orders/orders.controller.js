import * as ordersService from './orders.service.js';
import { dispatchLeg1Schema, extensionRequestSchema, postComplaintSchema, } from './orders.validation.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
// API-070 — 👤B.
export async function getMyOrders(req, res) {
    ok(res, req, await ordersService.listBuyerOrders(req.auth.counterpartyId));
}
export async function getMyOrder(req, res) {
    ok(res, req, await ordersService.getBuyerOrder(req.auth.counterpartyId, req.params.id));
}
// API-070 — 👤S.
export async function getMySellerOrders(req, res) {
    ok(res, req, await ordersService.listSellerOrders(req.auth.counterpartyId));
}
export async function getMySellerOrder(req, res) {
    ok(res, req, await ordersService.getSellerOrder(req.auth.counterpartyId, req.params.id));
}
// API-075 — 👤S. Idempotency-Key required — moves the chain to stage leg1.
export async function postDispatch(req, res) {
    const input = dispatchLeg1Schema.parse(req.body);
    const result = await ordersService.postDispatchLeg1(req.auth.counterpartyId, req.params.id, input, { correlationId: req.correlationId });
    ok(res, req, result, 201);
}
// API-076 — 👤S.
export async function postExtensionRequest(req, res) {
    const { reason } = extensionRequestSchema.parse(req.body);
    const result = await ordersService.postExtensionRequest(req.auth.counterpartyId, req.params.id, reason);
    ok(res, req, result);
}
// API-073 — 👤B.
export async function postConfirmReceipt(req, res) {
    const result = await ordersService.confirmReceipt(req.auth.counterpartyId, req.params.id);
    ok(res, req, result);
}
// API-074 — 👤B.
export async function postComplaint(req, res) {
    const input = postComplaintSchema.parse(req.body);
    const result = await ordersService.postComplaint(req.auth.counterpartyId, req.params.id, input);
    ok(res, req, result, 201);
}
export async function getComplaints(req, res) {
    const result = await ordersService.getComplaints(req.auth.counterpartyId, req.params.id);
    ok(res, req, result);
}
// New — 👤B. See orders.service.ts's own comment.
export async function getMyRefunds(req, res) {
    ok(res, req, await ordersService.listBuyerRefunds(req.auth.counterpartyId));
}
// API-071 (repurposed, QR-045) — 👤B. WF-11's promoted-fallback screen (IC-14).
export async function getPromotionOffer(req, res) {
    ok(res, req, await ordersService.getPromotionOffer(req.auth.counterpartyId, req.params.id));
}
export async function postAcceptPromotion(req, res) {
    await ordersService.acceptPromotion(req.auth.counterpartyId, req.params.id, req.correlationId);
    ok(res, req, { accepted: true });
}
export async function postRejectPromotion(req, res) {
    await ordersService.rejectPromotion(req.auth.counterpartyId, req.params.id);
    ok(res, req, { rejected: true });
}
// API-077 — 👤B / 👤S — ownership resolved server-side, see orders.service.ts.
export async function getDocuments(req, res) {
    const result = await ordersService.getOrderDocuments(req.auth.counterpartyId, req.params.id);
    ok(res, req, result);
}
