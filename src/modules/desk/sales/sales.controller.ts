import type { Request, Response } from 'express';
import * as salesService from './sales.service.js';
import type { ComplaintDestination } from './sales.service.js';
import * as salesCallsService from './sales.calls.js';
import * as salesBoardService from './sales.board.js';
import * as salesPoolsService from './sales.pools.js';
import * as salesBuyersService from './sales.buyers.js';
import * as salesOrdersService from './sales.orders.js';
import * as salesFunnelService from './sales.funnel.js';
import { requestMspSchema, respondToMspSchema, createCallLogSchema } from './sales.validation.js';
import type { RateTier } from '../../pricing/pricing.service.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
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
  const q = req.query.q as string | undefined;
  const tab = req.query.tab as 'book' | 'queue' | undefined;
  ok(res, req, await salesBuyersService.listBuyers({ q, tab }));
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
