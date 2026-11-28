import mongoose, { type ClientSession, type Types } from 'mongoose';
import { numberSetting, textSetting } from '../../db/settings.js';
import {
  BuyerModel,
  CallLogModel,
  CounterModel,
  HoldingModel,
  PoolReviewModel,
  SalesOrderModel,
  TehsilModel,
  UserModel,
} from '../../models/index.js';
import {
  RELEASE_REASONS,
  type CallOutcome,
  type HoldingKind,
  type IntakeSource,
  type StaffPosition,
} from '../../shared/enums.js';
import { conflict, forbidden, invalidField, notFound } from '../../shared/errors.js';
import { logEvent } from '../fastOrder/eventLog.js';
import { addWorkingHoursIST, calendarDaysBetweenIST, clockStart, type Bill } from './clockMath.js';

/**
 * The dormant policy (reference LOCK-34, lib/services/dormancy/*). Every buyer is held by one Sales caller, or
 * sits in the Pool where any caller can claim it.
 *
 *   - A new buyer goes to the caller with the fewest uncalled parties (`assignNewParty`). Nobody under the cap:
 *     the Sales Team Leader (position TM) gets it.
 *   - A LEAD (new buyer) or CLAIM (taken from the Pool) that does not order within DORMANCY_LEAD_DAYS, or a BOOK
 *     party whose last bills are older than DORMANCY_ORDERED_DAYS, gets a reason window ("Why did he go?").
 *     When the window's days have passed, the buyer goes back to the Pool.
 *   - A first bill turns a LEAD into BOOK (same holder); bills reaching the threshold do the same for a CLAIM.
 *   - The Team Leader sees Pool buyers that nobody claimed for DORMANCY_UNCLAIMED_DAYS and assigns or leaves them.
 *
 * Everything is off until the DORMANCY_ENABLED setting is "true". The clock runs once a day (modules/clocks).
 * A buyer's bills are its sales orders with a Marg bill (the bill date is when Accounts keyed it). The reference
 * also counts Marg bills imported at go-live; we have no such import yet, so only our own bills count.
 */

export const CALLER_POSITIONS: StaffPosition[] = ['JR_SALES_EXECUTIVE', 'SR_SALES_EXECUTIVE'];
export const TEAM_LEADER_POSITION: StaffPosition = 'TM';
const PLACEHOLDER_TEHSIL_NAME = 'zzzzz';
const LOCK_ID = 'DORMANCY';

export interface DormancyConfig {
  enabled: boolean;
  goLiveDate: Date | null;
  orderedDays: number;
  billingThresholdPaise: number;
  reasonWindowDays: number;
  uncalledCap: number;
  firstCallWorkingHours: number;
  leadDays: number;
  unclaimedDays: number;
  backlogPerWeek: number;
}

/** Every dormancy setting in one read. */
export async function dormancyConfig(): Promise<DormancyConfig> {
  const goLive = (await textSetting('DORMANCY_GO_LIVE_DATE', '')).trim();
  return {
    enabled: (await textSetting('DORMANCY_ENABLED', 'false')) === 'true',
    goLiveDate: /^\d{4}-\d{2}-\d{2}$/.test(goLive) ? new Date(`${goLive}T00:00:00+05:30`) : null,
    orderedDays: await numberSetting('DORMANCY_ORDERED_DAYS', 90),
    billingThresholdPaise: await numberSetting('DORMANCY_BILLING_THRESHOLD_PAISE', 1_000_000),
    reasonWindowDays: await numberSetting('DORMANCY_REASON_WINDOW_DAYS', 7),
    uncalledCap: await numberSetting('DORMANCY_UNCALLED_CAP', 50),
    firstCallWorkingHours: await numberSetting('DORMANCY_FIRST_CALL_WORKING_HOURS', 4),
    leadDays: await numberSetting('DORMANCY_LEAD_DAYS', 60),
    unclaimedDays: await numberSetting('DORMANCY_UNCLAIMED_DAYS', 3),
    backlogPerWeek: await numberSetting('DORMANCY_BACKLOG_PER_WEEK', 100),
  };
}

