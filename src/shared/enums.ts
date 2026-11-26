/**
 * Enumerations used by the database models (ARCH §B4). Values are UPPER_SNAKE strings and are stored as-is.
 * One `as const` array per enum gives both the runtime list (for Mongoose `enum:` and Zod) and the TS type.
 * The admin app keeps its own copy of the ones it displays; change both together.
 */

export const ROLES = [
  'FOUNDER',
  'ADMIN',
  'CONTROLLER',
  'SALES',
  'PURCHASE',
  'ACCOUNTS',
  'LOGISTICS',
] as const;
export type Role = (typeof ROLES)[number];

export const SESSION_STATES = ['MFA_PENDING', 'ACTIVE'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const IDEMPOTENCY_STATUSES = ['IN_FLIGHT', 'DONE'] as const;
export type IdempotencyStatus = (typeof IDEMPOTENCY_STATUSES)[number];

export const PRODUCT_CATEGORIES = ['PESTICIDE', 'FERTILIZER', 'SEED', 'OTHER'] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

/** Pack class; selects the margin cell together with the buyer tier. */
export const SKU_CLASSES = ['A', 'B', 'C'] as const;
export type SkuClass = (typeof SKU_CLASSES)[number];

/** `DEALER` replaces the prototype's `WHOLESALER` (its label was already "Dealer"). */
export const BUYER_TIERS = ['TRADER', 'DISTRIBUTOR', 'DEALER', 'RETAILER'] as const;
export type BuyerTier = (typeof BUYER_TIERS)[number];

/** What a buyer is in the trade. Together with the trader flag it decides the buyer's rate tier. */
export const TRADE_POSITIONS = ['DISTRIBUTOR', 'DEALER', 'RETAILER'] as const;
export type TradePosition = (typeof TRADE_POSITIONS)[number];

/** Where a reason code may be picked (each dropdown shows only its own context). */
export const REASON_CODE_CONTEXTS = [
  'BUYER_NO',
  'B6_LEAK',
  'CANCEL_SO',
  'REFUND',
  'COMPLAINT',
  'MARG_QUERY',
  'SELL_LEAD_REJECT',
  'CALL_OUTCOME',
] as const;
export type ReasonCodeContext = (typeof REASON_CODE_CONTEXTS)[number];

export const SETTING_TYPES = ['NUMBER', 'STRING', 'BOOLEAN', 'JSON'] as const;
export type SettingType = (typeof SETTING_TYPES)[number];

/** Document-number prefixes kept in `counters` (format PREFIX-YY-0001). */
export const COUNTER_PREFIXES = [
  'SO',
  'PO',
  'TRADE',
  'ASK',
  'CONF',
  'RCPT',
  'PAYB',
  'RTN',
  'CMP',
  'REF',
  'RV',
  'PV',
] as const;
export type CounterPrefix = (typeof COUNTER_PREFIXES)[number];

/** Seller and buyer numbers have no year: SEL-0001, BUY-0001 (they stay the same for the life of the party). */
export const PARTY_PREFIXES = ['SEL', 'BUY'] as const;
export type PartyPrefix = (typeof PARTY_PREFIXES)[number];

/** FOR = one landed rate delivered to Indore. EX = the seller's ex-works rate plus a carriage cost (COL) per box. */
export const LISTING_RATE_TYPES = ['FOR', 'EX'] as const;
export type ListingRateType = (typeof LISTING_RATE_TYPES)[number];

/** How much shelf life the stock has left. Anything under 6 months is not offered at all (so it is not a choice). */
export const EXPIRY_BANDS = ['M6_TO_9', 'M9_TO_12', 'M12_PLUS'] as const;
export type ExpiryBand = (typeof EXPIRY_BANDS)[number];

/** Where the goods come from. SOURCED is shown to people as "Company billing". */
export const PROVENANCES = ['OWN_STOCK', 'SOURCED'] as const;
export type Provenance = (typeof PROVENANCES)[number];

export const LISTING_STATUSES = ['ACTIVE', 'PAUSED', 'EXPIRED', 'WITHDRAWN'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/**
 * Where a trade stands on the buyer side (SRS §3.7, ARCH B3.4). Built so far: b1 to b8, Leakage, Dock rejected.
 * b1 Viewing → b2 Inquiry (he wants it) → b3 Pending seller → b4 Send confirmation (the seller has answered)
 * → b5 Buyer's call (the offer was sent to him) → b6 Order confirmed (he said yes: sales order raised)
 * → b7 Paid (Accounts confirmed payment in full: the purchase order went to the seller)
 * → b8 To be billed (B8_BILLED: the dock checked the goods; next comes the Marg bill).
 * X_LEAKAGE = the buyer said no, or dropped the order before paying; Sales may reopen it (back to b2).
 * X_DOCK_REJECTED = the dock accepted none of the goods (LOCK-40 O4); the buyer is owed a refund; Sales may reopen.
 */
export const BUYER_STAGES = [
  'B1_VIEWING',
  'B2_INQUIRY',
  'B3_PENDING_SELLER',
  'B4_SEND_CONFIRMATION',
  'B5_BUYERS_CALL',
  'B6_ORDER_CONFIRMED',
  'B7_PAID',
  'B8_BILLED',
  'X_LEAKAGE',
  'X_DOCK_REJECTED',
] as const;
export type BuyerStage = (typeof BUYER_STAGES)[number];

/**
 * Where a trade stands on the seller side. s0 = Purchase must find a seller (the item is not listed);
 * s1 = waiting for the seller to confirm (or the seller has confirmed and the buyer is deciding);
 * s2 = the buyer said yes: the seller holds the stock until the buyer pays;
 * s3 = the buyer paid in full: the purchase order is with the seller, who must dispatch;
 * s5 = dispatched: on the way to the Indore dock (S5_DISPATCHED), then at the dock waiting to be checked
 *      (S5_ARRIVED; the design has one s5, split here so the dock's two steps are clear);
 * s6 = the dock checked the goods: the seller is to be paid for what was accepted (payouts come later);
 * S_RELEASED = the buyer did not take it: the seller may sell the stock to someone else;
 * S_CLOSED = the dock accepted nothing (LOCK-40 O4): the seller side is over.
 */
export const SELLER_STAGES = [
  'S0_DEMAND',
  'S1_CONFIRMATION',
  'S2_HOLD',
  'S3_PO',
  'S5_DISPATCHED',
  'S5_ARRIVED',
  'S6_PAYMENT',
  'S_RELEASED',
  'S_CLOSED',
] as const;
export type SellerStage = (typeof SELLER_STAGES)[number];

/** LISTED = the buyer picked a listing on the rate board. NOT_LISTED = Sales asked for something not on the board. */
export const TRADE_SOURCES = ['LISTED', 'NOT_LISTED'] as const;
export type TradeSource = (typeof TRADE_SOURCES)[number];

/** Why a buyer asks for something that is not on the board (ARCH B4, DemandReasonCode). */
export const ASK_REASONS = [
  'NO_STOCK_LISTED',
  'RATE_ABOVE_MARKET',
  'CONDITION_MISMATCH',
  'OTHER',
] as const;
export type AskReason = (typeof ASK_REASONS)[number];

/** How the seller's answer was given: CONFIRMED a listing, or QUOTED for an item that was not listed. */
export const SELLER_ANSWER_KINDS = ['CONFIRMED', 'QUOTED'] as const;
export type SellerAnswerKind = (typeof SELLER_ANSWER_KINDS)[number];

/** Why a seller said no at s1. OTHER needs a note. */
export const DECLINE_REASONS = ['NO_STOCK', 'RATE_CHANGED', 'EXPIRY_TOO_SHORT', 'OTHER'] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

/** A sales order waits for the buyer's payment, is paid, or was cancelled (the buyer dropped it). */
export const SALES_ORDER_STATUSES = ['AWAITING_PAYMENT', 'PAID', 'CANCELLED'] as const;
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number];

/**
 * The 12 fixed ledger groups of the books (SRS-ACC-02, LOCK-41). Buyers sit under Sundry Debtors, sellers under
 * Sundry Creditors, our bank accounts under Bank Accounts.
 */
export const LEDGER_GROUPS = [
  'Sundry Debtors',
  'Sundry Creditors',
  'Bank Accounts',
  'Sales',
  'Purchase',
  'Duties & Taxes',
  'Direct Expenses',
  'Indirect Expenses',
  'Indirect Income',
  'Capital',
  'Loans',
  'Cash',
] as const;
export type LedgerGroupName = (typeof LEDGER_GROUPS)[number];

/**
 * Kinds of voucher and their number series (SRS-ACC-01). Posted so far: RECEIPT (RV-26-0001, a buyer's payment)
 * and PURCHASE (PV-26-0001, goods accepted at the dock).
 */
export const VOUCHER_TYPES = [
  'RECEIPT',
  'SALES',
  'PURCHASE',
  'PAYMENT',
  'JOURNAL',
  'REVERSAL',
] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];

