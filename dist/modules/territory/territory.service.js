import { Seller } from '../../models/Seller.js';
import { SellerArea } from '../../models/SellerArea.js';
import { SellerBlock } from '../../models/SellerBlock.js';
import { AppError } from '../../shared/errors.js';
/**
 * The adapter between the database and the pure resolver (resolver.ts).
 * Nothing else builds a `SellerBlockLookup` — every M4/M5 caller of
 * `resolveVisibility` gets its lookup from here.
 */
export async function buildSellerBlockLookup(sellerId) {
    const blocks = await SellerBlock.find({ sellerId, status: 'active' }, { gstin: 1 });
    const blockedGstins = new Set(blocks.map((block) => block.gstin));
    return (gstin) => blockedGstins.has(gstin);
}
/** API-027 — "he requests, staff decide, and he can always see what applies to him." */
export async function getOwnArea(sellerCounterpartyId) {
    const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
    if (!seller) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller profile not found.' });
    }
    const areas = await SellerArea.find({ sellerId: seller._id }).populate('tehsilId');
    const tehsils = areas
        .map((area) => area.tehsilId)
        .filter((tehsil) => tehsil !== null)
        .map((tehsil) => ({
        tehsilId: tehsil._id.toString(),
        name: tehsil.name,
        district: tehsil.district,
        state: tehsil.state,
    }));
    return { tehsils, dispatchCutoffTime: seller.dispatchCutoffTime };
}
