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
  /** false: it is done from its own screen (it needs more than a card can ask), so the deal card shows no button. */
  onCard?: false;
  /** true: only the system presses it, when a clock runs out (no person, not even Founder or Admin). */
  systemOnly?: true;
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
  reopen: { label: 'Reopen', desk: 'SALES', buyerFrom: ['X_LEAKAGE', 'X_DOCK_REJECTED'] },
  enterPayment: { label: 'Enter payment', desk: 'SALES', buyerFrom: ['B6_ORDER_CONFIRMED'] },
  confirmPayment: {
    label: 'Confirm payment',
    desk: 'ACCOUNTS',
    buyerFrom: ['B6_ORDER_CONFIRMED'],
  },
  rejectPayment: {
    label: 'Payment not received',
    desk: 'ACCOUNTS',
    buyerFrom: ['B6_ORDER_CONFIRMED'],
  },
  // Build 3: leg 1 and the dock (LOCK-40). Logistics presses its two from the Dock screen.
  recordDispatch: {
    label: 'Record dispatch',
    desk: 'PURCHASE',
    buyerFrom: ['B7_PAID'],
    sellerFrom: ['S3_PO'],
  },
  recordSellerBill: {
    label: 'Seller bill',
    desk: 'PURCHASE',
    // The buyer side moves on without waiting for the seller's bill (b9 to b11), so the bill may come late.
    buyerFrom: ['B7_PAID', 'B8_BILLED', 'B9_DISPATCH', 'B10_DELIVERED', 'B11_COMPLAINTS'],
    sellerFrom: ['S3_PO', 'S5_DISPATCHED', 'S5_ARRIVED', 'S6_PAYMENT'],
  },
  recordArrival: {
    label: 'Goods arrived',
    desk: 'LOGISTICS',
    buyerFrom: ['B7_PAID'],
    sellerFrom: ['S5_DISPATCHED'],
  },
  inspectLot: {
    label: 'Check the goods',
    desk: 'LOGISTICS',
    buyerFrom: ['B7_PAID'],
    sellerFrom: ['S5_ARRIVED'],
  },
  // Build 4: the Marg bill (Accounts, from To be billed), the POD (Logistics, from Trips), delivery (Sales).
  recordMargBill: { label: 'Marg bill', desk: 'ACCOUNTS', buyerFrom: ['B8_BILLED'] },
  recordPod: { label: 'Proof of dispatch', desk: 'LOGISTICS', buyerFrom: ['B8_BILLED'] },
  confirmDelivery: { label: 'Delivered', desk: 'SALES', buyerFrom: ['B9_DISPATCH'] },
  // Build 5: the bank proof for a seller's line in a released payout batch (Accounts, from the Payouts screen).
  recordSellerPayment: {
    label: 'Seller payment proof',
    desk: 'ACCOUNTS',
    buyerFrom: ['B8_BILLED', 'B9_DISPATCH', 'B10_DELIVERED', 'B11_COMPLAINTS'],
    sellerFrom: ['S6_PAYMENT'],
    onCard: false,
  },
  // Build 6: complaints after dispatch. Sales raises one within the delivery window; the Controller decides.
  raiseComplaint: {
    label: 'Buyer complains',
    desk: 'SALES',
    buyerFrom: ['B9_DISPATCH', 'B10_DELIVERED'],
  },
  resolveComplaint: {
    label: 'Resolve the complaint',
    desk: 'CONTROLLER',
    buyerFrom: ['B11_COMPLAINTS'],
  },
  // The delivery window ended with no complaint: the clock marks the trade delivered (Q-LOG-09, modules/clocks).
  silenceDelivery: {
    label: 'Delivered (no complaint)',
    desk: 'SALES',
    buyerFrom: ['B9_DISPATCH'],
    onCard: false,
    systemOnly: true,
  },
} as const satisfies Record<string, ActionRule>;

export type TradeActionName = keyof typeof TRADE_ACTIONS;

/** Whether the deal card shows a button for this action (a few are done from their own screen). */
export function showsOnCard(action: TradeActionName): boolean {
  const rule: ActionRule = TRADE_ACTIONS[action];
  return rule.onCard !== false;
}
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

/** Founder and Admin have every right, so they may press any desk's button (client decision, 23 Nov 2026), except the system's. */
export const PRESS_ANY_BUTTON_ROLES: readonly Role[] = ['FOUNDER', 'ADMIN'];

/** May this role press this action's button? Its own desk, or Founder/Admin. */
export function canPress(role: Role, action: TradeActionName): boolean {
  const rule: ActionRule = TRADE_ACTIONS[action];
  if (rule.systemOnly) return false;
  return role === rule.desk || PRESS_ANY_BUTTON_ROLES.includes(role);
}

/** Names people see for the desks, as in "Purchase does this". */
export const DESK_NAMES: Partial<Record<Role, string>> = {
  SALES: 'Sales',
  PURCHASE: 'Purchase',
  ACCOUNTS: 'Accounts',
  LOGISTICS: 'Logistics',
  CONTROLLER: 'Controller',
};

/** Labels for the history: the actions above plus the two that create a trade. */
export const HISTORY_LABELS: Record<string, string> = {
  openViewing: 'Opened from the rate board',
  askNotListed: 'Asked for an item that is not listed',
  ...Object.fromEntries(TRADE_ACTION_NAMES.map((name) => [name, TRADE_ACTIONS[name].label])),
};
