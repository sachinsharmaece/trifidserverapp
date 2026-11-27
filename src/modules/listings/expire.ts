import { ListingModel, SellerModel } from '../../models/index.js';

/**
 * Marks every live or paused listing whose time is up as EXPIRED (it stays in the list, but is no longer offered).
 * There is no daily job yet, so the listings API calls this whenever it is used. A scheduled job (SRS `expireListings`,
 * 00:15 IST) can call the same function later.
 *
 * Reference FAST-ORDER L42.4: an expired listing's auto-confirm turns off (reason AUTO_EXPIRED), except TriFid Stock's.
 */
export async function expireOldListings(now = new Date()): Promise<void> {
  const house = await SellerModel.findOne({ isHouse: true });
  await ListingModel.updateMany(
    {
      status: { $in: ['ACTIVE', 'PAUSED'] },
      expiresAt: { $lte: now },
      autoConfirm: true,
      ...(house ? { sellerId: { $ne: house._id } } : {}),
    },
    { autoConfirm: false, autoBoxesLeft: 0, autoOffReason: 'AUTO_EXPIRED', autoOffAt: now },
  );
  await ListingModel.updateMany(
    { status: { $in: ['ACTIVE', 'PAUSED'] }, expiresAt: { $lte: now } },
    { status: 'EXPIRED' },
  );
}
