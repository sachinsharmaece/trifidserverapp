import type { Types } from 'mongoose';
import { Ask } from '../../../models/Ask.js';
import { Quote } from '../../../models/Quote.js';
import { NonOrderReason } from '../../../models/NonOrderReason.js';
import { Pile } from '../../../models/Pile.js';
import { PileRequest } from '../../../models/PileRequest.js';
import { Po } from '../../../models/Po.js';
import { Movement } from '../../../models/Movement.js';
import { Inspection } from '../../../models/Inspection.js';
import { SellerDebit } from '../../../models/SellerDebit.js';
import { addDays, istDateKey } from '../../../shared/clock.js';

/**
 * BR-275 (CH §18.11) — "Purchase is measured on leaks closed, not orders
 * placed": blind demand eliminated · time to confirm · same-day dispatch % ·
 * rejection rate · debits recovered · time to first seller.
 *
 * DoD (MASTER_PLAN §M8) — every metric states its own formula, in plain words,
 * and nothing here is tunable: the window is one fixed constant (the same
 * trailing 30 days BR-062 already uses), not a setting.
 *
 * Wall (BR-067, BR-069/CH §18.5) — this is a Purchase surface, so it carries
 * no rupee figure and no buyer identity. "Debits recovered" is therefore a
 * COUNT, never an amount. A build-failing sweep in tests/m8.test.ts checks that
 * no key here names money.
 */
export const FUNNEL_WINDOW_DAYS = 30;

export type FunnelUnit = 'count' | 'percent' | 'hours';

export interface FunnelMetric {
  key:
    | 'blind_demand_eliminated'
    | 'time_to_confirm'
    | 'same_day_dispatch'
    | 'rejection_rate'
    | 'debits_recovered'
    | 'time_to_first_seller';
  label: string;
  /** The calculation, in plain words, exactly as it is shown on screen. */
  formula: string;
  unit: FunnelUnit;
  /** `null` when there is nothing yet to measure — never a fabricated zero. */
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  /** A known limit on how much to trust this figure today. */
  caveat: string | null;
}

export interface FunnelReport {
  windowDays: number;
  from: string;
  to: string;
  metrics: FunnelMetric[];
}

function createdAtOf(doc: unknown): Date {
  return (doc as { createdAt: Date }).createdAt;
}

function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (60 * 60 * 1000);
}

function averageHours(hours: number[]): number | null {
  if (hours.length === 0) return null;
  const mean = hours.reduce((sum, h) => sum + h, 0) / hours.length;
  return Math.round(mean * 10) / 10;
}

