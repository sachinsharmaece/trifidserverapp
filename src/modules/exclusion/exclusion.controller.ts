import type { Request, Response } from 'express';
import { AppError } from '../../shared/errors.js';
import * as exclusionService from './exclusion.service.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

function requireSellerCounterpartyId(req: Request): string {
  const counterpartyId = req.auth?.counterpartyId;
  if (req.auth?.actorType !== 'counterparty' || !counterpartyId) {
    throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Sellers only.' });
  }
  return counterpartyId;
}

export async function postLookup(req: Request, res: Response): Promise<void> {
  const { gstin } = req.body as { gstin: string };
  const result = await exclusionService.lookupGstin(
    gstin,
    requireSellerCounterpartyId(req),
    req.ip ?? 'unknown',
  );
  ok(res, req, result);
}

export async function getExclusions(req: Request, res: Response): Promise<void> {
  const result = await exclusionService.listExclusions(requireSellerCounterpartyId(req));
  ok(res, req, result);
}

export async function postExclusion(req: Request, res: Response): Promise<void> {
  const { gstin } = req.body as { gstin: string };
  const result = await exclusionService.createExclusion(requireSellerCounterpartyId(req), gstin);
  ok(res, req, result, 201);
}

export async function deleteExclusion(req: Request, res: Response): Promise<void> {
  await exclusionService.removeExclusion(requireSellerCounterpartyId(req), req.params.id as string);
  ok(res, req, { removed: true });
}
