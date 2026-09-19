import type { ClientSession, Types } from 'mongoose';
import { BookAssignment } from '../../../models/BookAssignment.js';
import { Employee } from '../../../models/Employee.js';
import { Role } from '../../../models/Role.js';
import { So } from '../../../models/So.js';
import { Po } from '../../../models/Po.js';
import { Ask } from '../../../models/Ask.js';
import { Quote } from '../../../models/Quote.js';
import { Complaint, type ComplaintCategory } from '../../../models/Complaint.js';
import { PulseEvent } from '../../../models/PulseEvent.js';
import { Buyer } from '../../../models/Buyer.js';
import { MspRequest, type MspRefusalCode } from '../../../models/MspRequest.js';
import { AppError } from '../../../shared/errors.js';
import { writeAuditLog } from '../../../shared/audit.js';

/**
 * BR-276 — queue → book on a buyer's first order, automatically, no
 * screen involved. The Charter names the *trigger*, not the assignment
 * rule; this session's own reading, flagged rather than invented, is
 * least-loaded round robin across Sales employees — simple, fair, and
 * exactly one sentence to explain to a new hire (`CH §19.8`).
 */
export async function ensureBookAssignment(
  buyerId: Types.ObjectId,
  session?: ClientSession,
): Promise<void> {
  const existing = await BookAssignment.findOne({ buyerId }).session(session ?? null);
  if (existing) return;

  const salesRole = await Role.findOne({ key: 'sales' }).session(session ?? null);
  if (!salesRole) return; // Roles not seeded yet (fresh dev DB) — nothing to assign to.
  const salesEmployees = await Employee.find({ roleIds: salesRole._id, active: true }).session(
    session ?? null,
  );
  if (salesEmployees.length === 0) return; // No Sales staff yet — leave in queue, nothing to assign.

  const counts = await Promise.all(
    salesEmployees.map((e) =>
      BookAssignment.countDocuments({ ownerEmployeeId: e._id }).session(session ?? null),
    ),
  );
  let leastLoaded = salesEmployees[0]!;
  let leastCount = counts[0]!;
  for (let i = 1; i < salesEmployees.length; i += 1) {
    if (counts[i]! < leastCount) {
      leastCount = counts[i]!;
      leastLoaded = salesEmployees[i]!;
    }
  }

  await BookAssignment.create(
    [
      {
        buyerId,
        ownerEmployeeId: leastLoaded._id,
        assignedAt: new Date(),
        assignedBy: leastLoaded._id, // System-triggered; no human actor to attribute it to (BR-276's own trigger).
        reason: 'Auto-assigned on first order (BR-276).',
      },
    ],
    { session, ordered: true },
  );
}

// ---------------------------------------------------------------------------
// Work grouped by what the customer is waiting on — BR-282.
// ---------------------------------------------------------------------------

export interface SalesWorkItem {
  bucket: 'money' | 'promised' | 'he_asked' | 'market';
  refType: 'so' | 'po' | 'ask' | 'quote';
  refId: string;
  buyerId?: string;
  dueAt?: string;
}

