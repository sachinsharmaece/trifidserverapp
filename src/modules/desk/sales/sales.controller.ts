import type { Request, Response } from 'express';
import * as salesService from './sales.service.js';
import { requestMspSchema, respondToMspSchema } from './sales.validation.js';

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
  const destination = req.query.destination as 'purchase' | 'sales' | 'logistics' | undefined;
  ok(res, req, await salesService.getComplaintQueue(destination));
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
