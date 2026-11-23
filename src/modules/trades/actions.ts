import type { BuyerStage, Role, SellerStage } from '../../shared/enums.js';

/**
 * The trade engine's actions as data (SRS §6.4 command table). Each action may be pressed by its desk (and by
 * Founder and Admin, who have every right), and only when the trade is at one of the `from` stages. The engine
 * checks both; the deal card and every desk queue show the same buttons from this table (Q-WF-01: one engine, two
 * kinds of screen). Controller sees the buttons but cannot press them.
 *
 * Creating a trade is done by two more engine functions (`openViewing`, `askNotListed` in engine.ts).
 */
interface ActionRule {
  /** The button text. */
  label: string;
  /** The desk that presses it. Founder and Admin may press it too (`canPress`). */
  desk: Role;
  buyerFrom: readonly BuyerStage[];
  /** When given, the seller side must also be at one of these stages. */
  sellerFrom?: readonly SellerStage[];
}

export const TRADE_ACTIONS = {
  wantIt: { label: 'He wants it', desk: 'SALES', buyerFrom: ['B1_VIEWING'] },
  sendToSeller: { label: 'Send to seller', desk: 'SALES', buyerFrom: ['B2_INQUIRY'] },
  giveQuote: {
    label: 'Record the quote',
    desk: 'PURCHASE',
    buyerFrom: ['B3_PENDING_SELLER'],
    sellerFrom: ['S0_DEMAND'],
  },
  confirmStock: {
    label: 'Seller confirms',
    desk: 'PURCHASE',
    buyerFrom: ['B3_PENDING_SELLER'],
    sellerFrom: ['S1_CONFIRMATION'],
  },
  declineStock: {
    label: 'Seller declines',
    desk: 'PURCHASE',
    buyerFrom: ['B3_PENDING_SELLER'],
    sellerFrom: ['S1_CONFIRMATION'],
  },
  sendToBuyer: { label: 'Send to buyer', desk: 'SALES', buyerFrom: ['B4_SEND_CONFIRMATION'] },
  buyerYes: { label: 'Buyer says yes', desk: 'SALES', buyerFrom: ['B5_BUYERS_CALL'] },
  buyerNo: { label: 'Buyer says no', desk: 'SALES', buyerFrom: ['B5_BUYERS_CALL'] },
  leakAfterOrder: {
    label: 'Buyer drops the order',
    desk: 'SALES',
    buyerFrom: ['B6_ORDER_CONFIRMED'],
  },
  reopen: { label: 'Reopen', desk: 'SALES', buyerFrom: ['X_LEAKAGE'] },
} as const satisfies Record<string, ActionRule>;

export type TradeActionName = keyof typeof TRADE_ACTIONS;
export const TRADE_ACTION_NAMES = Object.keys(TRADE_ACTIONS) as TradeActionName[];

export function isTradeAction(name: string): name is TradeActionName {
  return Object.hasOwn(TRADE_ACTIONS, name);
}

/** Is the trade at a stage where this action makes sense? */
export function isAtStage(
  action: TradeActionName,
  trade: { buyerStage: BuyerStage; sellerStage?: SellerStage | null | undefined },
): boolean {
  const rule: ActionRule = TRADE_ACTIONS[action];
  if (!rule.buyerFrom.includes(trade.buyerStage)) return false;
  if (!rule.sellerFrom) return true;
  return trade.sellerStage ? rule.sellerFrom.includes(trade.sellerStage) : false;
}

/** Founder and Admin have every right, so they may press any desk's button (client decision, 23 Nov 2026). */
export const PRESS_ANY_BUTTON_ROLES: readonly Role[] = ['FOUNDER', 'ADMIN'];

/** May this role press this action's button? Its own desk, or Founder/Admin. */
export function canPress(role: Role, action: TradeActionName): boolean {
  return role === TRADE_ACTIONS[action].desk || PRESS_ANY_BUTTON_ROLES.includes(role);
}

/** Names people see for the desks, as in "Purchase does this". */
export const DESK_NAMES: Partial<Record<Role, string>> = { SALES: 'Sales', PURCHASE: 'Purchase' };

/** Labels for the history: the actions above plus the two that create a trade. */
export const HISTORY_LABELS: Record<string, string> = {
  openViewing: 'Opened from the rate board',
  askNotListed: 'Asked for an item that is not listed',
  ...Object.fromEntries(TRADE_ACTION_NAMES.map((name) => [name, TRADE_ACTIONS[name].label])),
};
