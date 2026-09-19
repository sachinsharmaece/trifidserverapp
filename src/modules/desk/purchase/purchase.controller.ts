import type { Request, Response } from 'express';
import * as purchaseService from './purchase.service.js';
import { nonOrderReasonSchema } from './purchase.validation.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

export async function getActiveDemandList(req: Request, res: Response): Promise<void> {
  const noSellerOnly = req.query.noSeller === 'true';
  ok(res, req, await purchaseService.getActiveDemandList({ noSellerOnly }));
}

export async function getQuoteGaps(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getQuoteGapsForAsk(req.params.askId as string));
}

export async function getCoverageMap(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getCoverageMap());
}

export async function getProductAnalysis(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getProductAnalysis(req.params.productId as string));
}

export async function getAbsorptionQueue(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getAbsorptionQueue());
}

export async function postNonOrderReason(req: Request, res: Response): Promise<void> {
  const input = nonOrderReasonSchema.parse(req.body);
  const result = await purchaseService.recordSupplyGapReason(input, {
    employeeId: req.auth!.employeeId!,
  });
  ok(res, req, result, 201);
}

export async function getReturnNoteAgeing(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getReturnNoteAgeing());
}

export async function getSellerRecoveryQueue(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getSellerRecoveryQueue());
}
