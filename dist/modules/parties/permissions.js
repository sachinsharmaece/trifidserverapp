import { requireRole } from '../auth/requireRole.js';
/**
 * The visibility wall (SRS §3.6.2): Sales never sees sellers, Purchase never sees buyers. Accounts and Logistics
 * see parties only inside orders (later), never these party lists. The API refuses everyone else with 403.
 *
 * Founder and Admin have every right, so both are on both sides (Q-ROL-01, decided 23 Nov 2026). The Controller
 * also sees both sides.
 *
 * These two lists are the wall for trades too (`modules/trades/view.ts`): change them here only.
 */
export const SELLER_SIDE_ROLES = ['PURCHASE', 'CONTROLLER', 'FOUNDER', 'ADMIN'];
export const BUYER_SIDE_ROLES = ['SALES', 'CONTROLLER', 'FOUNDER', 'ADMIN'];
export const canUseSellers = requireRole(...SELLER_SIDE_ROLES);
export const canUseBuyers = requireRole(...BUYER_SIDE_ROLES);
/**
 * Listings hold the seller's rate, so they sit behind the same wall as sellers: Purchase and the supervisors only.
 * Sales sees buyer rates worked out from listings (the rate board, modules/pricing), never the listings themselves.
 */
export const canUseListings = canUseSellers;
//# sourceMappingURL=permissions.js.map