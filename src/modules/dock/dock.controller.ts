import type { Request, Response } from 'express';
import * as dockService from './dock.service.js';
import { recordInspectionSchema } from './dock.validation.js';

function staffActor(req: Request): { employeeId: string; correlationId: string } {
  return { employeeId: req.auth!.employeeId!, correlationId: req.correlationId };
}

// API-087 — 🏢 dock:inspect (Transport & Logistics).
export async function postInspection(req: Request, res: Response): Promise<void> {
  const input = recordInspectionSchema.parse(req.body);
  const result = await dockService.recordInspection(
    req.params.poId as string,
    input,
    staffActor(req),
  );
  res.status(201).json({ data: result, meta: { correlationId: req.correlationId } });
}

// New — BR-190's Purchase half. 🏢 po:edit (Purchase).
export async function postApplyInspection(req: Request, res: Response): Promise<void> {
  const result = await dockService.applyInspection(req.params.poId as string, staffActor(req));
  res.status(200).json({ data: result, meta: { correlationId: req.correlationId } });
}
