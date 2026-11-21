import { createHash } from 'node:crypto';
import type { ExpiryBand, ListingRateType, Provenance } from '../../shared/enums.js';

/** The small calculations behind a listing, kept apart from the routes so they are easy to read and test. */

/** EX offer: the landed rate per unit is the Ex rate plus the carriage cost of a box shared over its units. */
export function landedRate(
  exRatePaisePerUnit: number,
  colPaisePerBox: number,
  unitsPerBox: number,
): number {
  return exRatePaisePerUnit + Math.round(colPaisePerBox / unitsPerBox);
}

/** True when the new rate is more than `limitBp` basis points below the old one (200 = 2%). Exact, no rounding. */
export function dropExceeds(previousPaise: number, newPaise: number, limitBp: number): boolean {
  return (previousPaise - newPaise) * 10_000 > limitBp * previousPaise;
}

/** How far the new rate is below the old one, in basis points (200 = 2%), rounded. Only for showing to people. */
export function dropInBp(previousPaise: number, newPaise: number): number {
  return Math.round(((previousPaise - newPaise) * 10_000) / previousPaise);
}

export interface OfferKey {
  sellerId: string;
  skuId: string;
  rateType: ListingRateType;
  ratePaisePerUnit: number;
  expiryBand: ExpiryBand;
  moqBoxes: number;
  provenance: Provenance;
}

/** Same seller, pack, rate type, landed rate, band, MOQ and provenance give the same key. */
export function dedupeKeyOf(offer: OfferKey): string {
  const parts = [
    offer.sellerId,
    offer.skuId,
    offer.rateType,
    offer.ratePaisePerUnit,
    offer.expiryBand,
    offer.moqBoxes,
    offer.provenance,
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}
