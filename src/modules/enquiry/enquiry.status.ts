import type { AskState } from '../../models/Ask.js';
import type { PileDecision } from '../../models/Pile.js';
import type { SoState } from '../../models/So.js';

/**
 * Enquiry journey — the enquiry's status, computed from the states the trade
 * already stores (`ask.state`, `pile.decision`) and STORED on the enquiry
 * (DEC-051) by `syncEnquiry` inside the same transaction as the change it
 * mirrors. These functions are the only place a status is ever decided, so
 * the stored value and the trade cannot disagree about what a state means.
 *
 * The stored status stops at `ordered` (DEC-051): once the enquiry has become
 * an order, the chain carries the trade on, and the enquiry reads its orders'
 * progress at read time (`tradeStatusOf`) rather than mirroring every SO state
 * change. DEC-S06 and BR-030 are untouched — the chain stays six stages.
 *
 * Three kinds of enquiry:
 *   · `pre_trade`    — logged before it can be an ask (DEC-052): the buyer is
 *                      not registered, or the product is not in the catalogue.
 *   · `ask`          — open demand (WF-09): the buyer asks, sellers quote.
 *   · `pile_request` — one buyer taking a listed rate (WF-04/WF-05).
 * A trade enquiry becomes 0..N chains (BR-128 — a split fill is independent chains).
 *
 * A `pre_trade` enquiry has one `party` — whose lead this is. `buyer` (the
 * default, and the only party `ask`/`pile_request` ever have) is Sales's; a
 * `seller` pre-trade enquiry — a seller who called wanting to supply
 * something — is Purchase's own. There is no automatic "raise a listing"
 * equivalent to `raiseAsk` (a real listing needs rate/MOQ/batch terms this
 * record does not collect), so a seller pre-trade enquiry never converts —
 * Purchase marks it `listed` once a listing exists (made separately, on the
 * existing seller-listing screen) or drops it, same two-exit shape as the
 * buyer side.
 */
export const ENQUIRY_KINDS = ['pre_trade', 'ask', 'pile_request'] as const;
export type EnquiryKind = (typeof ENQUIRY_KINDS)[number];

export const ENQUIRY_PARTIES = ['buyer', 'seller'] as const;
export type EnquiryPartyKind = (typeof ENQUIRY_PARTIES)[number];

export const ENQUIRY_STATUSES = [
  // Pre-trade (DEC-052) — the desk converts it to an ask, or drops it.
  'pre_trade',
  // Raised — nobody has responded yet.
  'head_start', // ask — only Trusted/Committed sellers can see it yet (BR-122).
  'awaiting_quotes', // ask — open to the whole board.
  'awaiting_seller', // pile request — the seller has not decided the pile.
  // Responded — a decision is pending.
  'quotes_received', // ask — the buyer (or Sales on a call) picks quotes.
  'requoted', // pile request — seller requoted; ⚠️ QR-045, the buyer step is not built.
  'confirming', // pile request — confirmed, inside the 5-second undo (BR-137).
  'shortfall', // pile request — seller can send less than asked; desk adjudicates (BR-134).
  // Ordered — the stored status stops here.
  'ordered',
  // Closed without an order.
  'declined', // pile request — seller declined, free before payment.
  'withdrawn', // ask — the buyer walked away (BR-130).
  'lapsed', // ask — 30-day TTL ran out (BR-120). ⚠️ No job writes `ask.state = 'lapsed'` yet.
  'dropped', // pre-trade — closed by the desk with a reason code.
  'listed', // pre-trade, seller party — Purchase created a listing for him separately.
] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

/** The four-step strip every desk renders for an enquiry, ahead of the chain's own six. */
export const ENQUIRY_PHASES = ['raised', 'responded', 'ordered', 'closed'] as const;
export type EnquiryPhase = (typeof ENQUIRY_PHASES)[number];
export const ENQUIRY_OUTCOMES = ['open', 'won', 'lost'] as const;
export type EnquiryOutcome = (typeof ENQUIRY_OUTCOMES)[number];
/** Who the enquiry is waiting on right now. `null` once it is closed or ordered. */
export const WAITING_ON = ['buyer', 'seller', 'desk', 'system'] as const;
export type WaitingOn = (typeof WAITING_ON)[number] | null;