export async function getSalesWorklist(): Promise<SalesWorkItem[]> {
  const items: SalesWorkItem[] = [];

  // Money — a payment window running out.
  const awaitingPayment = await So.find({ state: 'awaiting_payment' }).sort({ payDeadline: 1 });
  for (const so of awaitingPayment) {
    items.push({
      bucket: 'money',
      refType: 'so',
      refId: (so._id as Types.ObjectId).toString(),
      buyerId: (so.buyerId as Types.ObjectId).toString(),
      dueAt: so.payDeadline.toISOString(),
    });
  }

  // Promised — "you said you would": an open lifeline/extension request.
  const extensionRequested = await Po.find({ extensionRequestedAt: { $ne: null } }).sort({
    extensionRequestedAt: 1,
  });
  for (const po of extensionRequested) {
    items.push({
      bucket: 'promised',
      refType: 'po',
      refId: (po._id as Types.ObjectId).toString(),
      dueAt: po.extensionRequestedAt?.toISOString(),
    });
  }

  // He asked — waiting on a rate (an open ask with no live quote yet), or a
  // held rate about to expire (a live quote nearing its 24h binding).
  const openAsks = await Ask.find({ state: 'open' }).sort({ createdAt: 1 });
  for (const ask of openAsks) {
    items.push({
      bucket: 'he_asked',
      refType: 'ask',
      refId: (ask._id as Types.ObjectId).toString(),
      buyerId: (ask.buyerId as Types.ObjectId).toString(),
    });
  }
  const expiringSoon = new Date(Date.now() + 4 * 60 * 60 * 1000); // Next 4 hours.
  const nearExpiryQuotes = await Quote.find({
    status: 'live',
    bindingUntil: { $lte: expiringSoon },
  }).sort({ bindingUntil: 1 });
  for (const quote of nearExpiryQuotes) {
    items.push({
      bucket: 'he_asked',
      refType: 'quote',
      refId: (quote._id as Types.ObjectId).toString(),
      dueAt: quote.bindingUntil.toISOString(),
    });
  }

  // Market — rising where a buyer is, and he buys it (BR-278). Surfaced at
  // the area/product level, not per buyer — matching the pulse's own
  // "call list, nothing else" scope (BR-280).
  const rising = await getRisingPulseAreas();
  for (const r of rising) {
    items.push({ bucket: 'market', refType: 'ask', refId: `${r.areaTehsilId}:${r.productId}` });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Market pulse — BR-278/BR-279.
// ---------------------------------------------------------------------------

const PULSE_WINDOW_DAYS = 14;

export async function recordPulseEvent(
  input: {
    buyerId: Types.ObjectId;
    productId: Types.ObjectId;
    kind: 'ask' | 'order';
    fromOurPush?: boolean;
  },
  session?: ClientSession,
): Promise<void> {
  const buyer = await Buyer.findById(input.buyerId).session(session ?? null);
  if (!buyer?.tehsilId) return; // No tehsil set yet — nothing to key the pulse on.
  await PulseEvent.create(
    [
      {
        areaTehsilId: buyer.tehsilId,
        productId: input.productId,
        kind: input.kind,
        fromOurPush: input.fromOurPush ?? false,
      },
    ],
    { session, ordered: true },
  );
}

export interface PulseCell {
  areaTehsilId: string;
  productId: string;
  status: 'rising' | 'falling' | 'steady';
  now: number;
  before: number;
}

/** BR-278 — rising if now >= 5 and now >= before*2; falling if now*2 <= before; steady otherwise. */
export async function getMarketPulse(): Promise<PulseCell[]> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - PULSE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const priorStart = new Date(windowStart.getTime() - PULSE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // BR-279 — the echo rule: events arising from our own push are excluded.
  const nowEvents = await PulseEvent.find({ at: { $gte: windowStart }, fromOurPush: false });
  const beforeEvents = await PulseEvent.find({
    at: { $gte: priorStart, $lt: windowStart },
    fromOurPush: false,
  });

  const key = (e: { areaTehsilId: unknown; productId: unknown }) =>
    `${(e.areaTehsilId as Types.ObjectId).toString()}::${(e.productId as Types.ObjectId).toString()}`;
  const nowCounts = new Map<string, number>();
  for (const e of nowEvents) nowCounts.set(key(e), (nowCounts.get(key(e)) ?? 0) + 1);
  const beforeCounts = new Map<string, number>();
  for (const e of beforeEvents) beforeCounts.set(key(e), (beforeCounts.get(key(e)) ?? 0) + 1);

  const allKeys = new Set([...nowCounts.keys(), ...beforeCounts.keys()]);
  return [...allKeys].map((k) => {
    const [areaTehsilId, productId] = k.split('::');
    const n = nowCounts.get(k) ?? 0;
    const b = beforeCounts.get(k) ?? 0;
    const status: PulseCell['status'] =
      n >= 5 && n >= b * 2 ? 'rising' : n * 2 <= b ? 'falling' : 'steady';
    return { areaTehsilId: areaTehsilId!, productId: productId!, status, now: n, before: b };
  });
}

async function getRisingPulseAreas(): Promise<Array<{ areaTehsilId: string; productId: string }>> {
  const cells = await getMarketPulse();
  return cells.filter((c) => c.status === 'rising');
}

// ---------------------------------------------------------------------------
// Retention — BR-281. One cohort, one 90-day window, one number per month.
// ---------------------------------------------------------------------------

const RETENTION_WINDOW_DAYS = 90;

export interface RetentionCohort {
  month: string; // YYYY-MM.
  firstOrderCount: number;
  retainedCount: number;
  retentionPct: number;
}

export async function getRetentionCohorts(monthsBack = 6): Promise<RetentionCohort[]> {
  const cohorts: RetentionCohort[] = [];
  const now = new Date();

  for (let i = monthsBack; i >= 1; i -= 1) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);

    // A buyer's first-ever order fell in this month.
    const allSos = await So.find({}).sort({ createdAt: 1 });
    const firstOrderByBuyer = new Map<string, Date>();
    for (const so of allSos) {
      const buyerId = (so.buyerId as Types.ObjectId).toString();
      const createdAt = (so as unknown as { createdAt: Date }).createdAt;
      if (!firstOrderByBuyer.has(buyerId)) firstOrderByBuyer.set(buyerId, createdAt);
    }
    const cohortBuyers = [...firstOrderByBuyer.entries()].filter(
      ([, firstAt]) => firstAt >= monthStart && firstAt < monthEnd,
    );

    let retained = 0;
    for (const [buyerId, firstAt] of cohortBuyers) {
      const windowEnd = new Date(firstAt.getTime() + RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const secondOrder = allSos.find(
        (so) =>
          (so.buyerId as Types.ObjectId).toString() === buyerId &&
          (so as unknown as { createdAt: Date }).createdAt > firstAt &&
          (so as unknown as { createdAt: Date }).createdAt <= windowEnd,
      );
      if (secondOrder) retained += 1;
    }

    cohorts.push({
      month: `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}`,
      firstOrderCount: cohortBuyers.length,
      retainedCount: retained,
      retentionPct:
        cohortBuyers.length === 0 ? 0 : Math.round((retained / cohortBuyers.length) * 100),
    });
  }
  return cohorts;
}

// ---------------------------------------------------------------------------
// Complaint routing — BR-201, five categories, each routed on intake.
// ---------------------------------------------------------------------------

export type ComplaintDestination = 'controller' | 'unhandled';

// Corrected M7 (QR-048) — the M6 session's own coded mapping sent categories
// straight to an execution desk (Purchase/Sales/Logistics), but
// BUSINESS_RULES.md's BR-206 is explicit: "Controller decides disputes.
// Sales owns the conversation with the buyer, Purchase owns any recovery
// from the seller, neither sees the other's number." Deciding was never a
// desk's own call to make — `modules/controller`'s dispute queue is now the
// single place fault gets decided for all four of these; Sales's complaint
// queue below only reads the outcome for the buyer conversation, and
// `desk/purchase`'s `getSellerRecoveryQueue` reads it for seller recovery.
// `transit_damage` is deliberately excluded from `'controller'` — BR-180's
// strike-on-refusal clause is untouched this session (`QR-050`), so it stays
// `'unhandled'`: visible on the exception view, actionable by nobody yet.
const COMPLAINT_ROUTING: Record<ComplaintCategory, ComplaintDestination> = {
  transit_damage: 'unhandled',
  hidden_defect_sealed_case: 'controller',
  wrong_declared_by_seller: 'controller',
  wrong_missed_by_dock: 'controller',
  short_count_on_arrival: 'controller',
};

export function destinationForComplaint(category: ComplaintCategory): ComplaintDestination {
  return COMPLAINT_ROUTING[category];
}

export interface ComplaintQueueItem {
  complaintId: string;
  soId: string;
  category: ComplaintCategory;
  destination: ComplaintDestination;
  state: string;
  createdAt: string;
  // M7/BR-206 — the buyer-conversation half of a Controller decision. Never
  // the seller's identity or net (that is `desk/purchase`'s own read).
  disposition: string | null;
  resolutionNote: string | null;
}

// ---------------------------------------------------------------------------
// MSP requests — `PRD INV-22`/`IC-07`. Fixed refusal codes only; the
// response never carries a floor, a limit or a margin statement.
// ---------------------------------------------------------------------------

export interface MspRequestDto {
  mspRequestId: string;
  status: 'pending' | 'granted' | 'refused';
  refusalCode?: MspRefusalCode;
}

export async function requestMsp(
  buyerCounterpartyId: string,
  input: { skuId: string; qty: number; note?: string },
): Promise<{ mspRequestId: string }> {
  const buyer = await Buyer.findOne({ counterpartyId: buyerCounterpartyId });
  if (!buyer) throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Buyers only.' });
  const row = await MspRequest.create({
    buyerId: buyer._id,
    skuId: input.skuId,
    qty: input.qty,
    note: input.note ?? null,
  });
  return { mspRequestId: (row._id as Types.ObjectId).toString() };
}

export async function listMyMspRequests(buyerCounterpartyId: string): Promise<MspRequestDto[]> {
  const buyer = await Buyer.findOne({ counterpartyId: buyerCounterpartyId });
  if (!buyer) throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Buyers only.' });
  const rows = await MspRequest.find({ buyerId: buyer._id }).sort({ createdAt: -1 });
  // IC-07 — coded refusal only; no floor, no limit, no margin in any field.
  return rows.map((r) => ({
    mspRequestId: (r._id as Types.ObjectId).toString(),
    status: r.status as MspRequestDto['status'],
    refusalCode: r.refusalCode ? (r.refusalCode as MspRefusalCode) : undefined,
  }));
}

export async function respondToMsp(
  mspRequestId: string,
  decision: { granted: boolean; refusalCode?: MspRefusalCode },
  actor: { employeeId: string; correlationId: string },
): Promise<void> {
  const row = await MspRequest.findById(mspRequestId);
  if (!row) throw new AppError({ code: 'NOT_FOUND', messageEn: 'MSP request not found.' });
  if (!decision.granted && !decision.refusalCode) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'A refusal requires one of the fixed codes (IC-07).',
    });
  }
  row.status = decision.granted ? 'granted' : 'refused';
  row.refusalCode = decision.granted ? null : (decision.refusalCode ?? null);
  row.respondedBy = actor.employeeId as unknown as Types.ObjectId;
  row.respondedAt = new Date();
  await row.save();
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'msp_request',
    entityId: row._id as Types.ObjectId,
    field: 'status',
    newValue: { status: row.status, refusalCode: row.refusalCode },
    correlationId: actor.correlationId,
  });
}

