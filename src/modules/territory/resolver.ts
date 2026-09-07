/**
 * BR-088 / WF-03 — the one visibility resolver. A single, pure function.
 * The feed, search, inquiry routing, pool join and direct link all call this
 * exact function unchanged — nothing else implements this logic anywhere in
 * the codebase (`CH §3.11`).
 *
 * It takes the listing's frozen tehsil set as a plain array rather than a
 * `Listing` document on purpose: no `Listing` model exists yet (that is
 * M5), and the resolver has no business knowing where the array came from.
 * Whoever calls this later supplies it.
 */

export interface ResolverListingInput {
  sellerId: string;
  frozenTehsilIds: string[];
}

export interface ResolverBuyerInput {
  gstin: string;
  tehsilId: string;
  counterpartyId: string;
}

// Returns true if this GSTIN is on the seller's active block list.
export type SellerBlockLookup = (gstin: string) => boolean;

// BR-092 — a counterparty must never resolve as visible to itself. A firm
// whose kind is 'both' is both parties' counterpartyId being the same value.
function isSelfDealing(sellerId: string, buyerCounterpartyId: string): boolean {
  return sellerId === buyerCounterpartyId;
}

export function resolveVisibility(
  input: ResolverListingInput,
  buyer: ResolverBuyerInput,
  sellerBlocks: SellerBlockLookup,
): boolean {
  if (isSelfDealing(input.sellerId, buyer.counterpartyId)) return false;
  if (sellerBlocks(buyer.gstin)) return false;
  if (!input.frozenTehsilIds.includes(buyer.tehsilId)) return false;
  return true;
}
