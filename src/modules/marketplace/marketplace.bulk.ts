import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../db/transaction.js';
import { Ask } from '../../models/Ask.js';
import { Employee } from '../../models/Employee.js';
import { Listing, STOP_REASON_CODES, type StopReasonCode } from '../../models/Listing.js';
import { Product } from '../../models/Product.js';
import { OPEN_QUOTE_STATUSES, Quote } from '../../models/Quote.js';
import { Role } from '../../models/Role.js';
import { Seller } from '../../models/Seller.js';
import { Sku } from '../../models/Sku.js';
import { assertValidObjectId } from '../../shared/objectId.js';
import type { StopContext } from './marketplace.closure.js';
import {
  executeStop,
  getListingImpact,
  getQuoteImpact,
  paidSuppliedPools,
  restartListing,
  withdrawQuoteInSession,
  type PoolRow,
  type SupplierCache,
} from './marketplace.service.js';

/**
 * RECTIFY-01 Phase 0 — the emergency controls behind `npm run stop:marketplace` and
 * `npm run restart:stopped`. Everything here calls the same functions the staff routes call
 * (`executeStop`, `withdrawQuoteInSession`, `restartListing`), so a bulk stop is exactly many single
 * stops under one `stopBatchId` — never a second, looser path. Kept out of the scripts so the tests
 * can drive it against the in-memory database.
 */

export type StopScope =
  { kind: 'all' } | { kind: 'seller'; sellerId: string } | { kind: 'product'; productId: string };

/** `all`, `seller=<id>` or `product=<id>` — a seller's or a product's own document id. */
export function parseScope(text: string | undefined): StopScope {
  if (text === 'all') return { kind: 'all' };
  const match = /^(seller|product)=([a-f0-9]{24})$/i.exec(text ?? '');
  if (!match) {
    throw new Error('--scope must be "all", "seller=<id>" or "product=<id>" (a 24-character id).');
  }
  const [, kind, scopeId] = match;
  assertValidObjectId(scopeId!, 'scope');
  return kind!.toLowerCase() === 'seller'
    ? { kind: 'seller', sellerId: scopeId! }
    : { kind: 'product', productId: scopeId! };
}

export function parseReason(code: string | undefined): StopReasonCode {
  if (!code || !(STOP_REASON_CODES as readonly string[]).includes(code)) {
    throw new Error(`--reason must be one of: ${STOP_REASON_CODES.join(', ')}.`);
  }
  return code as StopReasonCode;
}

const id = (value: unknown): string => String(value);

// ---------------------------------------------------------------------------
// The plan — what a run would do, row by row. A dry run prints it; an apply does exactly it.
// ---------------------------------------------------------------------------

export const REPORT_COLUMNS = [
  'type',
  'id',
  'seller',
  'product',
  'detail',
  'status_before',
  'action',
  'open_piles',
  'boxes_piled',
  'offered_deals_kept',
  'parked_quotes',
  'live_quotes',
  'pools_with_commitments',
  'pools_with_paid_commitments',
  'blocked',
  'outcome',
] as const;
export type ReportRow = Record<(typeof REPORT_COLUMNS)[number], string | number>;

export interface StopPlan {
  scope: StopScope;
  listingIds: string[];
  quoteIds: string[];
  rows: ReportRow[];
  /**
   * Listings whose seller supplies an open pool someone is committed to: the run needs
   * --confirm-pools for them. A pool someone else supplies does not put a listing here.
   */
  poolListingIds: string[];
  /**
   * Listings whose seller supplies a pool with a paid commitment. They are in the plan as `stop` only
   * when the plan was made with `confirmPaidPools`; otherwise they are `skip`, and the run says so.
   */
  paidPoolListingIds: string[];
  /** The paid pools behind each of those, so the Admins can be told to settle them. */
  paidPoolsByListing: Record<string, PoolRow[]>;
  /** The plan was made with --confirm-paid-pools. */
  confirmPaidPools: boolean;
}

export interface PlanOptions {
  /** Admin's second tick: also stop listings whose supplied pool has a paid commitment. */
  confirmPaidPools?: boolean;
}

async function listingsInScope(scope: StopScope) {
  const filter: Record<string, unknown> = { state: 'live' };
  if (scope.kind === 'seller') filter.sellerId = scope.sellerId;
  if (scope.kind === 'product') filter.productId = scope.productId;
  return Listing.find(filter).sort({ createdAt: 1 });
}

/** The product a quote is for: its pack's, else the pack or product its ask named. */
async function productOfQuote(quote: InstanceType<typeof Quote>): Promise<string | null> {
  const ask = await Ask.findById(quote.askId, { skuId: 1, productId: 1 });
  const skuId = quote.skuId ?? ask?.skuId ?? null;
  const sku = skuId ? await Sku.findById(skuId, { productId: 1 }) : null;
  const productId = sku?.productId ?? ask?.productId ?? null;
  return productId ? id(productId) : null;
}

