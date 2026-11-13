import type { Types } from 'mongoose';
import { SALES_CALLER_POSITIONS } from '../../config/positions.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { Buyer } from '../../models/Buyer.js';
import { Counterparty } from '../../models/Counterparty.js';
import { Employee } from '../../models/Employee.js';
import { Holding } from '../../models/Holding.js';
import { PoolReview } from '../../models/PoolReview.js';
import { Tehsil } from '../../models/Tehsil.js';
import { addDays } from '../../shared/clock.js';
import { writeAuditLog } from '../../shared/audit.js';
import { AppError } from '../../shared/errors.js';
import { assertValidObjectId } from '../../shared/objectId.js';
import { isPlaceholderTehsil } from '../../shared/placeholders.js';
import { isLeaderOf } from '../../shared/team.js';
import { billsForMany } from './holding.bills.js';
import { clockStart, daysBetween, firstCallDueAt, istMidnight } from './holding.rules.js';
import { getSettings, isHoldingEnabled, type HoldingSettings } from './holding.settings.js';
import {
  ineligiblePartyIds,
  isCaller,
  refuse,
  uncalledByHolder,
  type HoldingActor,
} from './holding.service.js';

/**
 * LOCK-34 — what the screens read: a caller's own holdings, the Pool, the Team
 * Leader's list. Nothing here is stored; it is all worked out from the holdings,
 * the bills and the call log.
 */
const id = (value: unknown): string => String(value);
const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

export interface HoldingStatus {
  enabled: boolean;
  isCaller: boolean;
  isTeamLeader: boolean;
  uncalledCap: number;
}

/** The one call that always answers: the screens use it to know whether to show anything new. */
export async function getStatus(actor: {
  employeeId: string;
  permissions: string[];
}): Promise<HoldingStatus> {
  const [enabled, settings] = await Promise.all([isHoldingEnabled(), getSettings()]);
  if (!enabled) {
    return { enabled, isCaller: false, isTeamLeader: false, uncalledCap: settings.uncalledCap };
  }
  const [caller, leader] = await Promise.all([
    isCaller(actor.employeeId),
    isLeaderOf('sales', actor.employeeId),
  ]);
  return {
    enabled,
    isCaller: caller,
    isTeamLeader: leader || actor.permissions.includes(PERMISSIONS.BUYER_ADMIN),
    uncalledCap: settings.uncalledCap,
  };
}

export async function assertTeamLeaderOrAdmin(actor: HoldingActor): Promise<void> {
  if (actor.permissions.includes(PERMISSIONS.BUYER_ADMIN)) return;
  if (await isLeaderOf('sales', actor.employeeId)) return;
  throw new AppError({
    code: 'PERMISSION_DENIED',
    messageEn: 'Only a Sales Team Leader or Admin can do this.',
  });
}

// ---------------------------------------------------------------------------
// A party's name and place
// ---------------------------------------------------------------------------

interface PartyFacts {
  firm: string;
  /** Null for the `zzzzz` placeholder: it is never shown. */
  tehsil: string | null;
  district: string | null;
  state: string | null;
}

async function partyFacts(partyIds: readonly string[]): Promise<Map<string, PartyFacts>> {
  const buyers = await Buyer.find(
    { _id: { $in: partyIds } },
    { counterpartyId: 1, tehsilId: 1 },
  ).lean();
  const [cps, tehsils] = await Promise.all([
    Counterparty.find({ _id: { $in: buyers.map((b) => b.counterpartyId) } }, { firm: 1 }).lean(),
    Tehsil.find({ _id: { $in: buyers.map((b) => b.tehsilId).filter(Boolean) } }).lean(),
  ]);
  const firm = new Map(cps.map((c) => [id(c._id), c.firm ?? '']));
  const tehsil = new Map(tehsils.map((t) => [id(t._id), t]));
  return new Map(
    buyers.map((b) => {
      const t = b.tehsilId ? tehsil.get(id(b.tehsilId)) : undefined;
      return [
        id(b._id),
        {
          firm: firm.get(id(b.counterpartyId)) ?? '',
          tehsil: t && !isPlaceholderTehsil(t.name) ? t.name : null,
          district: t?.district ?? null,
          state: t?.state ?? null,
        },
      ];
    }),
  );
}

