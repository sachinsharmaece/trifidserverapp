import type { Request, Response } from 'express';
import * as poolService from './pool.service.js';
import { commitToPoolSchema, resolvePoolShortfallSchema } from './pool.validation.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

// API-060 — 👤B.
export async function getPools(req: Request, res: Response): Promise<void> {
  const { skuIds } = req.validatedQuery as { skuIds: string };
  const result = await poolService.getPoolsForProduct(skuIds.split(','));
  ok(res, req, result);
}
export async function getPool(req: Request, res: Response): Promise<void> {
  const result = await poolService.getPool(
    req.auth?.counterpartyId ?? null,
    req.params.id as string,
  );
  ok(res, req, result);
}

// API-061 — 👤B. Idempotency-Key required — may create a chain (post-trigger joiner).
export async function postCommit(req: Request, res: Response): Promise<void> {
  const input = commitToPoolSchema.parse(req.body);
  const result = await poolService.commitToPool(
    req.auth!.counterpartyId!,
    req.params.id as string,
    input,
  );
  ok(res, req, result, 201);
}

// API-062 — 👤B.
export async function postReconfirm(req: Request, res: Response): Promise<void> {
  await poolService.reconfirmPool(req.auth!.counterpartyId!, req.params.id as string);
  ok(res, req, { reconfirmed: true });
}
export async function postWithdraw(req: Request, res: Response): Promise<void> {
  await poolService.withdrawFromPool(req.auth!.counterpartyId!, req.params.id as string);
  ok(res, req, { withdrawn: true });
}

// API-063 — 👤S. Idempotency-Key required — creates a chain per binding buyer.
export async function postTriggerEarly(req: Request, res: Response): Promise<void> {
  await poolService.triggerPoolEarly(req.auth!.counterpartyId!, req.params.id as string);
  ok(res, req, { triggered: true });
}

// New — BR-158. 🏢 — a desk action; kept here rather than in trifid-adminapp
// since it operates on M5's own pool entities. See pool.service.ts's
// resolvePoolShortfall doc comment for why this is on-demand, not scheduled.
export async function postResolveShortfall(req: Request, res: Response): Promise<void> {
  const input = resolvePoolShortfallSchema.parse(req.body);
  const result = await poolService.resolvePoolShortfall(
    req.params.id as string,
    input.sellerWillShipLowerQty,
    {
      employeeId: req.auth!.employeeId!,
      correlationId: req.correlationId,
    },
  );
  ok(res, req, result);
}
