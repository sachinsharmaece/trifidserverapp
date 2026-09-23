import type { Request, Response } from 'express';
import { Counterparty } from '../../models/Counterparty.js';
import { AppError } from '../../shared/errors.js';
import * as onboardingService from './onboarding.service.js';
import { approveBuyerSchema, approveSellerSchema } from './onboarding.validation.js';
import type {
  staffRegisterBuyerSchema,
  staffRegisterSellerSchema,
} from './onboarding.validation.js';
import type { z } from 'zod';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

export async function postRegisterBuyer(req: Request, res: Response): Promise<void> {
  const result = await onboardingService.registerBuyer(req.body);
  ok(res, req, result, 201);
}

export async function postRegisterSeller(req: Request, res: Response): Promise<void> {
  const result = await onboardingService.registerSeller(req.body);
  ok(res, req, result, 201);
}

// Staff-assisted enquiries — Sales raises a buyer registration on a phone
// call. Body validated by staffRegisterBuyerSchema (validateBody middleware
// on the route); calls the exact same registerBuyer used by API-010, plus
// the mandatory call note.
export async function postStaffRegisterBuyer(req: Request, res: Response): Promise<void> {
  const { callNote, ...input } = req.body as z.infer<typeof staffRegisterBuyerSchema>;
  const result = await onboardingService.registerBuyer(input, {
    employeeId: req.auth!.employeeId!,
    callNote,
    correlationId: req.correlationId,
  });
  ok(res, req, result, 201);
}

export async function postStaffRegisterSeller(req: Request, res: Response): Promise<void> {
  const { callNote, ...input } = req.body as z.infer<typeof staffRegisterSellerSchema>;
  const result = await onboardingService.registerSeller(input, {
    employeeId: req.auth!.employeeId!,
    callNote,
    correlationId: req.correlationId,
  });
  ok(res, req, result, 201);
}

export async function getRegistration(req: Request, res: Response): Promise<void> {
  const requesterCounterpartyId =
    req.auth?.actorType === 'counterparty' ? req.auth.counterpartyId : undefined;
  const result = await onboardingService.getRegistration(
    req.params.id as string,
    requesterCounterpartyId,
  );
  ok(res, req, result);
}

export async function getRegistrations(req: Request, res: Response): Promise<void> {
  const { stage, cursor, limit } = req.validatedQuery as {
    stage?: string;
    cursor?: string;
    limit?: number;
  };
  const result = await onboardingService.listRegistrations(stage, cursor, limit ?? 25);
  res.status(200).json({
    data: result.items,
    meta: { correlationId: req.correlationId, nextCursor: result.nextCursor },
  });
}

// API-014 — the request body shape depends on whether the registration is a
// buyer or a seller, so this route validates against the matching schema
// itself rather than through the usual validateBody middleware.
export async function postApprove(req: Request, res: Response): Promise<void> {
  const registrationId = req.params.id as string;
  const counterparty = await Counterparty.findById(registrationId);
  if (!counterparty) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Registration not found.' });
  }

  const actor = { employeeId: req.auth!.employeeId!, correlationId: req.correlationId };

  if (counterparty.kind === 'seller') {
    const input = approveSellerSchema.parse(req.body);
    await onboardingService.approveSeller(registrationId, input, actor);
  } else {
    const input = approveBuyerSchema.parse(req.body);
    await onboardingService.approveBuyer(registrationId, input, actor);
  }

  ok(res, req, { approved: true });
}

export async function postReject(req: Request, res: Response): Promise<void> {
  const { reason } = req.body as { reason: string };
  await onboardingService.rejectRegistration(req.params.id as string, reason, {
    employeeId: req.auth!.employeeId!,
    correlationId: req.correlationId,
  });
  ok(res, req, { rejected: true });
}

export async function getBankDetail(req: Request, res: Response): Promise<void> {
  const result = await onboardingService.getBankDetail(req.params.id as string);
  ok(res, req, result);
}

export async function postBankDetailChange(req: Request, res: Response): Promise<void> {
  const result = await onboardingService.changeBankDetail(
    req.params.id as string,
    req.body as { accountNumber: string; ifsc: string; accountName: string },
    { employeeId: req.auth!.employeeId!, correlationId: req.correlationId },
  );
  ok(res, req, result, 201);
}

export async function postBankDetailCallback(req: Request, res: Response): Promise<void> {
  const result = await onboardingService.logBankDetailCallback(req.params.bankDetailId as string, {
    employeeId: req.auth!.employeeId!,
    correlationId: req.correlationId,
  });
  ok(res, req, result);
}
