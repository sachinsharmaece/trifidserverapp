import { Buyer } from '../src/models/Buyer.js';
import { PileRequest } from '../src/models/PileRequest.js';
import { acceptPileOffer, declinePileOffer } from '../src/modules/demand/pileOffer.service.js';

/**
 * BR-378 — a confirmed pile gives each buyer on it his deal rather than an order. These take them
 * the way the buyers would, so a test that wants the orders (and their payment windows) can have
 * them after `runConfirmPileFanout`.
 */
async function buyerCounterpartyOf(buyerId: unknown): Promise<string> {
  const buyer = await Buyer.findById(buyerId);
  return String(buyer!.counterpartyId);
}

const actorOf = (counterpartyId: string) => ({
  actorId: counterpartyId,
  actorType: 'counterparty' as const,
  correlationId: 'test-pile-offer',
});

/** Every deal waiting on this pile is taken; returns the ids of the orders made. */
export async function acceptOffers(pileId: string): Promise<string[]> {
  const soIds: string[] = [];
  for (const request of await PileRequest.find({ pileId, offerState: 'offered' }).sort({
    requestedAt: 1,
  })) {
    const cp = await buyerCounterpartyOf(request.buyerId);
    const { soId } = await acceptPileOffer(String(request._id), cp, actorOf(cp));
    soIds.push(soId);
  }
  return soIds;
}

export async function acceptOffer(requestId: string, buyerId: unknown): Promise<{ soId: string }> {
  const cp = await buyerCounterpartyOf(buyerId);
  return acceptPileOffer(requestId, cp, actorOf(cp));
}

export async function declineOffer(requestId: string, buyerId: unknown): Promise<void> {
  const cp = await buyerCounterpartyOf(buyerId);
  await declinePileOffer(requestId, cp, actorOf(cp));
}
