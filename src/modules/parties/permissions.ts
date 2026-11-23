import { requireRole } from '../auth/requireRole.js';

/**
 * The visibility wall (SRS §3.6.2): Sales never sees sellers, Purchase never sees buyers. Accounts and Logistics
 * see parties only inside orders (later), never these party lists. The API refuses everyone else with 403.
 *
 * Admin is allowed on both because the prototype lets Admin see everything; whether Admin should be limited to
 * masters and settings is an open client question (Q-ROL-01). If the answer is "limit Admin", delete 'ADMIN' here.
 */
export const canUseSellers = requireRole('PURCHASE', 'CONTROLLER', 'FOUNDER', 'ADMIN');
export const canUseBuyers = requireRole('SALES', 'CONTROLLER', 'FOUNDER', 'ADMIN');

/**
 * Listings hold the seller's rate, so they sit behind the same wall as sellers: Purchase and the supervisors only.
 * Sales sees buyer rates worked out from listings (the rate board, modules/pricing), never the listings themselves.
 */
export const canUseListings = canUseSellers;
