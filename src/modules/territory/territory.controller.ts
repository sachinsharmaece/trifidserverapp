import type { Request, Response } from 'express';
import { AppError } from '../../shared/errors.js';
import * as territoryService from './territory.service.js';
import * as masters from './territory.masters.js';
import { pincodeParamSchema } from './territory.validation.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

function staffActor(req: Request): masters.MasterActor {
  return { employeeId: req.auth!.employeeId!, correlationId: req.correlationId };
}

function pincodeParam(req: Request): string {
  const parsed = pincodeParamSchema.safeParse(req.params.pincode);
  if (!parsed.success) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Enter a 6-digit pincode that does not start with 0.',
      field: 'pincode',
    });
  }
  return parsed.data;
}

// --- States / districts ---------------------------------------------------

export async function getStates(req: Request, res: Response): Promise<void> {
  ok(res, req, await masters.listStates());
}

export async function postState(req: Request, res: Response): Promise<void> {
  const body = req.body as { name: string; gstStateCode: string };
  ok(res, req, await masters.createState(body, staffActor(req)), 201);
}

export async function getDistricts(req: Request, res: Response): Promise<void> {
  const { stateId } = req.validatedQuery as { stateId?: string };
  ok(res, req, await masters.listDistricts(stateId));
}

export async function postDistrict(req: Request, res: Response): Promise<void> {
  const body = req.body as { name: string; stateId: string };
  ok(res, req, await masters.createDistrict(body, staffActor(req)), 201);
}

// --- Tehsils --------------------------------------------------------------

export async function getTehsils(req: Request, res: Response): Promise<void> {
  const query = req.validatedQuery as { district?: string; districtId?: string };
  ok(res, req, await masters.listTehsils(query));
}

export async function postTehsil(req: Request, res: Response): Promise<void> {
  const body = req.body as { name: string; districtId: string };
  ok(res, req, await masters.createTehsil(body, staffActor(req)), 201);
}

export async function patchTehsil(req: Request, res: Response): Promise<void> {
  const body = req.body as { name?: string; districtId?: string };
  ok(res, req, await masters.updateTehsil(req.params.id as string, body, staffActor(req)));
}

// --- Pincodes -------------------------------------------------------------

export async function getPincodes(req: Request, res: Response): Promise<void> {
  const query = req.validatedQuery as { status?: 'verified' | 'unverified' };
  ok(res, req, await masters.listPincodes(query));
}

/** A known pincode's place, or `null` — never a 404, so the form can tell "unknown" from "failed". */
export async function getPincode(req: Request, res: Response): Promise<void> {
  ok(res, req, await masters.lookupPincode(pincodeParam(req)));
}

export async function patchPincode(req: Request, res: Response): Promise<void> {
  const body = req.body as { tehsilId?: string; verify?: true };
  ok(res, req, await masters.updatePincode(pincodeParam(req), body, staffActor(req)));
}

// --- Seller's own area (API-027) ------------------------------------------

export async function getMyArea(req: Request, res: Response): Promise<void> {
  const counterpartyId = req.auth?.counterpartyId;
  if (req.auth?.actorType !== 'counterparty' || !counterpartyId) {
    throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Sellers only.' });
  }
  const result = await territoryService.getOwnArea(counterpartyId);
  ok(res, req, result);
}