// ---------------------------------------------------------------------------
// Clocks of open holdings
// ---------------------------------------------------------------------------

export interface HoldingInfo {
  holdingId: string;
  kind: 'lead' | 'claim' | 'book';
  via: string;
  startedAt: string;
  /** Uncalled: no call by its holder since it started. */
  uncalled: boolean;
  /** Intake leads only, while uncalled: the time the first call is due. */
  callDueAt: string | null;
  /** When the reason window opens (lead/claim: start + lead days; book: clock start + ordered days). */
  clockEndsAt: string | null;
  windowOpenedAt: string | null;
  releasesAt: string | null;
  reason: string | null;
  backlog: boolean;
}

type OpenHolding = {
  _id: Types.ObjectId;
  partyId: Types.ObjectId;
  holderId: Types.ObjectId;
  kind: 'lead' | 'claim' | 'book';
  via: string;
  startedAt: Date;
  windowOpenedAt?: Date | null;
  reason?: string | null;
  backlog?: boolean | null;
};

async function describeHoldings(
  holdings: OpenHolding[],
  settings: HoldingSettings,
): Promise<Map<string, HoldingInfo>> {
  const result = new Map<string, HoldingInfo>();
  if (holdings.length === 0) return result;
  const books = holdings.filter((h) => h.kind === 'book');
  const [bills, uncalled] = await Promise.all([
    billsForMany([...new Set(books.map((h) => id(h.partyId)))], settings.goLiveDate),
    uncalledByHolder([...new Set(holdings.map((h) => id(h.holderId)))]),
  ]);
  const uncalledIds = new Set([...uncalled.values()].flat().map((u) => u.holdingId));

  for (const h of holdings) {
    const open = uncalledIds.has(id(h._id));
    let clockEndsAt: Date | null;
    if (h.kind === 'book') {
      const start = clockStart(bills.get(id(h.partyId)) ?? [], settings.billingThresholdPaise);
      clockEndsAt = start ? addDays(start, settings.orderedDays) : null;
    } else {
      clockEndsAt = addDays(h.startedAt, settings.leadDays);
    }
    result.set(id(h._id), {
      holdingId: id(h._id),
      kind: h.kind,
      via: h.via,
      startedAt: h.startedAt.toISOString(),
      uncalled: open,
      callDueAt:
        open && h.via === 'intake'
          ? firstCallDueAt(h.startedAt, settings.firstCallWorkingHours).toISOString()
          : null,
      clockEndsAt: iso(clockEndsAt),
      windowOpenedAt: iso(h.windowOpenedAt),
      releasesAt: h.windowOpenedAt
        ? addDays(h.windowOpenedAt, settings.reasonWindowDays).toISOString()
        : null,
      reason: h.reason ?? null,
      backlog: Boolean(h.backlog),
    });
  }
  return result;
}

/** For the Buyers list: the holding behind each party on the page, if any. */
export async function holdingInfoForParties(
  partyIds: readonly string[],
): Promise<Map<string, HoldingInfo>> {
  if (partyIds.length === 0) return new Map();
  const settings = await getSettings();
  const holdings = await Holding.find({ partyId: { $in: partyIds }, isOpen: true }).lean();
  const info = await describeHoldings(holdings as unknown as OpenHolding[], settings);
  return new Map(holdings.map((h) => [id(h.partyId), info.get(id(h._id))!]));
}

export interface MyHoldingRow extends HoldingInfo {
  buyerId: string;
  firm: string;
  tehsil: string | null;
  district: string | null;
  state: string | null;
}