export interface EnquiryStatusFields {
  status: EnquiryStatus;
  phase: EnquiryPhase;
  outcome: EnquiryOutcome;
  waitingOn: WaitingOn;
}

const ORDERED: EnquiryStatusFields = {
  status: 'ordered',
  phase: 'ordered',
  outcome: 'won',
  waitingOn: null,
};

export const PRE_TRADE: EnquiryStatusFields = {
  status: 'pre_trade',
  phase: 'raised',
  outcome: 'open',
  waitingOn: 'desk',
};

export const DROPPED: EnquiryStatusFields = {
  status: 'dropped',
  phase: 'closed',
  outcome: 'lost',
  waitingOn: null,
};

export const LISTED: EnquiryStatusFields = {
  status: 'listed',
  phase: 'closed',
  outcome: 'won',
  waitingOn: null,
};

export function deriveAskStatus(
  ask: { state: AskState; visibleToAllAt: Date },
  now: Date = new Date(),
): EnquiryStatusFields {
  switch (ask.state) {
    case 'open':
      return {
        status: ask.visibleToAllAt > now ? 'head_start' : 'awaiting_quotes',
        phase: 'raised',
        outcome: 'open',
        waitingOn: 'seller',
      };
    case 'quoted':
      return { status: 'quotes_received', phase: 'responded', outcome: 'open', waitingOn: 'buyer' };
    case 'withdrawn':
      return { status: 'withdrawn', phase: 'closed', outcome: 'lost', waitingOn: null };
    case 'lapsed':
      return { status: 'lapsed', phase: 'closed', outcome: 'lost', waitingOn: null };
    case 'converted':
      return ORDERED;
  }
}

export function derivePileRequestStatus(pile: {
  decision: PileDecision | null;
  executedAt: Date | null;
  shortfall: boolean;
}): EnquiryStatusFields {
  switch (pile.decision) {
    case null:
      return { status: 'awaiting_seller', phase: 'raised', outcome: 'open', waitingOn: 'seller' };
    case 'requoted':
      return { status: 'requoted', phase: 'responded', outcome: 'open', waitingOn: 'buyer' };
    case 'declined':
      return { status: 'declined', phase: 'closed', outcome: 'lost', waitingOn: null };
    case 'confirmed':
      if (pile.shortfall) {
        return { status: 'shortfall', phase: 'responded', outcome: 'open', waitingOn: 'desk' };
      }
      if (!pile.executedAt) {
        return { status: 'confirming', phase: 'responded', outcome: 'open', waitingOn: 'system' };
      }
      return ORDERED;
  }
}

// ---------------------------------------------------------------------------
// Read time only — how an ordered enquiry's trade is going, from its SOs.
// ---------------------------------------------------------------------------

export type TradeStatus = 'in_trade' | 'completed' | 'cancelled';
export interface TradeStatusFields {
  tradeStatus: TradeStatus;
  /** Who the trade is waiting on — the buyer's money/decision, or the chain itself. */
  tradeWaitingOn: 'buyer' | 'chain' | null;
}

const SO_DEAD: ReadonlySet<SoState> = new Set(['cancelled', 'supply_failed']);
const SO_DONE: ReadonlySet<SoState> = new Set(['closed']);
// The buyer owes something on these — money or a decision (WF-11 promotion).
const SO_ON_BUYER: ReadonlySet<SoState> = new Set(['awaiting_payment', 'promotion_offered']);

export function tradeStatusOf(soStates: readonly SoState[]): TradeStatusFields | null {
  if (soStates.length === 0) return null;
  const live = soStates.filter((s) => !SO_DEAD.has(s) && !SO_DONE.has(s));
  if (live.length > 0) {
    return {
      tradeStatus: 'in_trade',
      tradeWaitingOn: live.some((s) => SO_ON_BUYER.has(s)) ? 'buyer' : 'chain',
    };
  }
  return {
    tradeStatus: soStates.some((s) => SO_DONE.has(s)) ? 'completed' : 'cancelled',
    tradeWaitingOn: null,
  };
}
