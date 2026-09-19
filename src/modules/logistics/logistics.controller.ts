import type { Request, Response } from 'express';
import * as logisticsService from './logistics.service.js';
import { createTransporterSchema, createConsolidationSchema } from './logistics.validation.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

function actorOf(req: Request): { employeeId: string; correlationId: string } {
  return { employeeId: req.auth!.employeeId!, correlationId: req.correlationId! };
}

export async function postTransporter(req: Request, res: Response): Promise<void> {
  const input = createTransporterSchema.parse(req.body);
  ok(res, req, await logisticsService.createTransporter(input, actorOf(req)), 201);
}

export async function getTransporters(req: Request, res: Response): Promise<void> {
  const activeOnly = req.query.all !== 'true';
  ok(res, req, await logisticsService.listTransporters(activeOnly));
}

export async function postGoodsIn(req: Request, res: Response): Promise<void> {
  ok(res, req, await logisticsService.recordGoodsIn(req.params.poId as string, actorOf(req)), 201);
}

export async function getHubPosition(req: Request, res: Response): Promise<void> {
  ok(res, req, await logisticsService.getHubPosition());
}

export async function postConsolidation(req: Request, res: Response): Promise<void> {
  const input = createConsolidationSchema.parse(req.body);
  ok(res, req, await logisticsService.createConsolidation(input.movementIds, actorOf(req)), 201);
}

export async function postArrangeReturnCollection(req: Request, res: Response): Promise<void> {
  ok(
    res,
    req,
    await logisticsService.arrangeReturnCollection(req.params.returnNoteId as string, actorOf(req)),
    201,
  );
}

export async function postCloseReturnNote(req: Request, res: Response): Promise<void> {
  ok(
    res,
    req,
    await logisticsService.closeReturnNote(req.params.returnNoteId as string, actorOf(req)),
    201,
  );
}

export async function getDashboard(req: Request, res: Response): Promise<void> {
  ok(res, req, await logisticsService.getDashboard());
}
