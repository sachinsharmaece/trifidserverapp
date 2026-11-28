import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { UserModel } from '../../models/index.js';
import { RELEASE_REASONS, type CallOutcome } from '../../shared/enums.js';
import { forbidden } from '../../shared/errors.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { canUseBuyers } from '../parties/permissions.js';
import {
  CALLER_POSITIONS,
  claim,
  deskAssign,
  deskLeave,
  dormancyEnabled,
  eligibleCallersFor,
  isCaller,
  isTeamLeader,
  logReason,
  myHoldings,
  poolList,
  requireDormancyEnabled,
  teamLeaderQueue,
} from './dormancy.js';

/**
 * The dormant policy screens (reference LOCK-34, app/api/dormancy/*).
 *
 *   GET  /dormancy/me                       { enabled, isCaller, isTeamLeader }: which tabs the Buyers page shows
 *   GET  /dormancy/holdings                 my book: { holdings, uncalled: { count, cap } }
 *   GET  /dormancy/pool?section=ordered|leads&search=
 *   POST /dormancy/claim                    { partyId }  ->  201 { holdingId }
 *   POST /dormancy/reason                   { holdingId, reason }
 *   GET  /dormancy/team-leader/queue        the "Waiting 3+ days" list
 *   GET  /dormancy/team-leader/staff        his callers, with their "Receiving leads" switch
 *   GET  /dormancy/team-leader/callers?partyId=
 *   POST /dormancy/team-leader/assign       { partyId, callerId }  ->  201 { holdingId }
 *   POST /dormancy/team-leader/leave        { partyId }
 *
 * Who: the buyer side (Sales and the supervisors). With the policy off every action is 403 "Dormant policy is
 * switched off". Book, Pool and claim are for callers (Sales Executive, Sr. Sales Executive) and the Team Leader
 * (position TM); the team-leader routes are for the Team Leader only.
 */
export const dormancyRouter: Router = Router();

dormancyRouter.use('/dormancy', requireAuth, canUseBuyers);

dormancyRouter.get('/dormancy/me', async (req, res) => {
  const me = currentUserOf(req);
  res.json({
    enabled: await dormancyEnabled(),
    isCaller: isCaller(me.position),
    isTeamLeader: isTeamLeader(me.position),
  });
});

/** Policy on, and the person is a caller or the Team Leader. */
async function callerOrLeader(req: Request, _res: Response, next: NextFunction) {
  await requireDormancyEnabled();
  const { position } = currentUserOf(req);
  if (!isCaller(position) && !isTeamLeader(position)) {
    throw forbidden('Only a caller (Sales Executive / Sr. Sales Executive) can do this');
  }
  next();
}

/** Policy on, and the person is the Sales Team Leader. */
async function leaderOnly(req: Request, _res: Response, next: NextFunction) {
  await requireDormancyEnabled();
  if (!isTeamLeader(currentUserOf(req).position)) {
    throw forbidden('Only the Sales Team Leader can do this');
  }
  next();
}

const partyBody = z.object({ partyId: z.string().min(1, 'Select a party') });

dormancyRouter.get('/dormancy/holdings', callerOrLeader, async (req, res) => {
  res.json(await myHoldings(currentUserOf(req).id));
});

dormancyRouter.get('/dormancy/pool', callerOrLeader, async (req, res) => {
  const query = z
    .object({
      section: z.enum(['ordered', 'leads']).default('ordered'),
      search: z.string().optional(),
    })
    .parse(req.query);
  res.json({ pool: await poolList(currentUserOf(req).id, query.section, query.search) });
});

dormancyRouter.post('/dormancy/claim', callerOrLeader, async (req, res) => {
  const { partyId } = partyBody.parse(req.body);
  res.status(201).json(await claim(partyId, currentUserOf(req).id));
});

dormancyRouter.post('/dormancy/reason', async (req, res) => {
  await requireDormancyEnabled();
  const body = z
    .object({
      holdingId: z.string().min(1, 'Select a holding'),
      reason: z.enum(RELEASE_REASONS.map((r) => r.value) as [CallOutcome, ...CallOutcome[]], {
        message: 'Select a reason',
      }),
    })
    .parse(req.body);
  await logReason(body.holdingId, currentUserOf(req).id, body.reason);
  res.json({ ok: true });
});

dormancyRouter.get('/dormancy/team-leader/queue', leaderOnly, async (_req, res) => {
  res.json({ queue: await teamLeaderQueue() });
});

dormancyRouter.get('/dormancy/team-leader/staff', leaderOnly, async (_req, res) => {
  const staff = await UserModel.find({ position: { $in: CALLER_POSITIONS }, active: true }).sort({
    name: 1,
  });
  res.json({
    staff: staff.map((u) => ({
      id: u.id,
      name: u.name,
      position: u.position,
      receivingLeads: u.receivingLeads,
    })),
  });
});

dormancyRouter.get('/dormancy/team-leader/callers', leaderOnly, async (req, res) => {
  const { partyId } = partyBody.parse(req.query);
  res.json({ callers: await eligibleCallersFor(partyId) });
});

dormancyRouter.post('/dormancy/team-leader/assign', leaderOnly, async (req, res) => {
  const body = partyBody.extend({ callerId: z.string().min(1, 'Select a caller') }).parse(req.body);
  res.status(201).json(await deskAssign(body.partyId, body.callerId));
});

dormancyRouter.post('/dormancy/team-leader/leave', leaderOnly, async (req, res) => {
  const { partyId } = partyBody.parse(req.body);
  await deskLeave(partyId, currentUserOf(req).id);
  res.json({ ok: true });
});
