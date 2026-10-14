import { Tehsil } from '../../models/Tehsil.js';
import { Seller } from '../../models/Seller.js';
import { SellerArea } from '../../models/SellerArea.js';
import { SellerBlock } from '../../models/SellerBlock.js';
import { AppError } from '../../shared/errors.js';
export async function listTehsils(district) {
    const query = district ? { district } : {};
    const tehsils = await Tehsil.find(query).sort({ district: 1, name: 1 });
    return tehsils.map((tehsil) => ({
        tehsilId: tehsil._id.toString(),
        name: tehsil.name,
        district: tehsil.district,
        state: tehsil.state,
    }));
}
// B-52 — "ujjain" and "Ujjain" kept reading as two different tehsils to
// anything grouping on the raw string, because nothing normalised the name
// at write time; a display-only fix would leave every existing grouping
// (visibility resolver, coverage map) still seeing two. Title-cased,
// trimmed, once, here, rather than at every reader.
function toTitleCase(value) {
    return value
        .trim()
        .split(/\s+/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}
export async function createTehsil(name, district, state) {
    const normalizedName = toTitleCase(name);
    const normalizedDistrict = toTitleCase(district);
    const normalizedState = toTitleCase(state);
    // B-54's duplicate backstop, made case-insensitive rather than exact-match
    // only — the same reasoning as B-52, since a same-name-different-case
    // tehsil is exactly the duplicate this is meant to catch.
    const existing = await Tehsil.findOne({
        name: normalizedName,
        district: normalizedDistrict,
    }).collation({ locale: 'en', strength: 2 });
    if (existing) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: `${normalizedName} already exists in ${normalizedDistrict}.`,
            field: 'name',
        });
    }
    const tehsil = await Tehsil.create({
        name: normalizedName,
        district: normalizedDistrict,
        state: normalizedState,
    });
    return { tehsilId: tehsil._id.toString() };
}
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
