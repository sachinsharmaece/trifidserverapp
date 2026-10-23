import type { Request, Response } from 'express';
import * as adminService from './admin.service.js';
import * as team from './admin.team.js';

function actorOf(req: Request) {
  return { employeeId: req.auth!.employeeId!, correlationId: req.correlationId };
}

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
  const result = await team.createEmployee(
    req.body as Parameters<typeof team.createEmployee>[0],
    actorOf(req),
  );
  ok(res, req, result, 201);
}

export async function getEmployee(req: Request, res: Response): Promise<void> {
  ok(res, req, await team.getTeamMember(req.params.id as string));
}

export async function putEmployee(req: Request, res: Response): Promise<void> {
  const result = await team.updateEmployee(
    req.params.id as string,
    req.body as Parameters<typeof team.updateEmployee>[1],
    actorOf(req),
  );
  ok(res, req, result);
}

export async function getDeactivationImpact(req: Request, res: Response): Promise<void> {
  ok(res, req, await team.getDeactivationImpact(req.params.id as string));
}

export async function postDeactivate(req: Request, res: Response): Promise<void> {
  const body = req.body as { reassignToEmployeeId?: string; reason?: string };
  ok(res, req, await team.deactivateEmployee(req.params.id as string, body, actorOf(req)));
}

export async function postReactivate(req: Request, res: Response): Promise<void> {
  ok(res, req, await team.reactivateEmployee(req.params.id as string, actorOf(req)));
}

export async function postRevealPii(req: Request, res: Response): Promise<void> {
  const { field } = req.body as { field: 'pan' | 'aadhaar' };
  ok(res, req, await team.revealEmployeePii(req.params.id as string, field, actorOf(req)));
}

export async function postEmployeeMfa(req: Request, res: Response): Promise<void> {
  const result = await adminService.issueEmployeeMfa(req.params.id as string, {
    employeeId: req.auth!.employeeId!,
    correlationId: req.correlationId,
  });
  ok(res, req, result, 201);
}

export async function getLanes(req: Request, res: Response): Promise<void> {
  ok(res, req, await adminService.listLaneBoard());
}

export async function postBookAssignment(req: Request, res: Response): Promise<void> {
  const { buyerId, ownerEmployeeId, reason } = req.body as {
    buyerId: string;
    ownerEmployeeId: string;
    reason?: string;
  };
  const result = await adminService.assignBook(
    { buyerId, ownerEmployeeId, reason },
    {
      employeeId: req.auth!.employeeId!,
      permissions: req.auth!.permissions,
      correlationId: req.correlationId,
    },
  );
  ok(res, req, result, 201);
}

export async function postAbsence(req: Request, res: Response): Promise<void> {
  const { employeeId, from, returnDate, coveredBy } = req.body as {
    employeeId: string;
    from: Date;
    returnDate: Date;
    coveredBy: string;
  };
  const result = await adminService.createAbsence(
    { employeeId, from, returnDate, coveredBy },
    { employeeId: req.auth!.employeeId!, correlationId: req.correlationId },
  );
  ok(res, req, result, 201);
}

export async function getEmployees(req: Request, res: Response): Promise<void> {
  const { cursor, limit, status } = req.validatedQuery as {
    cursor?: string;
    limit?: number;
    status?: 'active' | 'inactive' | 'all';
  };
  const result = await team.listTeam({ cursor, limit: limit ?? 200, status });
  res.status(200).json({
    data: result.items,
    meta: { correlationId: req.correlationId, nextCursor: result.nextCursor },
  });
}
