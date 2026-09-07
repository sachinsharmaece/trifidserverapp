import type { Request, Response } from 'express';
import { AppError } from '../../shared/errors.js';
import * as territoryService from './territory.service.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

export async function getTehsils(req: Request, res: Response): Promise<void> {
  const { district } = req.validatedQuery as { district?: string };
  const tehsils = await territoryService.listTehsils(district);
  ok(res, req, tehsils);
}

export async function postTehsil(req: Request, res: Response): Promise<void> {
  const { name, district, state } = req.body as { name: string; district: string; state: string };
  const result = await territoryService.createTehsil(name, district, state);
  ok(res, req, result, 201);
}

export async function getMyArea(req: Request, res: Response): Promise<void> {
  const counterpartyId = req.auth?.counterpartyId;
  if (req.auth?.actorType !== 'counterparty' || !counterpartyId) {
    throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Sellers only.' });
  }
  const result = await territoryService.getOwnArea(counterpartyId);
  ok(res, req, result);
}
