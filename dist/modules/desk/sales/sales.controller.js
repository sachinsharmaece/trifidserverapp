import { listAssignableSalesPeople } from '../../../shared/team.js';
import * as salesService from './sales.service.js';
import * as salesCallsService from './sales.calls.js';
import * as salesBoardService from './sales.board.js';
import * as salesPoolsService from './sales.pools.js';
import * as salesBuyersService from './sales.buyers.js';
import * as salesOrdersService from './sales.orders.js';
import * as salesFunnelService from './sales.funnel.js';
import * as salesFunnelDrillService from './sales.funnelDrill.js';
import * as salesStageService from './sales.stageActions.js';
import { requestMspSchema, respondToMspSchema, createCallLogSchema, giveRateSchema, giveParkedQuoteSchema, markPaidSchema, cancelOrderSchema, markBilledSchema, dispatchOrderSchema, markDeliveredSchema, skipToBilledSchema, } from './sales.validation.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
function stageActor(req) {
    return { employeeId: req.auth.employeeId, correlationId: req.correlationId };
}
// Buyer file stage buttons.
export async function postGiveRate(req, res) {
    const { listingLineId, callNote } = giveRateSchema.parse(req.body);
    const result = await salesStageService.giveRateOnAsk(req.params.askId, { listingLineId }, stageActor(req), callNote);
    ok(res, req, result, 201);
}
export async function postGiveParkedQuote(req, res) {
    const { callNote } = giveParkedQuoteSchema.parse(req.body);
    const result = await salesStageService.giveParkedQuote(req.params.quoteId, stageActor(req), callNote);
    ok(res, req, result, 201);
}
export async function postMarkPaid(req, res) {
    const { utr, callNote } = markPaidSchema.parse(req.body);
    const result = await salesStageService.markOrderPaid(req.params.soId, { utr }, stageActor(req), callNote);
    ok(res, req, result, 201);
}
export async function postMarkBilled(req, res) {
    const { callNote, ...input } = markBilledSchema.parse(req.body);
    const result = await salesStageService.markOrderBilled(req.params.soId, input, stageActor(req), callNote);
    ok(res, req, result, 201);
}
export async function postSkipToBilled(req, res) {
    const { callNote, ...input } = skipToBilledSchema.parse(req.body);
    const result = await salesStageService.skipToBilled(req.params.soId, input, stageActor(req), callNote);
    ok(res, req, result, 201);
}
export async function postDispatchOrder(req, res) {
    const { callNote, ...input } = dispatchOrderSchema.parse(req.body);
    const result = await salesStageService.dispatchOrder(req.params.soId, input, stageActor(req), callNote);
    ok(res, req, result, 201);
}
export async function postMarkDelivered(req, res) {
    const { callNote } = markDeliveredSchema.parse(req.body);
    ok(res, req, await salesStageService.markOrderDelivered(req.params.soId, stageActor(req), callNote));
}
export async function postCancelOrder(req, res) {
    const { callNote } = cancelOrderSchema.parse(req.body);
    ok(res, req, await salesStageService.cancelOrder(req.params.soId, stageActor(req), callNote));
}
export async function getWorklist(req, res) {
    ok(res, req, await salesService.getSalesWorklist());
}
export async function getMarketPulse(req, res) {
    ok(res, req, await salesService.getMarketPulse());
}
export async function getRetention(req, res) {
    ok(res, req, await salesService.getRetentionCohorts());
}
export async function getComplaintQueue(req, res) {
    const destination = req.query.destination;
    ok(res, req, await salesService.getComplaintQueue(destination));
}
// Sales desk v2 — calls.
export async function postCallLog(req, res) {
    const input = createCallLogSchema.parse(req.body);
    const result = await salesCallsService.createCallLog(input, {
        employeeId: req.auth.employeeId,
        correlationId: req.correlationId,
    });
    ok(res, req, result, 201);
}
export async function getCallLogs(req, res) {
    const buyerId = req.query.buyerId;
    if (!buyerId) {
        ok(res, req, []);
        return;
    }
    ok(res, req, await salesCallsService.listCallLogsForBuyer(buyerId));
}
export async function getPromises(req, res) {
    ok(res, req, await salesCallsService.listDuePromises());
}
// Sales desk v2 — board (rate ladder).
export async function getBoard(req, res) {
    ok(res, req, await salesBoardService.getBoardProducts());
}
export async function getBoardProduct(req, res) {
    const tier = req.query.tier;
    const buyerId = req.query.buyerId;
    ok(res, req, await salesBoardService.getBoardProduct(req.params.productId, { tier, buyerId }));
}
// Sales desk v2 — pools.
export async function getPools(req, res) {
    ok(res, req, await salesPoolsService.getPools());
}
export async function getPool(req, res) {
    ok(res, req, await salesPoolsService.getPool(req.params.poolId));
}
// Sales desk v2 — buyers.
export async function getBuyers(req, res) {
    const str = (key) => typeof req.query[key] === 'string' && req.query[key] ? req.query[key] : undefined;
    const tab = str('tab');
    ok(res, req, await salesBuyersService.listBuyers({
        q: str('q'),
        tab,
        category: str('category'),
        districtId: str('districtId'),
        assignedTo: str('assignedTo'),
    }));
}
export async function getBuyerBoard(req, res) {
    ok(res, req, await salesBoardService.getBoardForBuyer(req.params.buyerId));
}
export async function getBuyerFile(req, res) {
    ok(res, req, await salesBuyersService.getBuyerFile(req.params.buyerId));
}
// Sales desk v2 — orders.
export async function getOrders(req, res) {
    const tab = req.query.tab;
    ok(res, req, await salesOrdersService.listOrders({ tab }));
}
// Sales desk v2 — funnel.
export async function getFunnel(req, res) {
    ok(res, req, await salesFunnelService.getSalesFunnelReport());
}
export async function getFunnelAsks(req, res) {
    ok(res, req, await salesFunnelDrillService.listFunnelAsks());
}
export async function getFunnelHeldRates(req, res) {
    ok(res, req, await salesFunnelDrillService.listFunnelHeldRates());
}
// 👤B.
export async function postMspRequest(req, res) {
    const input = requestMspSchema.parse(req.body);
    const result = await salesService.requestMsp(req.auth.counterpartyId, input);
    ok(res, req, result, 201);
}
export async function getMyMspRequests(req, res) {
    ok(res, req, await salesService.listMyMspRequests(req.auth.counterpartyId));
}
// 🏢 Sales.
export async function getMspQueue(req, res) {
    ok(res, req, await salesService.getMspQueue());
}
export async function postMspResponse(req, res) {
    const input = respondToMspSchema.parse(req.body);
    await salesService.respondToMsp(req.params.id, input, {
        employeeId: req.auth.employeeId,
        correlationId: req.correlationId,
    });
    ok(res, req, { done: true });
}
export async function getAssignees(req, res) {
    ok(res, req, await listAssignableSalesPeople({
        employeeId: req.auth.employeeId,
        permissions: req.auth.permissions,
    }));
}
