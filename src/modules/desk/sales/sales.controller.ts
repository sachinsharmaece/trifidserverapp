import { listAssignableSalesPeople } from '../../../shared/team.js';
import type { Request, Response } from 'express';
import * as salesService from './sales.service.js';
import type { ComplaintDestination } from './sales.service.js';
import * as salesCallsService from './sales.calls.js';
import * as salesBoardService from './sales.board.js';
import * as salesPoolsService from './sales.pools.js';
import * as salesBuyersService from './sales.buyers.js';
import * as salesOrdersService from './sales.orders.js';
import * as salesFunnelService from './sales.funnel.js';
import * as salesFunnelDrillService from './sales.funnelDrill.js';
import * as salesStageService from './sales.stageActions.js';
import {
  requestMspSchema,
  respondToMspSchema,
  createCallLogSchema,
  giveRateSchema,
  giveParkedQuoteSchema,
  markPaidSchema,
  cancelOrderSchema,
  markBilledSchema,
  dispatchOrderSchema,
  markDeliveredSchema,
  skipToBilledSchema,
} from './sales.validation.js';
import type { RateTier } from '../../pricing/pricing.service.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

function stageActor(req: Request): { employeeId: string; correlationId: string } {
  return { employeeId: req.auth!.employeeId!, correlationId: req.correlationId };
}

// Buyer file stage buttons.
export async function postGiveRate(req: Request, res: Response): Promise<void> {
  const { listingLineId, callNote } = giveRateSchema.parse(req.body);
  const result = await salesStageService.giveRateOnAsk(
    req.params.askId as string,
    { listingLineId },
    stageActor(req),
    callNote,
  );
  ok(res, req, result, 201);
}
export async function postGiveParkedQuote(req: Request, res: Response): Promise<void> {
  const { callNote } = giveParkedQuoteSchema.parse(req.body);
  const result = await salesStageService.giveParkedQuote(
    req.params.quoteId as string,
    stageActor(req),
    callNote,
  );
  ok(res, req, result, 201);
}
export async function postMarkPaid(req: Request, res: Response): Promise<void> {
  const { utr, callNote } = markPaidSchema.parse(req.body);
  const result = await salesStageService.markOrderPaid(
    req.params.soId as string,
    { utr },
    stageActor(req),
    callNote,
  );
  ok(res, req, result, 201);
}
export async function postMarkBilled(req: Request, res: Response): Promise<void> {
  const { callNote, ...input } = markBilledSchema.parse(req.body);
  const result = await salesStageService.markOrderBilled(
    req.params.soId as string,
    input,
    stageActor(req),
    callNote,
  );
  ok(res, req, result, 201);
}
export async function postSkipToBilled(req: Request, res: Response): Promise<void> {
  const { callNote, ...input } = skipToBilledSchema.parse(req.body);
  const result = await salesStageService.skipToBilled(
    req.params.soId as string,
    input,
    stageActor(req),
    callNote,
  );
  ok(res, req, result, 201);
}
export async function postDispatchOrder(req: Request, res: Response): Promise<void> {
  const { callNote, ...input } = dispatchOrderSchema.parse(req.body);
  const result = await salesStageService.dispatchOrder(
    req.params.soId as string,
    input,
    stageActor(req),
    callNote,
  );
  ok(res, req, result, 201);
}
export async function postMarkDelivered(req: Request, res: Response): Promise<void> {
  const { callNote } = markDeliveredSchema.parse(req.body);
  ok(
    res,
    req,
    await salesStageService.markOrderDelivered(
      req.params.soId as string,
      stageActor(req),
      callNote,
    ),
  );
}
export async function postCancelOrder(req: Request, res: Response): Promise<void> {
  const { callNote } = cancelOrderSchema.parse(req.body);
  ok(
    res,
    req,
    await salesStageService.cancelOrder(req.params.soId as string, stageActor(req), callNote),
  );
}

export async function getWorklist(req: Request, res: Response): Promise<void> {
  ok(res, req, await salesService.getSalesWorklist());
}

export async function getMarketPulse(req: Request, res: Response): Promise<void> {
  ok(res, req, await salesService.getMarketPulse());
}

export async function getRetention(req: Request, res: Response): Promise<void> {
  ok(res, req, await salesService.getRetentionCohorts());
}

export async function getComplaintQueue(req: Request, res: Response): Promise<void> {
  const destination = req.query.destination as ComplaintDestination | undefined;
  ok(res, req, await salesService.getComplaintQueue(destination));
}

// Sales desk v2 — calls.
export async function postCallLog(req: Request, res: Response): Promise<void> {
  const input = createCallLogSchema.parse(req.body);
  const result = await salesCallsService.createCallLog(input, {
    employeeId: req.auth!.employeeId!,
    correlationId: req.correlationId,
  });
  ok(res, req, result, 201);
}
export async function getCallLogs(req: Request, res: Response): Promise<void> {
  const buyerId = req.query.buyerId as string | undefined;
  if (!buyerId) {
    ok(res, req, []);
    return;
  }
  ok(res, req, await salesCallsService.listCallLogsForBuyer(buyerId));
}
export async function getPromises(req: Request, res: Response): Promise<void> {
  ok(res, req, await salesCallsService.listDuePromises());
}

