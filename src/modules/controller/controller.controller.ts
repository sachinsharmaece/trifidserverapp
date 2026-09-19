import type { Request, Response } from 'express';
import * as controllerService from './controller.service.js';
import { decideDisputeSchema, bulkLifelineSchema } from './controller.validation.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

export async function getDisputeQueue(req: Request, res: Response): Promise<void> {
  ok(res, req, await controllerService.getDisputeQueue());
}

export async function postDecideDispute(req: Request, res: Response): Promise<void> {
  const input = decideDisputeSchema.parse(req.body);
  const result = await controllerService.decideDispute(req.params.complaintId as string, input, {
    employeeId: req.auth!.employeeId!,
    correlationId: req.correlationId!,
  });
  ok(res, req, result, 201);
}

export async function getExceptionView(req: Request, res: Response): Promise<void> {
  ok(res, req, await controllerService.getExceptionView());
}

export async function postBulkLifeline(req: Request, res: Response): Promise<void> {
  const input = bulkLifelineSchema.parse(req.body);
  const result = await controllerService.grantBulkLifeline(input.extensionHours, input.reason, {
    employeeId: req.auth!.employeeId!,
    checkerEmployeeId: input.checkerEmployeeId,
    correlationId: req.correlationId!,
  });
  ok(res, req, result, 201);
}
