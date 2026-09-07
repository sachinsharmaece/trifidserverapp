import type { Types } from 'mongoose';
import { Counterparty } from '../../models/Counterparty.js';
import { Seller } from '../../models/Seller.js';
import { SellerBlock } from '../../models/SellerBlock.js';
import { AppError } from '../../shared/errors.js';
import { bumpCounter } from '../../middleware/rateLimit.js';
import { logger } from '../../shared/logger.js';

const EXCLUSION_CAP = 20;

async function getSellerOrThrow(sellerCounterpartyId: string) {
  const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
  if (!seller) {
    throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Sellers only.' });
  }
  return seller;
}

function maskFirmName(firm: string): string {
  return firm
    .split(' ')
    .map((word) => (word.length > 0 ? `${word[0]}${'*'.repeat(word.length - 1)}` : word))
    .join(' ');
}

/**
 * API-120. BR-089 — "a GSTIN-enumeration oracle." Hard rate limit, every
 * call logged, burst alerting. There is no name search anywhere near this.
 */
export async function lookupGstin(
  gstin: string,
  sellerCounterpartyId: string,
  ip: string,
): Promise<{ exists: boolean; maskedFirm?: string }> {
  const perSeller = await bumpCounter(`exclusion-lookup:seller:${sellerCounterpartyId}`, 60 * 60);
  const perIp = await bumpCounter(`exclusion-lookup:ip:${ip}`, 60 * 60);
  logger.info({ msg: 'exclusion GSTIN lookup', sellerCounterpartyId, gstin, perSeller, perIp });
  if (perSeller > 30 || perIp > 60) {
    logger.warn({ msg: 'exclusion lookup burst', sellerCounterpartyId, ip, perSeller, perIp });
    throw new AppError({ code: 'RATE_LIMITED', messageEn: 'Too many lookups. Try again later.' });
  }

  const counterparty = await Counterparty.findOne({ gstin, deletedAt: null });
  if (!counterparty || !counterparty.firm) {
    return { exists: false };
  }
  return { exists: true, maskedFirm: maskFirmName(counterparty.firm) };
}

interface ExclusionListItem {
  exclusionId: string;
  gstin: string;
  addedAt: Date;
  status: string;
}

export async function listExclusions(sellerCounterpartyId: string): Promise<ExclusionListItem[]> {
  const seller = await getSellerOrThrow(sellerCounterpartyId);
  const blocks = await SellerBlock.find({ sellerId: seller._id, status: 'active' }).sort({
    addedAt: -1,
  });
  return blocks.map((block) => ({
    exclusionId: (block._id as Types.ObjectId).toString(),
    gstin: block.gstin,
    addedAt: block.addedAt,
    status: block.status,
  }));
}

/**
 * API-121 POST. BR-089 cap 20. BR-090 — no reason is ever stored.
 *
 * DATA_MODEL.md ENT-08 names this field `addedByStaffId`, but API_CONTRACT
 * §9 marks the endpoint 👤S — this is genuinely self-service by the seller
 * (BR-089: "he types his initials to confirm"), not a staff action. The
 * field is kept as specified and populated with the seller's own actor id;
 * flagged as a naming inconsistency worth resolving (see QUESTION_REGISTER).
 */
export async function createExclusion(
  sellerCounterpartyId: string,
  gstin: string,
): Promise<{ exclusionId: string }> {
  const seller = await getSellerOrThrow(sellerCounterpartyId);

  const activeCount = await SellerBlock.countDocuments({ sellerId: seller._id, status: 'active' });
  if (activeCount >= EXCLUSION_CAP) {
    throw new AppError({
      code: 'EXCLUSION_CAP_REACHED',
      messageEn: `You can block at most ${EXCLUSION_CAP} GSTINs.`,
    });
  }

  const existing = await SellerBlock.findOne({ sellerId: seller._id, gstin });
  if (existing) {
    if (existing.status === 'active') {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: 'This GSTIN is already blocked.',
      });
    }
    existing.status = 'active';
    existing.addedAt = new Date();
    existing.addedByStaffId = seller.counterpartyId as unknown as Types.ObjectId;
    await existing.save();
    return { exclusionId: (existing._id as Types.ObjectId).toString() };
  }

  const block = await SellerBlock.create({
    sellerId: seller._id,
    gstin,
    addedByStaffId: seller.counterpartyId,
    addedAt: new Date(),
    status: 'active',
  });
  return { exclusionId: (block._id as Types.ObjectId).toString() };
}

/** API-121 DELETE — soft: flips status rather than deleting the row. */
export async function removeExclusion(
  sellerCounterpartyId: string,
  exclusionId: string,
): Promise<void> {
  const seller = await getSellerOrThrow(sellerCounterpartyId);
  const block = await SellerBlock.findOne({ _id: exclusionId, sellerId: seller._id });
  if (!block) {
    throw new AppError({ code: 'NOT_VISIBLE', messageEn: 'Not found.' });
  }
  block.status = 'removed';
  await block.save();
}
