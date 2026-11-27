import { requireRole } from '../auth/requireRole.js';

/**
 * Anyone signed in may READ the masters (every desk needs them for dropdowns).
 * Only these roles may CHANGE them (reference-copy branch: Admin, Controller and Founder, as the reference's
 * MASTERS_EDIT_ROLES). Use it after requireAuth:
 *   router.post('/manufacturers', requireAuth, canEditMasters, handler);
 */
export const canEditMasters = requireRole('ADMIN', 'CONTROLLER', 'FOUNDER');

/**
 * The margin matrix is buyer-pricing information. As in the reference (BUYER_VISIBLE_ROLES), Admin, Sales,
 * Controller and Founder may read it; Purchase, Accounts and Logistics never. Changing it needs canEditMasters.
 */
export const canSeeMargins = requireRole('ADMIN', 'SALES', 'CONTROLLER', 'FOUNDER');
