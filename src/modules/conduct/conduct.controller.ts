import type { Request, Response } from 'express';
import * as conductService from './conduct.service.js';
import { disagreeSchema } from './conduct.validation.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

// API-110 GET — 👤B.
export async function getConduct(req: Request, res: Response): Promise<void> {
  ok(res, req, await conductService.getBuyerConduct(req.auth!.counterpartyId!));
}

// API-110 POST disagree — 👤B.
export async function postDisagree(req: Request, res: Response): Promise<void> {
  const { reason } = disagreeSchema.parse(req.body);
  const result = await conductService.disagreeWithConduct(
    req.auth!.counterpartyId!,
    req.params.id as string,
    reason,
    req.correlationId,
  );
  ok(res, req, result, 201);
}

// API-111 — 👤S.
export async function getScorecard(req: Request, res: Response): Promise<void> {
  ok(res, req, await conductService.getSellerScorecard(req.auth!.counterpartyId!));
}