async function openQuotesInScope(scope: StopScope) {
  const filter: Record<string, unknown> = { status: { $in: [...OPEN_QUOTE_STATUSES] } };
  if (scope.kind === 'seller') filter.sellerId = scope.sellerId;
  const quotes = await Quote.find(filter).sort({ createdAt: 1 });
  if (scope.kind !== 'product') return quotes;
  const inScope: typeof quotes = [];
  for (const quote of quotes) {
    if ((await productOfQuote(quote)) === scope.productId) inScope.push(quote);
  }
  return inScope;
}

export async function planStop(scope: StopScope, options: PlanOptions = {}): Promise<StopPlan> {
  if (scope.kind === 'seller' && !(await Seller.exists({ _id: scope.sellerId }))) {
    throw new Error(`No seller has the id ${scope.sellerId}.`);
  }
  if (scope.kind === 'product' && !(await Product.exists({ _id: scope.productId }))) {
    throw new Error(`No product has the id ${scope.productId}.`);
  }
  const confirmPaidPools = options.confirmPaidPools === true;
  const rows: ReportRow[] = [];
  const poolListingIds: string[] = [];
  const paidPoolListingIds: string[] = [];
  const paidPoolsByListing: Record<string, PoolRow[]> = {};
  // Who supplies a pool is the same for the whole plan, so it is found once per pool.
  const supplierCache: SupplierCache = new Map();

  const listings = await listingsInScope(scope);
  for (const listing of listings) {
    const impact = await getListingImpact(listing, new Date(), supplierCache);
    const hasPaid = impact.pools.withPaidCommitments > 0;
    const blocked = hasPaid && !confirmPaidPools;
    if (impact.pools.withCommitments > 0) poolListingIds.push(id(listing._id));
    if (hasPaid) {
      paidPoolListingIds.push(id(listing._id));
      paidPoolsByListing[id(listing._id)] = paidSuppliedPools(impact);
    }
    rows.push({
      type: 'listing',
      id: id(listing._id),
      seller: impact.listing.sellerFirm,
      product: impact.listing.product,
      detail: impact.lines.map((line) => `${line.packLabel}: ${line.qty} boxes`).join('; '),
      status_before: listing.state,
      action: blocked ? 'skip' : 'stop',
      open_piles: impact.piles.open,
      boxes_piled: impact.piles.boxesPiled,
      offered_deals_kept: impact.offeredDealsRunning.count,
      parked_quotes: impact.quotes.parked,
      live_quotes: impact.quotes.live,
      pools_with_commitments: impact.pools.withCommitments,
      pools_with_paid_commitments: impact.pools.withPaidCommitments,
      blocked: blocked
        ? 'a pool this seller supplies has paid commitments (needs --confirm-paid-pools)'
        : '',
      outcome: '',
    });
  }

  const quotes = await openQuotesInScope(scope);
  for (const quote of quotes) {
    const impact = await getQuoteImpact(quote);
    rows.push({
      type: 'quote',
      id: id(quote._id),
      seller: impact.quote.sellerFirm,
      product: impact.quote.product,
      detail: `${impact.quote.packLabel}: ${impact.quote.qtyAvailable} boxes`,
      status_before: quote.status,
      action: 'withdraw',
      open_piles: impact.openPilesOnLine,
      boxes_piled: '',
      offered_deals_kept: '',
      parked_quotes: '',
      live_quotes: '',
      pools_with_commitments: '',
      pools_with_paid_commitments: '',
      blocked: '',
      outcome: '',
    });
  }

  return {
    scope,
    listingIds: rows
      .filter((r) => r.type === 'listing' && r.action === 'stop')
      .map((r) => String(r.id)),
    quoteIds: quotes.map((quote) => id(quote._id)),
    rows,
    poolListingIds,
    paidPoolListingIds,
    paidPoolsByListing,
    confirmPaidPools,
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface StopRunOptions {
  reasonCode: StopReasonCode;
  note: string;
  employeeId: string;
  /** Needed when a listing the plan stops has a pool someone is committed to, which its seller supplies. */
  confirmPools?: boolean;
  /** Needed on top of `confirmPools` when a commitment in such a pool is already paid (and the plan said to stop it). */
  confirmPaidPools?: boolean;
  stopBatchId?: string;
}

export interface StopRunResult {
  stopBatchId: string;
  rows: ReportRow[];
  listingsStopped: number;
  listingsSkipped: number;
  quotesWithdrawn: number;
  failures: number;
}

/** A listing is stopped if the plan said so; the quote withdrawals follow, each in its own transaction. */
export async function applyStop(plan: StopPlan, options: StopRunOptions): Promise<StopRunResult> {
  const toStop = new Set(plan.listingIds);
  const needPools = plan.poolListingIds.filter((listingId) => toStop.has(listingId));
  if (needPools.length > 0 && !options.confirmPools) {
    throw new Error(
      `${needPools.length} listing(s) are supplying a pool someone is committed to. ` +
        'Stopping them does not change the pool. Re-run with --confirm-pools to stop them anyway.',
    );
  }
  const needPaid = plan.paidPoolListingIds.filter((listingId) => toStop.has(listingId));
  if (needPaid.length > 0 && !options.confirmPaidPools) {
    throw new Error(
      `${needPaid.length} listing(s) are supplying a pool with a paid commitment. ` +
        'Stopping them does not refund or change the pool; the Admins are told to settle it. ' +
        'Re-run with --confirm-paid-pools as well to stop them anyway.',
    );
  }
  const stopBatchId = options.stopBatchId ?? randomUUID();
  const startedAt = new Date();
  const base = {
    employeeId: options.employeeId,
    correlationId: `stop-batch-${stopBatchId}`,
    reasonCode: options.reasonCode,
    note: options.note,
    stopBatchId,
  };
  const result: StopRunResult = {
    stopBatchId,
    rows: plan.rows.map((row) => ({ ...row })),
    listingsStopped: 0,
    listingsSkipped: 0,
    quotesWithdrawn: 0,
    failures: 0,
  };
  const rowOf = (type: string, rowId: string) =>
    result.rows.find((row) => row.type === type && row.id === rowId)!;

  for (const row of result.rows.filter((r) => r.type === 'listing')) {
    if (row.action !== 'stop') {
      row.outcome = 'skipped';
      result.listingsSkipped += 1;
      continue;
    }
    try {
      const listing = await Listing.findById(row.id);
      if (!listing) throw new Error('listing no longer exists');
      const outcome = await executeStop(
        listing,
        { ...base, now: new Date() },
        plan.paidPoolsByListing[row.id as string] ?? [],
      );
      row.outcome = outcome.stopped ? 'stopped' : 'already stopped';
      if (outcome.stopped) result.listingsStopped += 1;
    } catch (error) {
      row.outcome = `failed: ${error instanceof Error ? error.message : String(error)}`;
      result.failures += 1;
    }
  }

  // Every quote the plan listed. The listing stops above already took those on a stopped listing's
  // lines; this withdraws the rest (a quote on no line, one on a line that was skipped).
  for (const quoteId of plan.quoteIds) {
    const row = rowOf('quote', quoteId);
    try {
      const ctx: StopContext = { ...base, now: new Date() };
      const done = await withTransaction((session) =>
        withdrawQuoteInSession(quoteId, ctx, session),
      );
      if (done.withdrawn) {
        row.outcome = 'withdrawn';
        result.quotesWithdrawn += 1;
        continue;
      }
      const current = await Quote.findById(quoteId, { status: 1, withdrawnAt: 1 });
      if (
        current?.status === 'withdrawn' &&
        current.withdrawnAt &&
        current.withdrawnAt >= startedAt
      ) {
        row.outcome = 'withdrawn with its listing';
        result.quotesWithdrawn += 1;
      } else {
        row.outcome = 'already closed';
      }
    } catch (error) {
      row.outcome = `failed: ${error instanceof Error ? error.message : String(error)}`;
      result.failures += 1;
    }
  }
  return result;
}

/** The employee the run's audit entries are written as: the named one, else the first active Admin. */
export async function resolveActor(
  emailOrId?: string,
): Promise<{ employeeId: string; person: string }> {
  if (emailOrId) {
    const named = /^[a-f0-9]{24}$/i.test(emailOrId)
      ? await Employee.findOne({ _id: emailOrId, active: true })
      : await Employee.findOne({ email: emailOrId.toLowerCase(), active: true });
    if (!named) throw new Error(`No active employee matches "${emailOrId}".`);
    return { employeeId: id(named._id), person: named.person };
  }
  const adminRole = await Role.findOne({ key: 'admin' }, { _id: 1 });
  const admin = adminRole
    ? await Employee.findOne({ active: true, roleIds: adminRole._id }).sort({ createdAt: 1 })
    : null;
  if (!admin) throw new Error('No active Admin found to run as. Pass --by <email or id>.');
  return { employeeId: id(admin._id), person: admin.person };
}

// ---------------------------------------------------------------------------
// Restart a batch
// ---------------------------------------------------------------------------

export type RestartPlanRow = {
  listingId: string;
  seller: string;
  product: string;
  outcome: string;
};

/**
 * The listings a batch stopped and that are still staff-stopped. A listing the seller paused himself
 * is never in a batch, so is never touched; one already restarted by hand is no longer staff-stopped
 * and drops out.
 */
export async function planRestart(stopBatchId: string) {
  return Listing.find({ stopBatchId, state: 'paused', stoppedBy: 'staff' }).sort({ createdAt: 1 });
}

export async function applyRestart(
  stopBatchId: string,
  caller: { employeeId: string; correlationId: string },
): Promise<RestartPlanRow[]> {
  const listings = await planRestart(stopBatchId);
  const rows: RestartPlanRow[] = [];
  for (const listing of listings) {
    const impact = await getListingImpact(listing);
    let outcome: string;
    try {
      const done = await restartListing(
        id(listing._id),
        { note: `Restart of stop batch ${stopBatchId}.` },
        { ...caller, permissions: [] },
      );
      outcome = done.restarted ? 'restarted' : 'unchanged';
    } catch (error) {
      outcome = `not restarted: ${error instanceof Error ? error.message : String(error)}`;
    }
    rows.push({
      listingId: id(listing._id),
      seller: impact.listing.sellerFirm,
      product: impact.listing.product,
      outcome,
    });
  }
  return rows;
}
