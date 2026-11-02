import { Buyer } from '../../models/Buyer.js';
import { Pool, buildConditionSetKey } from '../../models/Pool.js';
import { Sku } from '../../models/Sku.js';
import { AppError } from '../../shared/errors.js';
import { assertValidObjectId } from '../../shared/objectId.js';
import * as listingService from '../listing/listing.service.js';
import { commitToPool } from '../pool/pool.service.js';

/**
 * 29 Oct — a product that is listed goes to Purchase → Confirmations, one that is not goes to
 * Purchase → Demand. When the buyer on the phone wants something already on his board, Sales
 * puts him on that offer exactly as his own Buy button would: a pile request on the line (the
 * seller then confirms, requotes or declines), or — when he wants fewer boxes than the
 * seller's minimum order — a place in the pool for that offer. Only something not on his
 * board becomes an ask.
 */
export type WantsItResult =
  | { kind: 'pile'; pileId: string; listingLineId: string }
  | { kind: 'pool'; poolId: string; listingLineId: string };

export async function placeOnListedOffer(
  buyerCounterpartyId: string,
  listingLineId: string,
  input: { qty: number; deliveryLocationId?: string; raisedBy: string },
): Promise<WantsItResult> {
  assertValidObjectId(listingLineId, 'listingLineId');
  const { line } = await listingService.requireLineVisibleToBuyer(
    buyerCounterpartyId,
    listingLineId,
  );
  // Unnamed: his primary delivery location, else his registered address (the services decide).
  const deliveryLocationId = input.deliveryLocationId;

  // Below the seller's minimum order: he joins the pool that offer opened (BR-150/BR-151).
  if (line.moqExact > 1 && input.qty < line.moqExact) {
    const pool = await Pool.findOne({
      skuId: line.skuId,
      conditionSetKey: buildConditionSetKey({
        expiryBand: line.expiryBand,
        moqBand: line.moqBand,
        deliveryBand: line.deliveryBand,
        provenance: line.provenance,
      }),
      isActive: true,
    });
    if (!pool) {
      throw new AppError({
        code: 'BELOW_MOQ',
        messageEn: `Minimum order for this offer is ${line.moqExact} boxes, and its pool is closed.`,
        field: 'qty',
      });
    }
    const { poolId } = await commitToPool(buyerCounterpartyId, String(pool._id), {
      qty: input.qty,
      ...(deliveryLocationId ? { deliveryLocationId } : {}),
    });
    return { kind: 'pool', poolId, listingLineId };
  }

  const { pileId } = await listingService.createPileRequest(
    buyerCounterpartyId,
    listingLineId,
    { qty: input.qty, ...(deliveryLocationId ? { deliveryLocationId } : {}) },
    { channel: 'sales_call', raisedBy: input.raisedBy },
  );
  return { kind: 'pile', pileId, listingLineId };
}

/**
 * The cheapest offer on his board (his own rate) for the pack named — or, when only a product is
 * named, for any of its packs. `null` when nothing listed reaches him, which makes it an ask.
 */
export async function cheapestOfferOnHisBoard(
  buyerCounterpartyId: string,
  wanted: { skuId?: string; productId?: string; allPacks?: boolean },
): Promise<string | null> {
  const buyer = await Buyer.findOne({ counterpartyId: buyerCounterpartyId }, { _id: 1 });
  if (!buyer) return null; // raiseAsk gives the proper "Buyers only." refusal.
  const board = await listingService.listPricedLinesVisibleToBuyerDoc(String(buyer._id));
  let productId = wanted.productId ?? null;
  if (wanted.allPacks && !productId && wanted.skuId) {
    const sku = await Sku.findById(wanted.skuId, { productId: 1 });
    productId = sku ? String(sku.productId) : null;
  }
  const matching = board.filter((p) =>
    wanted.skuId && !wanted.allPacks
      ? String(p.line.skuId) === wanted.skuId
      : productId !== null && String(p.listing.productId) === productId,
  );
  matching.sort((a, b) => a.buyerRatePaise - b.buyerRatePaise);
  return matching[0] ? String(matching[0].line._id) : null;
}
