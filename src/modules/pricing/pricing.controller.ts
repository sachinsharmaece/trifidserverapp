import type { Request, Response } from 'express';
import * as pricingService from './pricing.service.js';
import { setMarginMatrixBulkSchema, setMarginMatrixCellSchema } from './pricing.validation.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

export async function getMarginMatrix(req: Request, res: Response): Promise<void> {
  const result = await pricingService.getCurrentMarginMatrix();
  ok(res, req, result);
}

export async function putMarginMatrix(req: Request, res: Response): Promise<void> {
  const input = setMarginMatrixCellSchema.parse(req.body);
  const result = await pricingService.setMarginMatrixCell(input, {
    employeeId: req.auth!.employeeId!,
  });
  ok(res, req, result, 201);
}

export async function putMarginMatrixBulk(req: Request, res: Response): Promise<void> {
  const input = setMarginMatrixBulkSchema.parse(req.body);
  const result = await pricingService.setMarginMatrixBulk(input, {
    employeeId: req.auth!.employeeId!,
  });
  ok(res, req, result, 201);
}

export async function getMarginMatrixHistory(req: Request, res: Response): Promise<void> {
  const result = await pricingService.getMarginMatrixHistory();
  ok(res, req, result);
}
