import type { Request, Response } from 'express';
import * as adminService from './admin.service.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

export async function getConfig(req: Request, res: Response): Promise<void> {
  const entries = await adminService.listConfig();
  ok(res, req, entries);
}

export async function putConfig(req: Request, res: Response): Promise<void> {
  const { value } = req.body as { value: unknown };
  const result = await adminService.updateConfig(req.params.key as string, value, {
    employeeId: req.auth!.employeeId!,
    correlationId: req.correlationId,
  });
  ok(res, req, result);
}

export async function postEmployee(req: Request, res: Response): Promise<void> {
  const result = await adminService.createEmployee(
    req.body as {
      person: string;
      email: string;
      password: string;
      desk?: string;
      roleKeys: string[];
    },
    { employeeId: req.auth!.employeeId!, correlationId: req.correlationId },
  );
  ok(res, req, result, 201);
}

export async function getEmployees(req: Request, res: Response): Promise<void> {
  const { cursor, limit } = req.validatedQuery as { cursor?: string; limit?: number };
  const result = await adminService.listEmployees(cursor, limit ?? 25);
  res.status(200).json({
    data: result.items,
    meta: { correlationId: req.correlationId, nextCursor: result.nextCursor },
  });
}