export async function myHoldings(
  employeeId: string,
): Promise<{ items: MyHoldingRow[]; uncalled: number; cap: number }> {
  const settings = await getSettings();
  const holdings = (await Holding.find({
    holderId: employeeId,
    isOpen: true,
  }).lean()) as unknown as OpenHolding[];
  const bad = await ineligiblePartyIds(holdings.map((h) => id(h.partyId)));
  const live = holdings.filter((h) => !bad.has(id(h.partyId)));
  const [info, facts] = await Promise.all([
    describeHoldings(live, settings),
    partyFacts(live.map((h) => id(h.partyId))),
  ]);
  const items = live
    .map((h): MyHoldingRow => {
      const party = facts.get(id(h.partyId));
      return {
        ...info.get(id(h._id))!,
        buyerId: id(h.partyId),
        firm: party?.firm ?? '',
        tehsil: party?.tehsil ?? null,
        district: party?.district ?? null,
        state: party?.state ?? null,
      };
    })
    // Uncalled first, then whatever runs out soonest.
    .sort(
      (a, b) =>
        Number(b.uncalled) - Number(a.uncalled) ||
        (a.clockEndsAt ?? '9').localeCompare(b.clockEndsAt ?? '9'),
    );
  return { items, uncalled: items.filter((i) => i.uncalled).length, cap: settings.uncalledCap };
}

// ---------------------------------------------------------------------------
// The Pool (§4.6)
// ---------------------------------------------------------------------------

export interface PreviousHolder {
  holder: string;
  from: string;
  to: string | null;
  reason: string | null;
  /** Released with no reason logged: shown as "owner did not diagnose". */
  systemMarked: boolean;
}

export interface PoolCard {
  buyerId: string;
  firm: string;
  tehsil: string | null;
  district: string | null;
  /** Shown instead of the tehsil when it is the `zzzzz` placeholder. */
  state: string | null;
  section: 'ordered' | 'new';
  enteredAt: string;
  previousHolders: PreviousHolder[];
}

interface PoolRow extends PoolCard {
  enteredDate: Date;
  lastHolderId: string | null;
}

/** Pool entry: when the last holding ended; a never-held party, at creation or go-live if later. */
function poolEntry(
  lastEndedAt: Date | undefined,
  createdAt: Date,
  goLiveDate: string | null,
): Date {
  if (lastEndedAt) return lastEndedAt;
  const goLive = goLiveDate ? istMidnight(goLiveDate) : null;
  return goLive && goLive > createdAt ? goLive : createdAt;
}

async function buildPool(settings: HoldingSettings): Promise<PoolRow[]> {
  const openIds = await Holding.distinct('partyId', { isOpen: true });
  const buyers = await Buyer.find({ _id: { $nin: openIds } }, { _id: 1, createdAt: 1 }).lean();
  const partyIds = buyers.map((b) => id(b._id));
  const [bad, facts, bills, past] = await Promise.all([
    ineligiblePartyIds(partyIds),
    partyFacts(partyIds),
    billsForMany(partyIds, settings.goLiveDate),
    Holding.find({ partyId: { $in: partyIds }, isOpen: false })
      .sort({ startedAt: 1 })
      .lean(),
  ]);
  const people = await Employee.find(
    { _id: { $in: [...new Set(past.map((p) => id(p.holderId)))] } },
    { person: 1 },
  ).lean();
  const name = new Map(people.map((p) => [id(p._id), p.person]));

  const history = new Map<string, PreviousHolder[]>();
  const lastEnded = new Map<string, { at: Date; holderId: string }>();
  const lastHolderOf = new Map<string, string>();
  for (const h of past) {
    const party = id(h.partyId);
    const list = history.get(party) ?? [];
    const prev = list[list.length - 1];
    if (h.via === 'conversion' && prev && lastHolderOf.get(party) === id(h.holderId)) {
      // A lead or claim that turned into a book is one stay for the same holder.
      prev.to = iso(h.endedAt);
      prev.reason = h.reason ?? null;
      prev.systemMarked = Boolean(h.systemMarked);
    } else {
      list.push({
        holder: name.get(id(h.holderId)) ?? '—',
        from: h.startedAt.toISOString(),
        to: iso(h.endedAt),
        reason: h.reason ?? null,
        systemMarked: Boolean(h.systemMarked),
      });
    }
    history.set(party, list);
    lastHolderOf.set(party, id(h.holderId));
    if (h.endedAt && (!lastEnded.get(party) || h.endedAt > lastEnded.get(party)!.at)) {
      lastEnded.set(party, { at: h.endedAt, holderId: id(h.holderId) });
    }
  }

  return buyers
    .filter((b) => !bad.has(id(b._id)))
    .map((b): PoolRow => {
      const party = id(b._id);
      const place = facts.get(party);
      const ended = lastEnded.get(party);
      const entered = poolEntry(
        ended?.at,
        (b as unknown as { createdAt: Date }).createdAt,
        settings.goLiveDate,
      );
      return {
        buyerId: party,
        firm: place?.firm ?? '',
        tehsil: place?.tehsil ?? null,
        district: place?.district ?? null,
        state: place?.state ?? null,
        section: (bills.get(party)?.length ?? 0) > 0 ? 'ordered' : 'new',
        enteredAt: entered.toISOString(),
        previousHolders: history.get(party) ?? [],
        enteredDate: entered,
        lastHolderId: ended?.holderId ?? null,
      };
    })
    .sort((a, b) => a.enteredDate.getTime() - b.enteredDate.getTime());
}

