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
];
/** Who did something: a person (by role) or the system itself (the clock jobs, Build 6). */
export const ACTOR_ROLES = [...ROLES, 'SYSTEM'];
export const SESSION_STATES = ['MFA_PENDING', 'ACTIVE'];
export const IDEMPOTENCY_STATUSES = ['IN_FLIGHT', 'DONE'];
export const PRODUCT_CATEGORIES = ['PESTICIDE', 'FERTILIZER', 'SEED', 'OTHER'];
/** Pack class; selects the margin cell together with the buyer tier. */
export const SKU_CLASSES = ['A', 'B', 'C'];
/** `DEALER` replaces the prototype's `WHOLESALER` (its label was already "Dealer"). */
export const BUYER_TIERS = ['TRADER', 'DISTRIBUTOR', 'DEALER', 'RETAILER'];
/** What a buyer is in the trade. Together with the trader flag it decides the buyer's rate tier. */
export const TRADE_POSITIONS = ['DISTRIBUTOR', 'DEALER', 'RETAILER'];
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
];
export const SETTING_TYPES = ['NUMBER', 'STRING', 'BOOLEAN', 'JSON'];
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
    'SV',
    'PY',
    'JV',
    'RX',
    'JNL',
    'T',
];
/** Seller and buyer numbers have no year: SEL-0001, BUY-0001 (they stay the same for the life of the party). */
export const PARTY_PREFIXES = ['SEL', 'BUY'];
/** FOR = one landed rate delivered to Indore. EX = the seller's ex-works rate plus a carriage cost (COL) per box. */
export const LISTING_RATE_TYPES = ['FOR', 'EX'];
/** How much shelf life the stock has left. Anything under 6 months is not offered at all (so it is not a choice). */
export const EXPIRY_BANDS = ['M6_TO_9', 'M9_TO_12', 'M12_PLUS'];
/** Where the goods come from. SOURCED is shown to people as "Company billing". */
export const PROVENANCES = ['OWN_STOCK', 'SOURCED'];
export const LISTING_STATUSES = ['ACTIVE', 'PAUSED', 'EXPIRED', 'WITHDRAWN'];
/**
 * Where a trade stands on the buyer side (SRS §3.7, ARCH B3.4). Built so far: b1 to b11, Leakage, Dock rejected, Lost in transit, Archived.
 * b1 Viewing → b2 Inquiry (he wants it) → b3 Pending seller → b4 Send confirmation (the seller has answered)
 * → b5 Buyer's call (the offer was sent to him) → b6 Order confirmed (he said yes: sales order raised)
 * → b7 Paid (Accounts confirmed payment in full: the purchase order went to the seller)
 * → b8 Billing (B8_BILLED: the dock checked the goods; Accounts keys the Marg bill, Logistics puts it on a trip)
 * → b9 Dispatched (B9_DISPATCH: proof of dispatch recorded; the 7-day delivery window runs)
 * → b10 Delivered (Sales confirmed delivery, or the 7-day window passed in silence)
 * → b11 Complaints (the buyer complained within the window; the Controller decides what to do, then it is b10 again).
 * X_LEAKAGE = the buyer said no, or dropped the order before paying; Sales may reopen it (back to b2).
 * X_DOCK_REJECTED = the dock accepted none of the goods (LOCK-40 O4); the buyer is owed a refund; Sales may reopen.
 * X_LOST_IN_TRANSIT = the goods never reached the dock and the Controller closed the shipment (LOCK-40 O8); the buyer is
 *   owed a full refund; Sales may reopen.
 * X_ARCHIVED = a b1 viewing nobody touched for B1_ARCHIVE_DAYS; the system closed it. Sales opens a fresh one from the board.
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
    'B9_DISPATCH',
    'B10_DELIVERED',
    'B11_COMPLAINTS',
    'X_LEAKAGE',
    'X_DOCK_REJECTED',
    'X_LOST_IN_TRANSIT',
    'X_ARCHIVED',
];
/**
 * Where a trade stands on the seller side. s0 = Purchase must find a seller (the item is not listed);
 * s1 = waiting for the seller to confirm (or the seller has confirmed and the buyer is deciding);
 * s2 = the buyer said yes: the seller holds the stock until the buyer pays;
 * s3 = the buyer paid in full: the purchase order is with the seller, who must dispatch;
 * s5 = dispatched: on the way to the Indore dock (S5_DISPATCHED), then at the dock waiting to be checked
 *      (S5_ARRIVED; the design has one s5, split here so the dock's two steps are clear);
 * s6 = the dock checked the goods: the seller is to be paid for what was accepted (payouts come later);
 * S_RELEASED = the buyer did not take it: the seller may sell the stock to someone else;
 * S_CLOSED = the seller side is over: the dock accepted nothing (LOCK-40 O4), or the seller has been paid.
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
];
/** LISTED = the buyer picked a listing on the rate board. NOT_LISTED = Sales asked for something not on the board. */
export const TRADE_SOURCES = ['LISTED', 'NOT_LISTED'];
/** Why a buyer asks for something that is not on the board (ARCH B4, DemandReasonCode). */
export const ASK_REASONS = [
    'NO_STOCK_LISTED',
    'RATE_ABOVE_MARKET',
    'CONDITION_MISMATCH',
    'OTHER',
];
/** How the seller's answer was given: CONFIRMED a listing, or QUOTED for an item that was not listed. */
export const SELLER_ANSWER_KINDS = ['CONFIRMED', 'QUOTED'];
/** Why a seller said no at s1. OTHER needs a note. */
export const DECLINE_REASONS = ['NO_STOCK', 'RATE_CHANGED', 'EXPIRY_TOO_SHORT', 'OTHER'];
/** A sales order waits for the buyer's payment, is paid, or was cancelled (the buyer dropped it). */
/**
 * A sales order: AWAITING_PAYMENT → PAID (Gate A) → BILLED (Marg bill keyed) → DISPATCHED (proof of dispatch)
 * → DELIVERED; or CANCELLED (the buyer dropped it before paying).
 */