export async function dormancyEnabled() {
  return (await textSetting('DORMANCY_ENABLED', 'false')) === 'true';
}

/** Refuses with 403 "Dormant policy is switched off", as the reference does for every dormancy action. */
export async function requireDormancyEnabled() {
  if (!(await dormancyEnabled())) throw forbidden('Dormant policy is switched off');
}

export const isCaller = (position: string | null) =>
  position !== null && (CALLER_POSITIONS as string[]).includes(position);
export const isTeamLeader = (position: string | null) => position === TEAM_LEADER_POSITION;

export function releaseReasonLabel(reason: string | null | undefined) {
  if (!reason) return 'owner did not diagnose';
  return RELEASE_REASONS.find((r) => r.value === reason)?.label ?? reason;
}

type HoldingDoc = InstanceType<typeof HoldingModel>;
const s = (session?: ClientSession | null) => ({ session: session ?? null });

/** A buyer's bills, oldest first (date, then id): its sales orders with a Marg bill. */
export async function billsForParty(
  partyId: Types.ObjectId | string,
  session?: ClientSession | null,
): Promise<Bill[]> {
  const orders = await SalesOrderModel.find(
    { buyerId: partyId, margBill: { $exists: true } },
    null,
    s(session),
  );
  return orders
    .filter((order) => order.margBill)
    .map((order) => ({
      date: order.margBill!.at,
      netAmountPaise: order.margBill!.totalPaise,
      id: order.id,
    }))
    .sort((a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id));
}

/**
 * "Uncalled" holdings (reference §3): open LEAD or CLAIM holdings (not go-live, not own-call) with no call logged by
 * the holder for that buyer since the holding started. Any call outcome counts, "no answer" included.
 */
async function uncalledHoldings(holderIds: string[], session?: ClientSession | null) {
  if (holderIds.length === 0) return [];
  const candidates = await HoldingModel.find(
    {
      holderId: { $in: holderIds },
      isOpen: true,
      kind: { $in: ['LEAD', 'CLAIM'] },
      via: { $nin: ['GO_LIVE', 'OWN_CALL'] },
    },
    null,
    s(session),
  );
  if (candidates.length === 0) return [];
  const calls = await CallLogModel.find(
    { by: { $in: holderIds }, buyerId: { $in: candidates.map((h) => h.partyId) } },
    null,
    s(session),
  );
  return candidates.filter(
    (h) =>
      !calls.some(
        (c) =>
          c.by.equals(h.holderId) &&
          c.buyerId.equals(h.partyId) &&
          (c as unknown as { createdAt: Date }).createdAt >= h.startedAt,
      ),
  );
}

