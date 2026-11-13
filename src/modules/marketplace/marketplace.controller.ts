import type { Request, Response } from 'express';
import * as marketplaceService from './marketplace.service.js';
import {
  restartListingSchema,
  stopListingSchema,
  withdrawQuoteSchema,
} from './marketplace.validation.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

function callerOf(req: Request): marketplaceService.StopCaller {
  return {
    employeeId: req.auth!.employeeId!,
    permissions: req.auth!.permissions,
    correlationId: req.correlationId,
  };
}

// RECTIFY-01 Phase 0 — 🏢 Purchase Leader / Admin. Preview first, then the same call with confirm.
export async function postStopListing(req: Request, res: Response): Promise<void> {
  const input = stopListingSchema.parse(req.body);
  ok(res, req, await marketplaceService.stopListing(req.params.id as string, input, callerOf(req)));
}

export async function postRestartListing(req: Request, res: Response): Promise<void> {
  const input = restartListingSchema.parse(req.body ?? {});
  ok(
    res,
    req,
    await marketplaceService.restartListing(req.params.id as string, input, callerOf(req)),
  );
}

export async function postWithdrawQuote(req: Request, res: Response): Promise<void> {
  const input = withdrawQuoteSchema.parse(req.body);
  ok(
    res,
    req,
    await marketplaceService.withdrawQuote(req.params.id as string, input, callerOf(req)),
  );
}