function percent(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// One small function per metric, each returning its own FunnelMetric.
// ---------------------------------------------------------------------------

async function blindDemandEliminated(from: Date): Promise<FunnelMetric> {
  // "Blind" = Purchase coded the ask `no_seller_in_scope` (BR-270, BR-269).
  const flagged = await NonOrderReason.find({
    bucket: 'supply_gap',
    code: 'no_seller_in_scope',
    askId: { $ne: null },
    at: { $gte: from },
  });
  let eliminated = 0;
  const seenAsks = new Set<string>();
  for (const reason of flagged) {
    const askId = (reason.askId as Types.ObjectId).toString();
    if (seenAsks.has(askId)) continue;
    seenAsks.add(askId);
    const quotedSince = await Quote.exists({ askId: reason.askId, createdAt: { $gt: reason.at } });
    if (quotedSince) eliminated += 1;
  }
  return {
    key: 'blind_demand_eliminated',
    label: 'Blind demand eliminated',
    formula: `Of the asks Purchase coded "no seller in scope" in the last ${FUNNEL_WINDOW_DAYS} days, how many have since received at least one quote.`,
    unit: 'count',
    value: eliminated,
    numerator: eliminated,
    denominator: seenAsks.size,
    caveat: null,
  };
}

async function timeToConfirm(from: Date): Promise<FunnelMetric> {
  const piles = await Pile.find({ decision: 'confirmed', decidedAt: { $gte: from } });
  const hours: number[] = [];
  for (const pile of piles) {
    const first = await PileRequest.findOne({ pileId: pile._id }).sort({ requestedAt: 1 });
    if (first && pile.decidedAt) hours.push(hoursBetween(first.requestedAt, pile.decidedAt));
  }
  return {
    key: 'time_to_confirm',
    label: 'Time to confirm',
    formula: `Average hours from a buyer's first request on a pile to the seller confirming it, for piles confirmed in the last ${FUNNEL_WINDOW_DAYS} days.`,
    unit: 'hours',
    value: averageHours(hours),
    numerator: null,
    denominator: hours.length,
    caveat: null,
  };
}

async function sameDayDispatch(from: Date, now: Date): Promise<FunnelMetric> {
  // BR-174 — the seller's obligation is to dispatch the day the PO releases.
  const pos = await Po.find({ createdAt: { $gte: from }, failed: false });
  const today = istDateKey(now);
  let sameDay = 0;
  let counted = 0;
  for (const po of pos) {
    const released = createdAtOf(po);
    const leg1 = await Movement.findOne({ chainId: po.chainId, leg: 1 }).sort({ dispatchedAt: 1 });
    if (leg1) {
      counted += 1;
      if (istDateKey(leg1.dispatchedAt) === istDateKey(released)) sameDay += 1;
    } else if (istDateKey(released) < today) {
      counted += 1; // Its release day has ended with no dispatch: a miss, not a "not yet".
    }
  }
  return {
    key: 'same_day_dispatch',
    label: 'Same-day dispatch %',
    formula: `Of the purchase orders released in the last ${FUNNEL_WINDOW_DAYS} days that were dispatched, or whose release day has already ended, the percentage dispatched on the same (IST) day they were released.`,
    unit: 'percent',
    value: percent(sameDay, counted),
    numerator: sameDay,
    denominator: counted,
    caveat: null,
  };
}

async function rejectionRate(from: Date): Promise<FunnelMetric> {
  const inspections = await Inspection.find({ signedAt: { $gte: from } });
  const rejected = inspections.reduce((sum, i) => sum + i.casesRejected, 0);
  const inspected = inspections.reduce((sum, i) => sum + i.casesAccepted + i.casesRejected, 0);
  return {
    key: 'rejection_rate',
    label: 'Rejection rate',
    formula: `Cases rejected at the dock divided by cases inspected, for inspections signed in the last ${FUNNEL_WINDOW_DAYS} days.`,
    unit: 'percent',
    value: percent(rejected, inspected),
    numerator: rejected,
    denominator: inspected,
    caveat: null,
  };
}

async function debitsRecovered(from: Date): Promise<FunnelMetric> {
  const raised = await SellerDebit.countDocuments({ createdAt: { $gte: from } });
  const recovered = await SellerDebit.countDocuments({
    createdAt: { $gte: from },
    nettedAgainst: { $ne: null },
  });
  return {
    key: 'debits_recovered',
    label: 'Debits recovered',
    formula: `Of the seller debits raised in the last ${FUNNEL_WINDOW_DAYS} days, how many have been netted against a later payout. Counted, never valued — no rupee figure appears on a Purchase surface.`,
    unit: 'count',
    value: recovered,
    numerator: recovered,
    denominator: raised,
    // True of the code as of M8: nothing writes `nettedAgainst`, so this reads
    // 0 recovered until seller-debit netting is built (a payout-side feature).
    caveat:
      'Nothing in the system yet marks a seller debit as recovered, so this reads zero recovered until debit netting is built.',
  };
}

async function timeToFirstSeller(from: Date): Promise<FunnelMetric> {
  const asks = await Ask.find({ createdAt: { $gte: from } });
  const hours: number[] = [];
  for (const ask of asks) {
    const firstQuote = await Quote.findOne({ askId: ask._id }).sort({ createdAt: 1 });
    if (firstQuote) hours.push(hoursBetween(createdAtOf(ask), createdAtOf(firstQuote)));
  }
  return {
    key: 'time_to_first_seller',
    label: 'Time to first seller',
    formula: `Average hours from an ask being raised to its first quote, for asks raised in the last ${FUNNEL_WINDOW_DAYS} days that have received one. Asks with no quote yet are not in the average.`,
    unit: 'hours',
    value: averageHours(hours),
    numerator: null,
    denominator: hours.length,
    caveat: null,
  };
}

/** GET /staff/purchase/funnel — and the funnel block on the Founder overview. */
export async function getFunnelReport(now: Date = new Date()): Promise<FunnelReport> {
  const from = addDays(now, -FUNNEL_WINDOW_DAYS);
  const metrics = [
    await blindDemandEliminated(from),
    await timeToConfirm(from),
    await sameDayDispatch(from, now),
    await rejectionRate(from),
    await debitsRecovered(from),
    await timeToFirstSeller(from),
  ];
  return {
    windowDays: FUNNEL_WINDOW_DAYS,
    from: from.toISOString(),
    to: now.toISOString(),
    metrics,
  };
}
