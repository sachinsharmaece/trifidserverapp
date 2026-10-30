import type { Request, Response } from 'express';
import * as leadService from './lead.service.js';
import type { ChangeOwnerInput, LeadLookupQuery } from './lead.validation.js';

function actorOf(req: Request): leadService.Actor {
  return {
    employeeId: req.auth!.employeeId!,
    permissions: req.auth!.permissions,
    correlationId: req.correlationId,
  };
}

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

export async function getLookup(req: Request, res: Response): Promise<void> {
  ok(res, req, await leadService.lookupLead(req.validatedQuery as LeadLookupQuery, actorOf(req)));
}

export async function postBuyerOwner(req: Request, res: Response): Promise<void> {
  const input = req.body as ChangeOwnerInput;
  ok(
    res,
    req,
    await leadService.changeOwner('sales', req.params.buyerId as string, input, actorOf(req)),
  );
}

export async function postSellerOwner(req: Request, res: Response): Promise<void> {
  const input = req.body as ChangeOwnerInput;
  ok(
    res,
    req,
    await leadService.changeOwner('purchase', req.params.sellerId as string, input, actorOf(req)),
  );
}
