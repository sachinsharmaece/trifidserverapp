import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { updateConfig } from '../admin/admin.service.js';
import { AppError } from '../../shared/errors.js';
import {
  getSettings,
  assertHoldingEnabled,
  policyUpdateSchema,
  SETTING_KEYS,
  type HoldingSettings,
} from './holding.settings.js';
import {
  assignFromPool,
  claimParty,
  logReason,
  refuse,
  uncalledByHolder,
  type HoldingActor,
} from './holding.service.js';
import {
  assertTeamLeaderOrAdmin,
  getStatus,
  leaveInPool,
  myHoldings,
  poolList,
  setReceivingLeads,
  teamLeaderQueue,
} from './holding.queries.js';
import {
  assignSchema,
  poolQuerySchema,
  reasonSchema,
  receivingLeadsSchema,
} from './holding.validation.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

function actorOf(req: Request): HoldingActor {
  return {
    employeeId: req.auth!.employeeId!,
    permissions: req.auth!.permissions,
    correlationId: req.correlationId,
  };
}

// The one call that always answers, so the screens know whether to show anything new.
export async function status(req: Request, res: Response): Promise<void> {
  ok(res, req, await getStatus(actorOf(req)));
}

export async function mine(req: Request, res: Response): Promise<void> {
  await assertHoldingEnabled();
  ok(res, req, await myHoldings(actorOf(req).employeeId));
}

export async function uncalledCount(req: Request, res: Response): Promise<void> {
  await assertHoldingEnabled();
  const { employeeId } = actorOf(req);
  const [held, settings] = await Promise.all([uncalledByHolder([employeeId]), getSettings()]);
  ok(res, req, { uncalled: held.get(employeeId)!.length, cap: settings.uncalledCap });
}

export async function pool(req: Request, res: Response): Promise<void> {
  await assertHoldingEnabled();
  ok(res, req, await poolList(actorOf(req).employeeId, poolQuerySchema.parse(req.query)));
}

export async function claim(req: Request, res: Response): Promise<void> {
  ok(res, req, await claimParty(req.params.partyId as string, actorOf(req)), 201);
}

export async function reason(req: Request, res: Response): Promise<void> {
  const input = reasonSchema.parse(req.body);
  await logReason(req.params.holdingId as string, input.reason, actorOf(req).employeeId);
  ok(res, req, { ok: true });
}

export async function waiting(req: Request, res: Response): Promise<void> {
  await assertHoldingEnabled();
  ok(res, req, await teamLeaderQueue(actorOf(req)));
}

export async function assign(req: Request, res: Response): Promise<void> {
  await assertHoldingEnabled();
  const actor = actorOf(req);
  await assertTeamLeaderOrAdmin(actor);
  const input = assignSchema.parse(req.body);
  ok(res, req, await assignFromPool(req.params.partyId as string, input.callerId, actor), 201);
}

export async function leave(req: Request, res: Response): Promise<void> {
  await assertHoldingEnabled();
  await leaveInPool(req.params.partyId as string, actorOf(req));
  ok(res, req, { ok: true });
}

export async function receivingLeads(req: Request, res: Response): Promise<void> {
  await assertHoldingEnabled();
  const input = receivingLeadsSchema.parse(req.body);
  await setReceivingLeads(req.params.staffId as string, input.on, actorOf(req));
  ok(res, req, { ok: true });
}

// ---------------------------------------------------------------------------
// Admin: the Dormant policy page
// ---------------------------------------------------------------------------

async function policyView() {
  return { settings: await getSettings(), nightlyJobEnabled: env.dormancyJobEnabled };
}

export async function getPolicy(req: Request, res: Response): Promise<void> {
  ok(res, req, await policyView());
}

export async function putPolicy(req: Request, res: Response): Promise<void> {
  const patch = policyUpdateSchema.parse(req.body);
  const before = await getSettings();
  const after = { ...before, ...patch } as HoldingSettings;
  if (after.enabled && !after.goLiveDate) {
    throw refuse('Set the go-live date before switching this on.', 'goLiveDate');
  }
  const actor = { employeeId: req.auth!.employeeId!, correlationId: req.correlationId };
  for (const [name, value] of Object.entries(patch)) {
    const key = SETTING_KEYS[name as keyof typeof SETTING_KEYS];
    if (!key) throw new AppError({ code: 'VALIDATION_FAILED', messageEn: 'Unknown setting.' });
    if (JSON.stringify(before[name as keyof HoldingSettings]) === JSON.stringify(value)) continue;
    // goLiveDate is the one value that may be cleared; the config table needs a value, so store ''.
    await updateConfig(key, value ?? '', actor);
  }
  ok(res, req, await policyView());
}
