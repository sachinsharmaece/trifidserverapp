import type { Types } from 'mongoose';
import { Tehsil } from '../../models/Tehsil.js';
import { Seller } from '../../models/Seller.js';
import { SellerArea } from '../../models/SellerArea.js';
import { SellerBlock } from '../../models/SellerBlock.js';
import { AppError } from '../../shared/errors.js';
import type { SellerBlockLookup } from './resolver.js';

export async function listTehsils(
  district?: string,
): Promise<Array<{ tehsilId: string; name: string; district: string; state: string }>> {
  const query = district ? { district } : {};
  const tehsils = await Tehsil.find(query).sort({ district: 1, name: 1 });
  return tehsils.map((tehsil) => ({
    tehsilId: (tehsil._id as Types.ObjectId).toString(),
    name: tehsil.name,
    district: tehsil.district,
    state: tehsil.state,
  }));
}

export async function createTehsil(
  name: string,
  district: string,
  state: string,
): Promise<{ tehsilId: string }> {
  const existing = await Tehsil.findOne({ name, district });
  if (existing) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: `${name} already exists in ${district}.`,
      field: 'name',
    });
  }
  const tehsil = await Tehsil.create({ name, district, state });
  return { tehsilId: (tehsil._id as Types.ObjectId).toString() };
}

/**
 * The adapter between the database and the pure resolver (resolver.ts).
 * Nothing else builds a `SellerBlockLookup` — every M4/M5 caller of
 * `resolveVisibility` gets its lookup from here.
 */
export async function buildSellerBlockLookup(sellerId: string): Promise<SellerBlockLookup> {
  const blocks = await SellerBlock.find({ sellerId, status: 'active' }, { gstin: 1 });
  const blockedGstins = new Set(blocks.map((block) => block.gstin));
  return (gstin: string) => blockedGstins.has(gstin);
}

/** API-027 — "he requests, staff decide, and he can always see what applies to him." */
export async function getOwnArea(sellerCounterpartyId: string): Promise<{
  tehsils: Array<{ tehsilId: string; name: string; district: string; state: string }>;
  dispatchCutoffTime: string;
}> {
  const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
  if (!seller) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller profile not found.' });
  }
  const areas = await SellerArea.find({ sellerId: seller._id }).populate('tehsilId');
  const tehsils = areas
    .map(
      (area) =>
        area.tehsilId as unknown as {
          _id: Types.ObjectId;
          name: string;
          district: string;
          state: string;
        } | null,
    )
    .filter(
      (tehsil): tehsil is { _id: Types.ObjectId; name: string; district: string; state: string } =>
        tehsil !== null,
    )
    .map((tehsil) => ({
      tehsilId: tehsil._id.toString(),
      name: tehsil.name,
      district: tehsil.district,
      state: tehsil.state,
    }));
  return { tehsils, dispatchCutoffTime: seller.dispatchCutoffTime };
}
