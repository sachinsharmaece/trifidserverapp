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
