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
 * Where a trade stands on the buyer side (SRS §3.7, ARCH B3.4). Built so far: b1 to b4.
 * b1 Viewing → b2 Inquiry (he wants it) → b3 Pending seller → b4 Send confirmation (the seller has answered).
 */
export const BUYER_STAGES = [
  'B1_VIEWING',
  'B2_INQUIRY',
  'B3_PENDING_SELLER',
  'B4_SEND_CONFIRMATION',
] as const;
export type BuyerStage = (typeof BUYER_STAGES)[number];

/**
 * Where a trade stands on the seller side. s0 = Purchase must find a seller (the item is not listed);
 * s1 = waiting for the seller to confirm (or the seller has confirmed and the buyer is deciding).
 */
export const SELLER_STAGES = ['S0_DEMAND', 'S1_CONFIRMATION'] as const;
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