export const SALES_ORDER_STATUSES = [
    'AWAITING_PAYMENT',
    'PAID',
    'BILLED',
    'DISPATCHED',
    'DELIVERED',
    'CANCELLED',
];
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
];
/**
 * Kinds of voucher and their number series (SRS-ACC-01): RECEIPT (RV-26-0001, a buyer's payment), PURCHASE
 * (PV-26-0001, goods accepted at the dock), SALES (SV-26-0001, the Marg bill to the buyer), PAYMENT (PY-26-0001, a
 * seller or a refund paid), JOURNAL (JV-26-0001, a complaint's credit note or an approved journal / opening balance)
 * and REVERSAL (RX-26-0001, the exact mirror of a voucher it undoes).
 */
export const VOUCHER_TYPES = [
    'RECEIPT',
    'SALES',
    'PURCHASE',
    'PAYMENT',
    'JOURNAL',
    'REVERSAL',
];
/** What a voucher was posted for (its `source.type`): one automatic voucher per source. */
export const VOUCHER_SOURCE_TYPES = [
    'RECEIPT',
    'INSPECTION',
    'MARG_BILL',
    'PAYOUT_LINE',
    'COMPLAINT',
    /** A hand-made journal or an opening balance, after a different person approved it (Build 9). */
    'JOURNAL',
    /** A REVERSAL voucher: the source is the voucher it undoes (Build 9). */
    'VOUCHER',
];
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
];
/** A bank ledger is a current account or a UPI collection account. */
export const BANK_KINDS = ['CURRENT', 'UPI'];
/**
 * A payment a buyer says he made (an "Upcoming payment", SRS-PAY-01): LOGGED by Sales, then POSTED by Accounts
 * (the RECEIPT voucher is written) or REJECTED (not found in the bank).
 */
export const RECEIPT_STATUSES = ['LOGGED', 'POSTED', 'REJECTED', 'REVERSED'];
/**
 * Where a payment came from (SRS-PAY-01): SALES_ENTRY = Sales entered it against an order at b6; HAND_ADDED = Accounts
 * added money that reached the bank with no order (an advance on the buyer's account, Build 9). A POSTED payment can
 * also be REVERSED (a wrong hand-added one, by the Controller, Founder or Admin).
 */
export const RECEIPT_SOURCES = ['SALES_ENTRY', 'HAND_ADDED'];
/**
 * A journal (JNL-26-0001): lines typed by hand. Accounts types it (PENDING_APPROVAL), a different person approves it
 * (POSTED: the JV voucher is written) or rejects it (REJECTED), the maker may CANCEL it while it waits, and a posted
 * one can be REVERSED by the Controller, Founder or Admin. `kind` OPENING is a set of opening balances (SRS-ACC-05).
 */
export const JOURNAL_KINDS = ['JOURNAL', 'OPENING'];
export const JOURNAL_STATUSES = [
    'PENDING_APPROVAL',
    'POSTED',
    'REJECTED',
    'CANCELLED',
    'REVERSED',
];
/** Groups a person may add ledgers to by hand. Buyers, sellers and bank accounts get theirs from their own screens. */
export const HAND_LEDGER_GROUPS = [
    'Direct Expenses',
    'Indirect Expenses',
    'Indirect Income',
    'Duties & Taxes',
    'Capital',
    'Loans',
    'Cash',
];
/** Bank reconciliation of one bank ledger on one day (SRS-PAY-05): OPEN while it differs, RECONCILED when it matches. */
export const BANK_RECONCILIATION_STATUSES = ['OPEN', 'RECONCILED'];
/**
 * A purchase order: RAISED at Gate A → DISPATCHED (Purchase recorded leg 1) → ARRIVED (at the Indore dock)
 * → CHECKED (the dock accepted some or all of it: Gate B) or REJECTED (the dock accepted nothing, O4).
 * LOST = the Controller closed it as lost in transit (O8): it never arrived.
 */
