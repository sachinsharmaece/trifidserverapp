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
 * Where a trade stands on the buyer side (SRS §3.7, ARCH B3.4). Built so far: b1 to b6, and Leakage.
 * b1 Viewing → b2 Inquiry (he wants it) → b3 Pending seller → b4 Send confirmation (the seller has answered)
 * → b5 Buyer's call (the offer was sent to him) → b6 Order confirmed (he said yes: sales order raised).
 * X_LEAKAGE = the buyer said no, or dropped the order before paying; Sales may reopen it (back to b2).
 */
export const BUYER_STAGES = [
    'B1_VIEWING',
    'B2_INQUIRY',
    'B3_PENDING_SELLER',
    'B4_SEND_CONFIRMATION',
    'B5_BUYERS_CALL',
    'B6_ORDER_CONFIRMED',
    'X_LEAKAGE',
];
/**
 * Where a trade stands on the seller side. s0 = Purchase must find a seller (the item is not listed);
 * s1 = waiting for the seller to confirm (or the seller has confirmed and the buyer is deciding);
 * s2 = the buyer said yes: the seller holds the stock until the buyer pays;
 * S_RELEASED = the buyer did not take it: the seller may sell the stock to someone else.
 */
export const SELLER_STAGES = ['S0_DEMAND', 'S1_CONFIRMATION', 'S2_HOLD', 'S_RELEASED'];
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
export const SALES_ORDER_STATUSES = ['AWAITING_PAYMENT', 'PAID', 'CANCELLED'];
//# sourceMappingURL=enums.js.map