// Sales desk v2 — board (rate ladder).
export async function getBoard(req: Request, res: Response): Promise<void> {
  ok(res, req, await salesBoardService.getBoardProducts());
}
export async function getBoardProduct(req: Request, res: Response): Promise<void> {
  const tier = req.query.tier as RateTier | undefined;
  const buyerId = req.query.buyerId as string | undefined;
  ok(
    res,
    req,
    await salesBoardService.getBoardProduct(req.params.productId as string, { tier, buyerId }),
  );
}

// Sales desk v2 — pools.
export async function getPools(req: Request, res: Response): Promise<void> {
  ok(res, req, await salesPoolsService.getPools());
}
export async function getPool(req: Request, res: Response): Promise<void> {
  ok(res, req, await salesPoolsService.getPool(req.params.poolId as string));
}

// Sales desk v2 — buyers.
export async function getBuyers(req: Request, res: Response): Promise<void> {
  const str = (key: string) =>
    typeof req.query[key] === 'string' && req.query[key] ? (req.query[key] as string) : undefined;
  const tab = str('tab') as 'book' | 'queue' | undefined;
  const filters = {
    q: str('q'),
    tab,
    category: str('category'),
    districtId: str('districtId'),
    assignedTo: str('assignedTo'),
    // 29 Oct — an unknown sort or direction falls back to firm A→Z rather than failing.
    sort: (salesBuyersService.BUYER_LIST_SORTS as readonly string[]).includes(str('sort') ?? '')
      ? (str('sort') as salesBuyersService.BuyerListSort)
      : undefined,
    dir: str('dir') === 'desc' ? ('desc' as const) : ('asc' as const),
  };
  // 29 Oct — with `limit`, one page (`cursor` is the offset) plus the total and
  // the tab's filter options; without it, the whole list as before.
  const limit = Number(str('limit'));
  if (!Number.isInteger(limit) || limit < 1) {
    ok(res, req, await salesBuyersService.listBuyers(filters));
    return;
  }
  const offset = Math.max(0, Number(str('cursor') ?? 0) || 0);
  const page = await salesBuyersService.listBuyersPage(filters, {
    offset,
    limit: Math.min(limit, 100),
  });
  const next = offset + Math.min(limit, 100);
  res.status(200).json({
    data: page.items,
    meta: {
      correlationId: req.correlationId,
      nextCursor: next < page.total ? String(next) : undefined,
      total: page.total,
      facets: page.facets,
    },
  });
}
export async function getBuyerBoard(req: Request, res: Response): Promise<void> {
  ok(res, req, await salesBoardService.getBoardForBuyer(req.params.buyerId as string));
}
export async function getBuyerFile(req: Request, res: Response): Promise<void> {
  ok(res, req, await salesBuyersService.getBuyerFile(req.params.buyerId as string));
}

// Sales desk v2 — orders.
export async function getOrders(req: Request, res: Response): Promise<void> {
  const tab = req.query.tab as 'live' | 'closed' | undefined;
  ok(res, req, await salesOrdersService.listOrders({ tab }));
}

// Sales desk v2 — funnel.
export async function getFunnel(req: Request, res: Response): Promise<void> {
  ok(res, req, await salesFunnelService.getSalesFunnelReport());
}
export async function getFunnelAsks(req: Request, res: Response): Promise<void> {
  ok(res, req, await salesFunnelDrillService.listFunnelAsks());
}
export async function getFunnelHeldRates(req: Request, res: Response): Promise<void> {
  ok(res, req, await salesFunnelDrillService.listFunnelHeldRates());
}

// 👤B.
export async function postMspRequest(req: Request, res: Response): Promise<void> {
  const input = requestMspSchema.parse(req.body);
  const result = await salesService.requestMsp(req.auth!.counterpartyId!, input);
  ok(res, req, result, 201);
}
export async function getMyMspRequests(req: Request, res: Response): Promise<void> {
  ok(res, req, await salesService.listMyMspRequests(req.auth!.counterpartyId!));
}

// 🏢 Sales.
export async function getMspQueue(req: Request, res: Response): Promise<void> {
  ok(res, req, await salesService.getMspQueue());
}
export async function postMspResponse(req: Request, res: Response): Promise<void> {
  const input = respondToMspSchema.parse(req.body);
  await salesService.respondToMsp(req.params.id as string, input, {
    employeeId: req.auth!.employeeId!,
    correlationId: req.correlationId,
  });
  ok(res, req, { done: true });
}

export async function getAssignees(req: Request, res: Response): Promise<void> {
  ok(
    res,
    req,
    await listAssignableSalesPeople({
      employeeId: req.auth!.employeeId!,
      permissions: req.auth!.permissions,
    }),
  );
}
