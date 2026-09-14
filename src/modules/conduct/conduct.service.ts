import type { Types } from 'mongoose';
import { Buyer } from '../../models/Buyer.js';
import { Seller } from '../../models/Seller.js';
import { Po } from '../../models/Po.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';

const RATE_VIEW_DESK_CALL_THRESHOLD = 25; // BR-130.

export interface BuyerConductDto {
  rateViews: number;
  rateViewThreshold: number;
  // BR-213's warning → cure → strike → appeal → revision ladder has no
  // producer anywhere in this codebase yet (no Strike model, no job walks
  // it) — reported honestly as zero/none rather than a fabricated history.
  // Still open per QUESTION_REGISTER.md QR-025 (appeal destination) and
  // DECISION_LOG.md DEC-040.
  strikeCount: 0;
  blacklisted: boolean;
}

/** API-110 GET. */
export async function getBuyerConduct(buyerCounterpartyId: string): Promise<BuyerConductDto> {
  const buyer = await Buyer.findOne({ counterpartyId: buyerCounterpartyId });
  if (!buyer) throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Buyers only.' });
  return {
    rateViews: buyer.rateViews,
    rateViewThreshold: RATE_VIEW_DESK_CALL_THRESHOLD,
    strikeCount: 0,
    blacklisted: false,
  };
}

/**
 * API-110 POST disagree. QR-025 leaves the appeal destination open, so this
 * records the disagreement (a human can read the audit trail) rather than
 * routing it anywhere — there is nowhere defined to route it to yet.
 */
export async function disagreeWithConduct(
  buyerCounterpartyId: string,
  conductRefId: string,
  reason: string,
  correlationId: string,
): Promise<{ recorded: true }> {
  const buyer = await Buyer.findOne({ counterpartyId: buyerCounterpartyId });
  if (!buyer) throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Buyers only.' });
  await writeAuditLog({
    actorId: (buyer._id as Types.ObjectId).toString(),
    actorType: 'counterparty',
    entity: 'conduct',
    entityId: conductRefId,
    field: 'disagree',
    reason,
    correlationId,
  });
  return { recorded: true };
}

export interface SellerScorecardDto {
  trustTier: string;
  suppliesCompleted: number;
  poCount: number;
  failedCount: number;
  requoteTotal: number;
}

/** API-111. Real aggregates only — no fabricated grade or star rating. */
export async function getSellerScorecard(sellerCounterpartyId: string): Promise<SellerScorecardDto> {
  const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
  if (!seller) throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Sellers only.' });
  const pos = await Po.find({ sellerId: seller._id });
  return {
    trustTier: seller.trustTier,
    suppliesCompleted: seller.suppliesCompleted,
    poCount: pos.length,
    failedCount: pos.filter((p) => p.failed).length,
    requoteTotal: pos.reduce((sum, p) => sum + p.requoteCount, 0),
  };
}
