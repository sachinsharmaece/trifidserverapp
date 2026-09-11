import type { Request, Response } from 'express';
import * as chainService from './chain.service.js';
import { createSoSchema, editPoSchema, reduceSoQuantitySchema } from './chain.validation.js';

function staffActor(req: Request): { employeeId: string; correlationId: string } {
  return { employeeId: req.auth!.employeeId!, correlationId: req.correlationId };
}

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

// New — 🏢 so:create (Sales). BR-048 — staff price with pre-fill and override.
export async function postCreateSo(req: Request, res: Response): Promise<void> {
  const input = createSoSchema.parse(req.body);
  const result = await chainService.createSo(input, staffActor(req));
  ok(res, req, result, 201);
}

// API-084 — 🏢 po:create (Purchase). 409 unless the SO is paid in full (INV-01).
export async function postCreatePo(req: Request, res: Response): Promise<void> {
  const result = await chainService.createPo(req.params.soId as string, staffActor(req));
  ok(res, req, result, 201);
}

// New — 🏢 po:edit (Purchase). BR-036 — only rate or qty, never after billing.
export async function postEditPo(req: Request, res: Response): Promise<void> {
  const input = editPoSchema.parse(req.body);
  await chainService.editPo(req.params.poId as string, input, staffActor(req));
  ok(res, req, { edited: true });
}

// New — 🏢 so:reduce_quantity (Sales). Q6.
export async function postReduceSoQuantity(req: Request, res: Response): Promise<void> {
  const input = reduceSoQuantitySchema.parse(req.body);
  const result = await chainService.reduceSoQuantity(
    req.params.soId as string,
    input,
    staffActor(req),
  );
  ok(res, req, result);
}

// API-090 — 🏢/🎛 chain:read. BR-031/BR-037 — the chain strip and full document view.
export async function getChain(req: Request, res: Response): Promise<void> {
  const result = await chainService.getChainView(req.params.id as string);
  ok(res, req, result);
}
