/**
 * The Accounts desk's read model — one snapshot, shaped like the desk
 * prototype's own data (`trifid data/accounts_v5.html`'s `MOCK`) so the screen
 * can derive every view from it the same way the prototype does.
 *
 * Every money figure is in paise. Ids named `id` are what the screen shows
 * (SO-26-0417, PO-26-0184, …); `key` is the database id, used only when a
 * button has to call the API.
 */

export interface AccountsLogEntry {
  at: string;
  by: string;
  what: string;
  why: string;
}

export interface AccountsDocLine {
  item: string;
  qty: number;
  /** Per box. A buyer's SO rate includes GST (DEC-045); a PO rate is taxable. */
  ratePaise: number;
  /** The server edits a PO's rate per base unit, not per box. */
  baseUnitsPerBox: number;
}

export interface AccountsParty {
  id: string;
  type: 'buyer' | 'seller';
  name: string;
  person: string;
  area: string;
  gstin: string;
  /** Masked account on file, or "—". */
  bank: string;
  mobile: string;
  openingPaise: number;
  since: string;
  /** Sellers only — is the latest bank detail payable right now (BR-017). */
  verified?: boolean;
}

export type AccountsSoState =
  | 'awaiting_payment'
  | 'awaiting_goods'
  | 'ready_to_bill'
  | 'billing_query'
  | 'awaiting_dispatch'
  | 'supply_failed'
  | 'promotion_offered'
  | 'disputed'
  | 'closed';

export interface AccountsSo {
  id: string;
  key: string;
  chain: string;
  party: string;
  date: string;
  leftH: number;
  state: AccountsSoState;
  lines: AccountsDocLine[];
  taxablePaise: number;
  gstPaise: number;
  totalPaise: number;
  po: string | null;
  log: AccountsLogEntry[];
}

export interface AccountsPo {
  id: string;
  key: string;
  chain: string;
  party: string;
  so: string;
  date: string;
  due: string;
  lines: AccountsDocLine[];
  taxablePaise: number;
  gstPaise: number;
  totalPaise: number;
  /** What we pay: the seller's accepted bill value, else the PO total. */
  payablePaise: number;
  received: boolean;
  inspected: boolean;
  billed: boolean;
  /** Accounts' own product/quantity confirmation (separate from the dock's inspection). */
  confirmed: boolean;
  /** The seller's latest bank detail is verified and past its cooling window. */
  bankOk: boolean;
  hold: boolean;
  paid: boolean;
  failed: boolean;
  log: AccountsLogEntry[];
}

export interface AccountsSellerBill {
  id: string;
  po: string;
  party: string;
  date: string;
  taxablePaise: number;
  gstPaise: number;
  totalPaise: number;
  filed: boolean;
  /** Key for the mark-filed call. */
  key: string;
}

export interface AccountsMargBill {
  id: string;
  so: string;
  party: string;
  date: string;
  by: string;
  valuePaise: number;
  eway: string;
  state: 'matched' | 'query';
  note: string | null;
}

export interface AccountsUpcoming {
  id: string;
  key: string;
  party: string;
  saidAt: string;
  amountPaise: number;
  utr: string;
  mode: string;
  sos: string[];
  pickedBy: string;
  state: 'waiting' | 'landed_wrong_account';
  note: string;
}

export interface AccountsBankLine {
  id: string;
  key: string;
  date: string;
  kind: 'in' | 'out';
  purpose: 'receipt' | 'payout' | 'refund' | 'reversal';
  party: string;
  partyType: 'buyer' | 'seller';
  ref: string | null;
  amountPaise: number;
  utr: string;
  /** Masked remitter account on an `in` line. */
  from: string;
  narration: string;
  queried: boolean;
}

export interface AccountsRepost {
  at: string;
  by: string;
  line: string;
  from: string;
  to: string;
  why: string;
}

export interface AccountsRefund {
  id: string;
  key: string;
  party: string;
  so: string | null;
  amountPaise: number;
  state: 'ready' | 'held' | 'in_batch' | 'not_payable';
  why: string;
}

export interface AccountsRunItem {
  kind: 'payout' | 'refund';
  key: string;
  ref: string;
  party: string;
  amountPaise: number;
}

export interface AccountsRun {
  id: string;
  key: string;
  builtBy: string;
  builtByKey: string;
  builtAt: string;
  state: 'awaiting_release' | 'released' | 'sent_back';
  releasedBy: string | null;
  releasedAt: string | null;
  sentBackBy: string | null;
  sentBackAt: string | null;
  sentBackReason: string | null;
  items: AccountsRunItem[];
}

export interface AccountsBankChange {
  id: string;
  /** The pending bank detail's id — what the call-back is logged against. */
  key: string;
  party: string;
  old: string;
  new: string;
  asked: string;
  callback: boolean;
  /** Set once the call-back is logged: when the new account becomes payable. */
  effectiveFrom: string | null;
}

export interface AccountsMovement {
  id: string;
  leg: 1 | 2;
  chain: string;
  ref: string;
  what: string;
  counter: string;
  lr: string;
  left: string | null;
  due: string | null;
  state: 'in_transit' | 'at_indore' | 'delivered' | 'held';
  note?: string;
}

export interface AccountsSnapshot {
  today: string;
  day: string;
  period: string;
  config: {
    gstPct: number;
    payWindowH: number;
    sellerLockH: number;
    callbackCoolingH: number;
  };
  /** Sum of the book's own in − out, all time (there is no opening-balance entry yet). */
  bankClosingPaise: number;
  parties: AccountsParty[];
  sos: AccountsSo[];
  pos: AccountsPo[];
  bills: AccountsSellerBill[];
  margBills: AccountsMargBill[];
  upcoming: AccountsUpcoming[];
  bankbook: AccountsBankLine[];
  reposts: AccountsRepost[];
  refunds: AccountsRefund[];
  runs: AccountsRun[];
  bankChanges: AccountsBankChange[];
  movements: AccountsMovement[];
}