/** The card as the screen gets it: no internal dates or ids. */
const toCard = (row: PoolRow): PoolCard => ({
  buyerId: row.buyerId,
  firm: row.firm,
  tehsil: row.tehsil,
  district: row.district,
  state: row.state,
  section: row.section,
  enteredAt: row.enteredAt,
  previousHolders: row.previousHolders,
});

export interface PoolPage {
  counts: { ordered: number; new: number };
  items: PoolCard[];
  total: number;
  /** Whether this viewer may claim right now, and if not, why (shown on the disabled button). */
  claim: { allowed: boolean; reason: string | null };
}

/**
 * §4.6 — the Pool for one viewer. A caller does not see a party he held last
 * (an earlier holder can claim again). Search matches name, tehsil and district
 * only; the `zzzzz` tehsil is never searched or shown. Longest in the Pool first.
 * Mobile, GSTIN and amounts are not in this response at all.
 */
export async function poolList(
  viewerId: string,
  params: { section: 'ordered' | 'new'; q?: string; offset?: number; limit?: number },
): Promise<PoolPage> {
  const settings = await getSettings();
  const [rows, viewerIsCaller, viewerIsLeader] = await Promise.all([
    buildPool(settings),
    isCaller(viewerId),
    isLeaderOf('sales', viewerId),
  ]);
  const visible = viewerIsLeader ? rows : rows.filter((r) => r.lastHolderId !== viewerId);
  const q = params.q?.trim().toLowerCase();
  const matches = q
    ? visible.filter((r) =>
        [r.firm, r.tehsil, r.district].some((v) => v?.toLowerCase().includes(q)),
      )
    : visible;
  const inSection = matches.filter((r) => r.section === params.section);
  const offset = params.offset ?? 0;
  const items = inSection.slice(offset, offset + (params.limit ?? 50)).map(toCard);

  let claim: PoolPage['claim'] = { allowed: false, reason: null };
  if (viewerIsCaller) {
    const uncalled = (await uncalledByHolder([viewerId])).get(viewerId)!.length;
    claim =
      uncalled >= settings.uncalledCap
        ? { allowed: false, reason: `You have ${uncalled} uncalled. Call them first.` }
        : { allowed: true, reason: null };
  }
  return {
    counts: {
      ordered: matches.filter((r) => r.section === 'ordered').length,
      new: matches.filter((r) => r.section === 'new').length,
    },
    items,
    total: inSection.length,
    claim,
  };
}

// ---------------------------------------------------------------------------
// The Team Leader's list (§4.8)
// ---------------------------------------------------------------------------

export interface DeskCaller {
  employeeId: string;
  person: string;
  uncalled: number;
  cap: number;
  receivingLeads: boolean;
  /** The Team Leader may switch this caller (his own team); Admin may switch anyone. */
  canSwitch: boolean;
}