export const PURCHASE_ORDER_STATUSES = [
    'RAISED',
    'DISPATCHED',
    'ARRIVED',
    'CHECKED',
    'REJECTED',
    'LOST',
];
/** How the seller sent the goods to Indore (leg 1): by a transport company, by bus parcel, or from a depot. */
export const LEG1_MODES = ['TRANSPORT', 'BUS', 'DEPOT'];
/** Freight on leg 1: the seller PAID it, or it is TO_PAY at Indore (later taken off the seller's payout). */
export const FREIGHT_TERMS = ['PAID', 'TO_PAY'];
/**
 * The result of a dock check (LOCK-40 A2). O1 all accepted · O2 some damaged or leaking · O3 some boxes short ·
 * O4 nothing accepted · O5 extra boxes came. When several apply, the first of O4, O2, O3, O5 is the outcome.
 */
export const INSPECTION_OUTCOMES = ['O1', 'O2', 'O3', 'O4', 'O5'];
/** A return note sends boxes back to the seller: REJECTED (damaged or leaking) or EXCESS (more than ordered). */
export const RETURN_NOTE_TYPES = ['REJECTED', 'EXCESS'];
/** A return note is OPEN until closed; a dock correction before it was closed makes it CANCELLED (Build 9). */
export const RETURN_NOTE_STATES = ['OPEN', 'CLOSED', 'CANCELLED'];
/** How a return note was closed. It is never written off (L40.7). */
export const RETURN_CLOSURES = ['PICKED_UP', 'SHIPPED_BACK', 'DISPOSED'];
/** A trip (leg 2): PLANNED (bills being added) → OUT (checked out of the dock) → CLOSED (every bill has a POD). */
export const TRIP_STATUSES = ['PLANNED', 'OUT', 'CLOSED'];
/**
 * How a bill on a trip goes on from our vehicle: booked with a TRANSPORT company, sent as a BUS parcel, or taken
 * DIRECT to the buyer by our vehicle.
 */
export const BOOK_WITH_MODES = ['TRANSPORT', 'BUS', 'DIRECT'];
/**
 * A refund owed to a buyer: DUE, then PAID when its payout line gets the bank proof (Build 5). CANCELLED = a dock
 * correction replaced it before it was paid (Build 9).
 */
export const REFUND_STATUSES = ['DUE', 'PAID', 'CANCELLED'];
/**
 * A payout batch (PAYB-26-0001): Accounts builds it (DRAFT), Founder or Admin releases it (RELEASED; someone other
 * than the builder, after re-typing the password), or the builder cancels it while still DRAFT (CANCELLED).
 */
export const PAYOUT_BATCH_STATUSES = ['DRAFT', 'RELEASED', 'CANCELLED'];
/** A line pays a SELLER for a checked PO (PAYOUT) or gives a BUYER a refund back (REFUND). */
export const PAYOUT_LINE_TYPES = ['PAYOUT', 'REFUND'];
/** A line: DRAFT → PROOF_PENDING (batch released: pay at the bank) → PAID (the UTR is typed: Q-ACC-11). */
export const PAYOUT_LINE_STATUSES = ['DRAFT', 'PROOF_PENDING', 'PAID'];
/** What a buyer complains about (ARCH ComplaintCategory). */
export const COMPLAINT_CATEGORIES = [
    'DAMAGE_ON_ARRIVAL',
    'SHORTAGE',
    'WRONG_ITEM',
    'QUALITY_COMPLAINT',
    'OTHER',
];
/** A complaint is OPEN until the Controller resolves it with an outcome. */
export const COMPLAINT_STATUSES = ['OPEN', 'RESOLVED'];
/**
 * What the Controller decides (SRS §6.4, Q-SAL-05 default). NO_ACTION: the complaint is not accepted. CREDIT: an
 * amount is credited to the buyer's account. REFUND: boxes are paid back through a payout batch. REPLACEMENT and
 * RETURN: recorded for the desks to act on (the stock side of both comes with a later build).
 */
export const COMPLAINT_OUTCOMES = [
    'NO_ACTION',
    'CREDIT',
    'REPLACEMENT',
    'RETURN',
    'REFUND',
];
/** The system's own jobs that keep a log (Build 8). The nightly integrity check is the first. */
export const JOB_NAMES = ['INTEGRITY_CHECK'];
/** SCHEDULE = the nightly timer ran it; MANUAL = a person pressed "Run now". */
export const JOB_TRIGGERS = ['SCHEDULE', 'MANUAL'];
/** OK = nothing found. FINDINGS = the check ran and found problems. FAILED = the check itself crashed. */
export const JOB_RUN_STATUSES = ['OK', 'FINDINGS', 'FAILED'];
/** The four groups of integrity checks (ARCH §4.6). */
export const INTEGRITY_CHECKS = [
    'ORPHAN_REFERENCE',
    'TOTAL_MISMATCH',
    'TRIAL_BALANCE',
    'VOUCHER_SOURCE',
];
//# sourceMappingURL=enums.js.map