export async function getMspQueue(): Promise<
  Array<{ mspRequestId: string; buyerId: string; skuId: string; qty: number; status: string }>
> {
  const rows = await MspRequest.find({ status: 'pending' }).sort({ createdAt: 1 });
  return rows.map((r) => ({
    mspRequestId: (r._id as Types.ObjectId).toString(),
    buyerId: r.buyerId.toString(),
    skuId: r.skuId.toString(),
    qty: r.qty,
    status: r.status,
  }));
}

// M7 — widened from `state: 'open'` alone: Sales's buyer-conversation duty
// (BR-206) continues after Controller decides, so a resolved complaint stays
// visible here too, now carrying the outcome to relay to the buyer.
export async function getComplaintQueue(
  destination?: ComplaintDestination,
): Promise<ComplaintQueueItem[]> {
  const complaints = await Complaint.find().sort({ createdAt: -1 }).limit(200);
  return complaints
    .map((c) => ({
      complaintId: (c._id as Types.ObjectId).toString(),
      soId: c.soId.toString(),
      category: c.category as ComplaintCategory,
      destination: destinationForComplaint(c.category as ComplaintCategory),
      state: c.state,
      createdAt: (c as unknown as { createdAt: Date }).createdAt.toISOString(),
      disposition: c.disposition ?? null,
      resolutionNote: c.resolutionNote ?? null,
    }))
    .filter((c) => !destination || c.destination === destination);
}
