import { requireRole } from '../auth/requireRole.js';

/**
 * Anyone signed in may READ the masters (every desk needs them for dropdowns).
 * Only these roles may CHANGE them. Use it after requireAuth:
 *   router.post('/manufacturers', requireAuth, canEditMasters, handler);
 */
export const canEditMasters = requireRole('FOUNDER', 'ADMIN');
