import type { Types } from 'mongoose';
import { Buyer } from '../../../models/Buyer.js';
import { Ask } from '../../../models/Ask.js';
import { Quote } from '../../../models/Quote.js';
import { So } from '../../../models/So.js';
import { listRegistrations } from '../../onboarding/onboarding.service.js';
import { addDays } from '../../../shared/clock.js';

/**
 * BR-275's Purchase reading ("measured on leaks closed, not orders placed")
 * has no Sales twin in the Charter (`CH §19`: "books, not lanes" — DEC-S08
 * rejected a more elaborate Sales funnel). This session's own nine-stage
 * read of "what a buyer's own journey through Sales looks like", each a
 * plain count with its own honestly-stated formula — same DoD as
 * `desk/purchase/purchase.funnel.ts`, same shape, a different set of stages.
 */
export const SALES_FUNNEL_WINDOW_DAYS = 30;

// BR-122's 4-working-hour head start plus one full working day — this
// session's own plain-English choice for "an ask has gone stale", stated
// here rather than left as an unexplained number.
const ASK_LEAK_STALENESS_HOURS = 26;

export type FunnelUnit = 'count' | 'percent' | 'hours';

export interface FunnelMetric {
  key:
    | 'registered'
    | 'classified'
    | 'viewing'
    | 'asked'
    | 'rate_held'
    | 'took_it'
    | 'paid'
    | 'delivered'
    | 'ordered_again';
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
  /** Only set on `asked` — open asks past the staleness formula above. */
  leakCount?: number | null;
}

export interface FunnelReport {
  windowDays: number;
  from: string;
  to: string;
  metrics: FunnelMetric[];
}

async function registeredMetric(): Promise<FunnelMetric> {
  // Reuses onboarding.service.ts's own pending-registration query rather
  // than re-deriving the Counterparty filter here; that function has no
  // `kind` filter of its own, so the buyer-ish narrowing happens on its result.
  const { items } = await listRegistrations('pending', undefined, 100000);
  const count = items.filter((r) => r.kind === 'buyer' || r.kind === 'both').length;
  return {
    key: 'registered',
    label: 'Registered',
    formula: 'Count of pending buyer (or buyer+seller) registrations awaiting approval, right now.',
    unit: 'count',
    value: count,
    numerator: count,
    denominator: null,
    caveat: null,
  };
}

async function classifiedMetric(): Promise<FunnelMetric> {
  const count = await Buyer.countDocuments({ classified: true });
  return {
    key: 'classified',
    label: 'Classified',
    formula: 'Count of buyers a desk has classified (BR-044) — tier and trader status set — right now.',
    unit: 'count',
    value: count,
    numerator: count,
    denominator: null,
    caveat: null,
  };
}

async function viewingMetric(): Promise<FunnelMetric> {
  const count = await Buyer.countDocuments({ rateViews: { $gt: 0 } });
  return {
    key: 'viewing',
    label: 'Viewing',
    formula: 'Count of buyers who have looked at a rate at least once, right now.',
    unit: 'count',
    value: count,
    numerator: count,
    denominator: null,
    caveat: null,
  };
}

async function askedMetric(now: Date): Promise<FunnelMetric> {
  const count = await Ask.countDocuments({ state: { $nin: ['lapsed', 'withdrawn'] } });
  const staleBefore = addDays(now, -(ASK_LEAK_STALENESS_HOURS / 24));
  const leakCount = await Ask.countDocuments({ state: 'open', createdAt: { $lte: staleBefore } });
  return {
    key: 'asked',
    label: 'Asked',
    formula:
      'Count of asks not yet lapsed or withdrawn, right now — still live in some sense. ' +
      `Leak: of those, how many are still "open" (no quote at all) after ${ASK_LEAK_STALENESS_HOURS} hours.`,
    unit: 'count',
    value: count,
    numerator: count,
    denominator: null,
    caveat: null,
    leakCount,
  };
}

async function rateHeldMetric(): Promise<FunnelMetric> {
  const count = await Quote.countDocuments({ status: 'live' });
  return {
    key: 'rate_held',
    label: 'Rate held',
    formula: 'Count of quotes currently `live` — a buyer holding a rate right now.',
    unit: 'count',
    value: count,
    numerator: count,
    denominator: null,
    caveat: null,
  };
}

async function tookItMetric(): Promise<FunnelMetric> {
  const count = await So.countDocuments({ state: { $in: ['awaiting_payment', 'payment_verifying'] } });
  return {
    key: 'took_it',
    label: 'Took it',
    formula: 'Count of sales orders currently awaiting payment or with payment being verified, right now.',
    unit: 'count',
    value: count,
    numerator: count,
    denominator: null,
    caveat: null,
  };
}

const PAID_SO_STATES = [
  'po_released',
  'dispatched_leg1',
  'at_indore',
  'inspected',
  'billed_in_marg',
  'dispatched_leg2',
] as const;

async function paidMetric(): Promise<FunnelMetric> {
  const count = await So.countDocuments({ state: { $in: [...PAID_SO_STATES] } });
  return {
    key: 'paid',
    label: 'Paid',
    formula:
      'Count of sales orders paid in full and somewhere in the chain between PO release and leg 2 dispatch, right now.',
    unit: 'count',
    value: count,
    numerator: count,
    denominator: null,
    caveat: null,
  };
}

async function deliveredMetric(): Promise<FunnelMetric> {
  const count = await So.countDocuments({ state: { $in: ['delivered', 'closed'] } });
  return {
    key: 'delivered',
    label: 'Delivered',
    formula: 'Count of sales orders currently `delivered` or `closed`, right now.',
    unit: 'count',
    value: count,
    numerator: count,
    denominator: null,
    caveat: null,
  };
}

async function orderedAgainMetric(): Promise<FunnelMetric> {
  const rows = await So.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $group: { _id: '$buyerId', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  return {
    key: 'ordered_again',
    label: 'Ordered again',
    formula: 'Count of distinct buyers who have placed more than one sales order, of any state, ever.',
    unit: 'count',
    value: rows.length,
    numerator: rows.length,
    denominator: null,
    caveat: null,
  };
}

/** GET /staff/sales/funnel */
export async function getSalesFunnelReport(now: Date = new Date()): Promise<FunnelReport> {
  const from = addDays(now, -SALES_FUNNEL_WINDOW_DAYS);
  const metrics = [
    await registeredMetric(),
    await classifiedMetric(),
    await viewingMetric(),
    await askedMetric(now),
    await rateHeldMetric(),
    await tookItMetric(),
    await paidMetric(),
    await deliveredMetric(),
    await orderedAgainMetric(),
  ];
  return {
    windowDays: SALES_FUNNEL_WINDOW_DAYS,
    from: from.toISOString(),
    to: now.toISOString(),
    metrics,
  };
}