export interface DeskCard extends PoolCard {
  daysWaiting: number;
  /** The earlier holder, so the picker leaves him out. */
  lastHolderId: string | null;
}

/** Pool parties waiting `unclaimedDays` or more and not yet reviewed since they entered, plus the callers to pick from. */
export async function teamLeaderQueue(
  actor: HoldingActor,
  now: Date = new Date(),
): Promise<{ items: DeskCard[]; callers: DeskCaller[]; unclaimedDays: number }> {
  await assertTeamLeaderOrAdmin(actor);
  const settings = await getSettings();
  const rows = (await buildPool(settings)).filter(
    (r) => daysBetween(r.enteredDate, now) >= settings.unclaimedDays,
  );
  const reviews = rows.length
    ? await PoolReview.find({ partyId: { $in: rows.map((r) => r.buyerId) } }).lean()
    : [];
  const reviewed = new Set(reviews.map((r) => `${id(r.partyId)}|${r.poolEnteredAt.getTime()}`));
  const items = rows
    .filter((r) => !reviewed.has(`${r.buyerId}|${r.enteredDate.getTime()}`))
    .map((r): DeskCard => ({
      ...toCard(r),
      daysWaiting: daysBetween(r.enteredDate, now),
      lastHolderId: r.lastHolderId,
    }));

  const callers = await Employee.find({
    active: true,
    positions: { $in: SALES_CALLER_POSITIONS },
  }).lean();
  const uncalled = await uncalledByHolder(callers.map((c) => id(c._id)));
  const isAdmin = actor.permissions.includes(PERMISSIONS.BUYER_ADMIN);
  return {
    items,
    unclaimedDays: settings.unclaimedDays,
    callers: callers
      .map((c) => ({
        employeeId: id(c._id),
        person: c.person,
        uncalled: uncalled.get(id(c._id))!.length,
        cap: settings.uncalledCap,
        receivingLeads: c.receivingLeads !== false,
        canSwitch: isAdmin || id(c.reportsToSalesLeaderId) === actor.employeeId,
      }))
      .sort((a, b) => a.person.localeCompare(b.person)),
  };
}

/** "Leave": the Team Leader has looked; it drops off his list until the party next enters the Pool. */
export async function leaveInPool(partyId: string, actor: HoldingActor): Promise<void> {
  await assertTeamLeaderOrAdmin(actor);
  assertValidObjectId(partyId, 'partyId');
  const settings = await getSettings();
  const row = (await buildPool(settings)).find((r) => r.buyerId === partyId);
  if (!row) throw refuse('That party is not in the Pool.');
  await PoolReview.create({
    partyId,
    poolEnteredAt: row.enteredDate,
    reviewedBy: actor.employeeId,
  });
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'pool_review',
    entityId: partyId,
    field: 'leave',
    correlationId: actor.correlationId,
  });
}

/** The Team Leader (for his own team) or Admin turns new-lead intake on or off for a caller on leave. */
export async function setReceivingLeads(
  staffId: string,
  on: boolean,
  actor: HoldingActor,
): Promise<void> {
  await assertTeamLeaderOrAdmin(actor);
  assertValidObjectId(staffId, 'staffId');
  const target = await Employee.findOne({
    _id: staffId,
    active: true,
    positions: { $in: SALES_CALLER_POSITIONS },
  });
  if (!target) throw refuse('Pick a Sales Executive or Sr. Sales Executive.');
  const isAdmin = actor.permissions.includes(PERMISSIONS.BUYER_ADMIN);
  if (!isAdmin && id(target.reportsToSalesLeaderId) !== actor.employeeId) {
    throw refuse(`${target.person} is not in your team.`);
  }
  const before = target.receivingLeads !== false;
  target.receivingLeads = on;
  await target.save();
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'employee',
    entityId: target._id as Types.ObjectId,
    field: 'receiving_leads',
    oldValue: before,
    newValue: on,
    correlationId: actor.correlationId,
  });
}