/**
 * Ledgers that automatic postings find by key, not by name (ARCH B3.5). Each is made the first time it is needed
 * (modules/books/books.ts `systemLedger`). Used so far: PURCHASE and the three INPUT GST ledgers.
 */
export const LEDGER_SYSTEM_KEYS = [
  'SALES',
  'PURCHASE',
  'OUTPUT_CGST',
  'OUTPUT_SGST',
  'OUTPUT_IGST',
  'INPUT_CGST',
  'INPUT_SGST',
  'INPUT_IGST',
  'FREIGHT',
  'ROUND_OFF',
] as const;
export type LedgerSystemKey = (typeof LEDGER_SYSTEM_KEYS)[number];

/** A bank ledger is a current account or a UPI collection account. */
export const BANK_KINDS = ['CURRENT', 'UPI'] as const;
export type BankKind = (typeof BANK_KINDS)[number];

/**
 * A payment a buyer says he made (an "Upcoming payment", SRS-PAY-01): LOGGED by Sales, then POSTED by Accounts
 * (the RECEIPT voucher is written) or REJECTED (not found in the bank).
 */
export const RECEIPT_STATUSES = ['LOGGED', 'POSTED', 'REJECTED'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/**
 * A purchase order: RAISED at Gate A → DISPATCHED (Purchase recorded leg 1) → ARRIVED (at the Indore dock)
 * → CHECKED (the dock accepted some or all of it: Gate B) or REJECTED (the dock accepted nothing, O4).
 */
export const PURCHASE_ORDER_STATUSES = [
  'RAISED',
  'DISPATCHED',
  'ARRIVED',
  'CHECKED',
  'REJECTED',
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

/** How the seller sent the goods to Indore (leg 1): by a transport company, by bus parcel, or from a depot. */
export const LEG1_MODES = ['TRANSPORT', 'BUS', 'DEPOT'] as const;
export type Leg1Mode = (typeof LEG1_MODES)[number];

/** Freight on leg 1: the seller PAID it, or it is TO_PAY at Indore (later taken off the seller's payout). */
export const FREIGHT_TERMS = ['PAID', 'TO_PAY'] as const;
export type FreightTerms = (typeof FREIGHT_TERMS)[number];

/**
 * The result of a dock check (LOCK-40 A2). O1 all accepted · O2 some damaged or leaking · O3 some boxes short ·
 * O4 nothing accepted · O5 extra boxes came. When several apply, the first of O4, O2, O3, O5 is the outcome.
 */
export const INSPECTION_OUTCOMES = ['O1', 'O2', 'O3', 'O4', 'O5'] as const;
export type InspectionOutcome = (typeof INSPECTION_OUTCOMES)[number];

/** A return note sends boxes back to the seller: REJECTED (damaged or leaking) or EXCESS (more than ordered). */
export const RETURN_NOTE_TYPES = ['REJECTED', 'EXCESS'] as const;
export type ReturnNoteType = (typeof RETURN_NOTE_TYPES)[number];

/** How a return note was closed. It is never written off (L40.7). */
export const RETURN_CLOSURES = ['PICKED_UP', 'SHIPPED_BACK', 'DISPOSED'] as const;
export type ReturnClosure = (typeof RETURN_CLOSURES)[number];

/** A refund owed to a buyer. Paying it (PAYMENT voucher) comes with payouts (Q-ACC-11/12). */
export const REFUND_STATUSES = ['DUE'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