export async function uncalledCounts(holderIds: string[], session?: ClientSession | null) {
  const counts = new Map<string, number>(holderIds.map((id) => [id, 0]));
  for (const h of await uncalledHoldings(holderIds, session)) {
    const key = String(h.holderId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export async function uncalledCount(holderId: string, session?: ClientSession | null) {
  return (await uncalledCounts([holderId], session)).get(holderId) ?? 0;
}

/** Fewest uncalled wins; a tie goes to whoever's last intake is oldest (never given one beats any date). */
async function pickFewestUncalled(
  ids: string[],
  counts: Map<string, number>,
  session: ClientSession,
): Promise<string> {
  const fewest = Math.min(...ids.map((id) => counts.get(id) ?? 0));
  const tied = ids.filter((id) => (counts.get(id) ?? 0) === fewest);
  if (tied.length === 1) return tied[0]!;
  const intakes = await HoldingModel.find({ holderId: { $in: tied }, via: 'INTAKE' }, null, {
    session,
  }).sort({ startedAt: -1 });
  const lastIntake = new Map<string, number>();
  for (const h of intakes) {
    const key = String(h.holderId);
    if (!lastIntake.has(key)) lastIntake.set(key, h.startedAt.getTime());
  }
  const never = tied.find((id) => !lastIntake.has(id));
  if (never) return never;
  return tied.reduce((best, id) => (lastIntake.get(id)! < lastIntake.get(best)! ? id : best));
}

/**
 * Gives a new buyer a holder (reference assignNewParty). Called by every place that creates a buyer. Does nothing
 * when the policy is off. `own_call` makes the person who created it the holder (no cap, not counted as uncalled).
 * One intake at a time: every intake updates the same lock document inside its transaction, so two at once can
 * never both read "under the cap" (the reference's "single lock document").
 */
export async function assignNewParty(
  partyId: Types.ObjectId,
  source: IntakeSource | 'own_call',
  actorId: string,
): Promise<string | null> {
  if (!(await dormancyEnabled())) return null;
  return mongoose.connection.transaction(async (session) => {
    await CounterModel.updateOne({ _id: LOCK_ID }, { $inc: { seq: 1 } }, { upsert: true, session });
    const now = new Date();
    if (source === 'own_call') {
      await HoldingModel.create(
        [{ partyId, holderId: actorId, kind: 'LEAD', via: 'OWN_CALL', startedAt: now }],
        { session },
      );
      await BuyerModel.updateOne({ _id: partyId }, { acquiredById: actorId }, { session });
      return actorId;
    }
    const cap = await numberSetting('DORMANCY_UNCALLED_CAP', 50);
    const callers = await UserModel.find(
      { position: { $in: CALLER_POSITIONS }, receivingLeads: true, active: { $ne: false } },
      null,
      { session },
    );
    const callerIds = callers.map((c) => c.id);
    const counts = await uncalledCounts(callerIds, session);
    const eligible = callerIds.filter((id) => (counts.get(id) ?? 0) < cap);
    let holderId: string;
    if (eligible.length > 0) {
      holderId = await pickFewestUncalled(eligible, counts, session);
    } else {
      // Overflow: the Sales Team Leader, with no cap.
      const leaders = await UserModel.find({ position: TEAM_LEADER_POSITION }, null, { session });
      const leaderIds = leaders.map((u) => u.id);
      if (leaderIds.length === 0) {
        await logEvent(
          {
            category: 'DORMANCY',
            entityType: 'Buyer',
            entityId: partyId,
            action: 'DORMANCY_ASSIGN_FAILED',
            userId: actorId,
            reason:
              'No Sales Team Leader exists to receive overflow intake — party left in the Pool',
          },
          session,
        );
        await BuyerModel.updateOne({ _id: partyId }, { $unset: { acquiredById: '' } }, { session });
        return null;
      }
      holderId = await pickFewestUncalled(
        leaderIds,
        await uncalledCounts(leaderIds, session),
        session,
      );
    }
    await HoldingModel.create(
      [{ partyId, holderId, kind: 'LEAD', via: 'INTAKE', source, startedAt: now }],
      { session },
    );
    await BuyerModel.updateOne({ _id: partyId }, { acquiredById: holderId }, { session });
    return holderId;
  });
}

const isDuplicateKey = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;

async function lastClosedHolding(partyId: Types.ObjectId | string) {
  return HoldingModel.findOne({ partyId, isOpen: false }).sort({ endedAt: -1 });
}

/** When a Pool buyer came into the Pool: its last holding's end, else the go-live date or when it was created. */
function poolEnteredAt(
  lastHolding: HoldingDoc | null,
  createdAt: Date,
  goLiveDate: Date | null,
): Date {
  if (lastHolding?.endedAt) return lastHolding.endedAt;
  return goLiveDate && goLiveDate > createdAt ? goLiveDate : createdAt;
}

/** Opens a holding taken from the Pool (claim or the Team Leader's assign). First claim wins (the unique index). */
async function takeFromPool(
  partyId: string,
  holderId: string,
  via: 'POOL_CLAIM' | 'DESK_ASSIGN',
  now: Date,
) {
  const kind: HoldingKind = (await billsForParty(partyId)).length > 0 ? 'CLAIM' : 'LEAD';
  try {
    const holding = await mongoose.connection.transaction(async (session) => {
      const [created] = await HoldingModel.create(
        [{ partyId, holderId, kind, via, startedAt: now }],
        { session },
      );
      await BuyerModel.updateOne({ _id: partyId }, { acquiredById: holderId }, { session });
      return created!;
    });
    return { holdingId: holding.id };
  } catch (error) {
    if (isDuplicateKey(error)) throw conflict('Already claimed by someone else.');
    throw error;
  }
}

async function findPoolBuyer(partyId: string) {
  const buyer = mongoose.isValidObjectId(partyId) ? await BuyerModel.findById(partyId) : null;
  if (!buyer) throw notFound('Party not found');
  return buyer;
}

/** A caller (or the Team Leader) claims a Pool buyer (reference §4.7). */
export async function claim(partyId: string, callerId: string, now = new Date()) {
  const config = await dormancyConfig();
  const uncalled = await uncalledCount(callerId);
  if (uncalled >= config.uncalledCap) {
    throw conflict(`You have ${uncalled} uncalled. Call them first.`);
  }
  await findPoolBuyer(partyId);
  if (await HoldingModel.exists({ partyId, isOpen: true })) {
    throw conflict('Already claimed by someone else.');
  }
  const last = await lastClosedHolding(partyId);
  if (last && String(last.holderId) === callerId) {
    throw forbidden("You were the last holder of this party — you can't claim it back.");
  }
  return takeFromPool(partyId, callerId, 'POOL_CLAIM', now);
}

/** The Team Leader gives a Pool buyer on his list to a caller (reference §4.8 "Assign"). */
export async function deskAssign(partyId: string, callerId: string, now = new Date()) {
  const config = await dormancyConfig();
  await findPoolBuyer(partyId);
  if (await HoldingModel.exists({ partyId, isOpen: true })) {
    throw conflict('This party already has a holder');
  }
  const caller = mongoose.isValidObjectId(callerId) ? await UserModel.findById(callerId) : null;
  if (!caller?.position || (!isCaller(caller.position) && !isTeamLeader(caller.position))) {
    throw invalidField('callerId', 'Select a caller');
  }
  const last = await lastClosedHolding(partyId);
  if (last && String(last.holderId) === callerId) {
    throw invalidField(
      'callerId',
      'This caller was the last holder of this party — pick someone else',
    );
  }
  const uncalled = await uncalledCount(callerId);
  if (uncalled >= config.uncalledCap) {
    throw conflict(`This caller has ${uncalled} uncalled. Call them first.`);
  }
  return takeFromPool(partyId, callerId, 'DESK_ASSIGN', now);
}

/** The Team Leader leaves a Pool buyer: it drops off his list until it next comes into the Pool. */
export async function deskLeave(partyId: string, reviewerId: string, now = new Date()) {
  const config = await dormancyConfig();
  const buyer = await findPoolBuyer(partyId);
  const entered = poolEnteredAt(
    await lastClosedHolding(partyId),
    (buyer as unknown as { createdAt: Date }).createdAt,
    config.goLiveDate,
  );
  await PoolReviewModel.create({
    partyId,
    poolEnteredAt: entered,
    reviewedBy: reviewerId,
    reviewedAt: now,
  });
}

/** The holder logs (or changes) why the party went, while its window is open. Never releases early. */
export async function logReason(
  holdingId: string,
  holderId: string,
  reason: CallOutcome,
  now = new Date(),
) {
  if (!RELEASE_REASONS.some((r) => r.value === reason)) {
    throw invalidField('reason', 'Not a valid release reason');
  }
  const holding = mongoose.isValidObjectId(holdingId)
    ? await HoldingModel.findById(holdingId)
    : null;
  if (!holding) throw notFound('Holding not found');
  if (String(holding.holderId) !== holderId) throw forbidden("You don't hold this party");
  if (!holding.isOpen || !holding.windowOpenedAt) {
    throw conflict("This party's reason window isn't open");
  }
  holding.reason = reason;
  holding.reasonAt = now;
  await holding.save();
}

// ---------- The clock ----------

async function step(
  h: HoldingDoc,
  start: Date,
  limitDays: number,
  config: DormancyConfig,
  now: Date,
  session: ClientSession,
) {
  let windowOpenedAt = h.windowOpenedAt ?? null;
  if (!windowOpenedAt && calendarDaysBetweenIST(start, now) >= limitDays) {
    windowOpenedAt = now;
    await HoldingModel.updateOne({ _id: h._id }, { windowOpenedAt }, { session });
  }
  if (windowOpenedAt && calendarDaysBetweenIST(windowOpenedAt, now) >= config.reasonWindowDays) {
    await HoldingModel.updateOne(
      { _id: h._id },
      { isOpen: false, end: 'RELEASED', endedAt: now, systemMarked: !h.reason },
      { session },
    );
    // Back in the Pool: nobody holds it now.
    await BuyerModel.updateOne({ _id: h.partyId }, { $unset: { acquiredById: '' } }, { session });
  }
}

/** Closes a LEAD/CLAIM holding and opens the same holder's BOOK holding, starting at `bookStart`. */
async function convert(
  h: HoldingDoc,
  end: 'ORDERED' | 'BILLED',
  bookStart: Date,
  now: Date,
  session: ClientSession,
) {
  await HoldingModel.updateOne({ _id: h._id }, { isOpen: false, end, endedAt: now }, { session });
  await HoldingModel.create(
    [
      {
        partyId: h.partyId,
        holderId: h.holderId,
        kind: 'BOOK',
        via: 'CONVERSION',
        startedAt: bookStart,
      },
    ],
    { session },
  );
}

/** One buyer's open holding, one step of the clock (reference reevaluateParty). Safe to run twice in a day. */
export async function reevaluateParty(partyId: Types.ObjectId | string, now = new Date()) {
  const config = await dormancyConfig();
  if (!config.enabled) return;
  await mongoose.connection.transaction(async (session) => {
    const h = await HoldingModel.findOne({ partyId, isOpen: true }, null, { session });
    if (!h) return;
    const bills = await billsForParty(h.partyId, session);
    if (h.kind === 'LEAD') {
      const firstBill = bills.find((b) => b.date.getTime() >= h.startedAt.getTime());
      if (firstBill) return convert(h, 'ORDERED', firstBill.date, now, session);
      return step(h, h.startedAt, config.leadDays, config, now, session);
    }
    const cs = clockStart(bills, config.billingThresholdPaise);
    if (h.kind === 'CLAIM') {
      if (cs && cs.getTime() >= h.startedAt.getTime())
        return convert(h, 'BILLED', cs, now, session);
      return step(h, h.startedAt, config.leadDays, config, now, session);
    }
    // BOOK
    if (!cs) return; // a book holding with no bills is a data mistake: skip it, do not crash
    if (h.windowOpenedAt && cs.getTime() >= h.windowOpenedAt.getTime()) {
      // He ordered again during the window: the clock starts again.
      await HoldingModel.updateOne(
        { _id: h._id },
        { $unset: { windowOpenedAt: '' }, backlog: false },
        { session },
      );
      return;
    }
    if (h.backlog && !h.windowOpenedAt) {
      if (calendarDaysBetweenIST(cs, now) < config.orderedDays) {
        await HoldingModel.updateOne({ _id: h._id }, { backlog: false }, { session });
      } else {
        return; // still waiting for its turn in the backlog batch
      }
    }
    return step(h, cs, config.orderedDays, config, now, session);
  });
}

/**
 * Opens backlog windows for at most DORMANCY_BACKLOG_PER_WEEK book holdings in any 7 days, oldest bills first
 * (reference §4.9). Backlog holdings come from the go-live import, which we do not have yet, so this usually
 * finds none.
 */
async function openBacklogBatch(now: Date, config: DormancyConfig) {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const openedThisWeek = await HoldingModel.countDocuments({
    backlog: true,
    windowOpenedAt: { $gte: weekAgo, $lte: now },
  });
  const slots = config.backlogPerWeek - openedThisWeek;
  if (slots <= 0) return 0;
  const waiting = await HoldingModel.find({
    isOpen: true,
    kind: 'BOOK',
    backlog: true,
    windowOpenedAt: { $exists: false },
  });
  const due: { id: Types.ObjectId; cs: Date }[] = [];
  for (const h of waiting) {
    const cs = clockStart(await billsForParty(h.partyId), config.billingThresholdPaise);
    if (cs && calendarDaysBetweenIST(cs, now) >= config.orderedDays) due.push({ id: h._id, cs });
  }
  due.sort((a, b) => a.cs.getTime() - b.cs.getTime());
  const toOpen = due.slice(0, slots);
  for (const { id } of toOpen) await HoldingModel.updateOne({ _id: id }, { windowOpenedAt: now });
  return toOpen.length;
}

/** The daily dormancy clock (reference runDormancyClocks). Does nothing when the policy is off. */
export async function runDormancyClocks(now = new Date()) {
  const config = await dormancyConfig();
  if (!config.enabled) return { reevaluated: 0, backlogOpened: 0 };
  const open = await HoldingModel.find({ isOpen: true }, { partyId: 1 });
  for (const { partyId } of open) await reevaluateParty(partyId, now);
  return { reevaluated: open.length, backlogOpened: await openBacklogBatch(now, config) };
}

// ---------- What the screens read ----------

async function tehsilsOf(tehsilIds: Types.ObjectId[]) {
  const tehsils = await TehsilModel.find({ _id: { $in: tehsilIds } });
  return (id: Types.ObjectId) => {
    const tehsil = tehsils.find((t) => t._id.equals(id));
    return {
      tehsil: !tehsil || tehsil.name === PLACEHOLDER_TEHSIL_NAME ? null : tehsil.name,
      district: tehsil?.district ?? '',
      state: tehsil?.state ?? '',
    };
  };
}

/** A caller's own open holdings, uncalled first, each with its clock (reference myHoldings + myUncalledCount). */
export async function myHoldings(holderId: string, now = new Date()) {
  const config = await dormancyConfig();
  const holdings = await HoldingModel.find({ holderId, isOpen: true }).sort({ startedAt: 1 });
  const uncalled = new Set((await uncalledHoldings([holderId])).map((h) => h.id));
  const buyers = await BuyerModel.find({ _id: { $in: holdings.map((h) => h.partyId) } });
  const placeOf = await tehsilsOf(buyers.map((b) => b.tehsilId));
  const rows = holdings.map((h) => {
    const buyer = buyers.find((b) => b._id.equals(h.partyId));
    const isUncalled = uncalled.has(h.id);
    const place = buyer ? placeOf(buyer.tehsilId) : { tehsil: null, district: '', state: '' };
    return {
      id: h.id,
      partyId: String(h.partyId),
      partyName: buyer?.firmName ?? '',
      tehsil: place.tehsil,
      district: place.district,
      kind: h.kind,
      via: h.via,
      startedAt: h.startedAt,
      windowOpenedAt: h.windowOpenedAt ?? null,
      reason: h.reason ?? null,
      uncalled: isUncalled,
      firstCallDueAt:
        h.via === 'INTAKE' && isUncalled
          ? addWorkingHoursIST(h.startedAt, config.firstCallWorkingHours)
          : null,
      releasingInDays: h.windowOpenedAt
        ? Math.max(0, config.reasonWindowDays - calendarDaysBetweenIST(h.windowOpenedAt, now))
        : null,
    };
  });
  rows.sort((a, b) => Number(b.uncalled) - Number(a.uncalled));
  return { holdings: rows, uncalled: { count: uncalled.size, cap: config.uncalledCap } };
}

/** Pool buyers (no open holding), with when each came into the Pool and its last holding. */
async function poolBuyers(config: DormancyConfig) {
  const held = await HoldingModel.find({ isOpen: true }, { partyId: 1 });
  const buyers = await BuyerModel.find({
    _id: { $nin: held.map((h) => h.partyId) },
    active: true,
  });
  const closed = await HoldingModel.find({
    partyId: { $in: buyers.map((b) => b._id) },
    isOpen: false,
  }).sort({ endedAt: 1 });
  return buyers.map((buyer) => {
    const history = closed.filter((h) => h.partyId.equals(buyer._id));
    const last = history[history.length - 1] ?? null;
    return {
      buyer,
      history,
      lastHolderId: last ? String(last.holderId) : null,
      enteredAt: poolEnteredAt(
        last,
        (buyer as unknown as { createdAt: Date }).createdAt,
        config.goLiveDate,
      ),
    };
  });
}

/**
 * The Pool, as one viewer sees it (reference poolList): "ordered" (has bills) or "leads" (never billed); never
 * the buyers he himself released; longest in the Pool first. Search matches firm name, tehsil and district only.
 * A card shows only name and place, and the earlier holders: no mobile, GSTIN or amounts until it is claimed.
 */
export async function poolList(viewerId: string, section: 'ordered' | 'leads', search?: string) {
  const config = await dormancyConfig();
  const pool = (await poolBuyers(config)).filter((p) => p.lastHolderId !== viewerId);
  const placeOf = await tehsilsOf(pool.map((p) => p.buyer.tehsilId));
  const holders = await UserModel.find({
    _id: { $in: pool.flatMap((p) => p.history.map((h) => h.holderId)) },
  });
  const viewerUncalled = await uncalledCount(viewerId);
  const canClaim = viewerUncalled < config.uncalledCap;
  const q = search?.trim().toLowerCase();
  const rows = [];
  for (const p of pool) {
    const isOrdered = (await billsForParty(p.buyer._id)).length > 0;
    if ((section === 'ordered') !== isOrdered) continue;
    const place = placeOf(p.buyer.tehsilId);
    if (
      q &&
      !`${p.buyer.firmName} ${place.tehsil ?? ''} ${place.district}`.toLowerCase().includes(q)
    ) {
      continue;
    }
    rows.push({
      partyId: p.buyer.id,
      partyName: p.buyer.firmName,
      ...place,
      poolEnteredAt: p.enteredAt,
      previousHolders: p.history.map((h) => ({
        name: holders.find((u) => u._id.equals(h.holderId))?.name ?? '',
        from: h.startedAt,
        to: h.endedAt ?? null,
        reason: releaseReasonLabel(h.reason),
      })),
      canClaim,
      claimRefusedReason: canClaim ? null : `You have ${viewerUncalled} uncalled. Call them first.`,
    });
  }
  rows.sort((a, b) => a.poolEnteredAt.getTime() - b.poolEnteredAt.getTime());
  return rows;
}

/** The Team Leader's "Waiting 3+ days" list: Pool buyers in for DORMANCY_UNCLAIMED_DAYS, not left since. */
export async function teamLeaderQueue(now = new Date()) {
  const config = await dormancyConfig();
  const pool = (await poolBuyers(config)).filter(
    (p) => calendarDaysBetweenIST(p.enteredAt, now) >= config.unclaimedDays,
  );
  const reviews = await PoolReviewModel.find({ partyId: { $in: pool.map((p) => p.buyer._id) } });
  const placeOf = await tehsilsOf(pool.map((p) => p.buyer.tehsilId));
  return pool
    .filter(
      (p) =>
        !reviews.some(
          (r) => r.partyId.equals(p.buyer._id) && r.reviewedAt.getTime() >= p.enteredAt.getTime(),
        ),
    )
    .map((p) => {
      const place = placeOf(p.buyer.tehsilId);
      return {
        partyId: p.buyer.id,
        partyName: p.buyer.firmName,
        tehsil: place.tehsil,
        district: place.district,
        poolEnteredAt: p.enteredAt,
      };
    })
    .sort((a, b) => a.poolEnteredAt.getTime() - b.poolEnteredAt.getTime());
}

/** The Assign picker: every caller and Team Leader except the last holder, with "uncalled N / cap". */
export async function eligibleCallersFor(partyId: string) {
  const config = await dormancyConfig();
  const last = mongoose.isValidObjectId(partyId) ? await lastClosedHolding(partyId) : null;
  const callers = await UserModel.find({
    position: { $in: [...CALLER_POSITIONS, TEAM_LEADER_POSITION] },
    active: { $ne: false },
    ...(last ? { _id: { $ne: last.holderId } } : {}),
  }).sort({ name: 1 });
  const counts = await uncalledCounts(callers.map((c) => c.id));
  return callers.map((c) => {
    const count = counts.get(c.id) ?? 0;
    return {
      id: c.id,
      name: c.name,
      uncalledCount: count,
      cap: config.uncalledCap,
      canAssign: count < config.uncalledCap,
    };
  });
}
