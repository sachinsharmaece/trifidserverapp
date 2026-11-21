import { requireRole } from '../auth/requireRole.js';

/**
 * Anyone signed in may READ the masters (every desk needs them for dropdowns).
 * Only these roles may CHANGE them. Use it after requireAuth:
 *   router.post('/manufacturers', requireAuth, canEditMasters, handler);
 */
export const canEditMasters = requireRole('FOUNDER', 'ADMIN');

/**
 * The margin matrix is TriFid's own margin: Sales and Purchase must never see it, and neither may Accounts or
 * Logistics. Only these roles may read it (changing it needs canEditMasters and a step-up as well).
 */
export const canSeeMargins = requireRole('CONTROLLER', 'FOUNDER', 'ADMIN');
