import type { Request, Response } from 'express';
import * as movementService from './movement.service.js';
import { recordMovementSchema } from './movement.validation.js';
import { assertValidObjectId } from '../../shared/objectId.js';

// API-089 — 🏢 movement:write (Transport & Logistics).
export async function postMovement(req: Request, res: Response): Promise<void> {
  const chainId = req.params.chainId as string;
  assertValidObjectId(chainId, 'chainId'); // B-56 — was an uncaught CastError (bare 500).
  const input = recordMovementSchema.parse(req.body);
  const result = await movementService.recordMovement(chainId, input, {
    employeeId: req.auth!.employeeId!,
    correlationId: req.correlationId,
  });
  res.status(201).json({ data: result, meta: { correlationId: req.correlationId } });
}
