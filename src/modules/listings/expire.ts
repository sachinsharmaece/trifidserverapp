import { ListingModel } from '../../models/index.js';

/**
 * Marks every live or paused listing whose time is up as EXPIRED (it stays in the list, but is no longer offered).
 * There is no daily job yet, so the listings API calls this whenever it is used. A scheduled job (SRS `expireListings`,
 * 00:15 IST) can call the same function later.
 */
export async function expireOldListings(now = new Date()): Promise<void> {
  await ListingModel.updateMany(
    { status: { $in: ['ACTIVE', 'PAUSED'] }, expiresAt: { $lte: now } },
    { status: 'EXPIRED' },
  );
}
