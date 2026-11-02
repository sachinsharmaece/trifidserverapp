import { So } from '../models/So.js';
import { Ask } from '../models/Ask.js';
import { Quote } from '../models/Quote.js';
import { Po } from '../models/Po.js';
import { Pile } from '../models/Pile.js';
import { ListingLine } from '../models/ListingLine.js';
import { Listing } from '../models/Listing.js';
/**
 * Phase 5 — find the one buyer or seller a route acts on when the route
 * names something of his (an order, an ask, a PO) rather than him. Each
 * returns null when the record does not exist, so the route's own "not
 * found" still answers.
 */
const objectIdParam = (req, name) => {
    const value = req.params[name];
    return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value) ? value : null;
};
export const buyerOfOrder = (name = 'soId') => async (req) => {
    const soId = objectIdParam(req, name);
    const so = soId ? await So.findById(soId, { buyerId: 1 }) : null;
    return so ? { profileId: String(so.buyerId) } : null;
};
export const buyerOfAsk = (name = 'askId') => async (req) => {
    const askId = objectIdParam(req, name);
    const ask = askId ? await Ask.findById(askId, { buyerId: 1 }) : null;
    return ask ? { profileId: String(ask.buyerId) } : null;
};
export const buyerOfQuote = (name = 'quoteId') => async (req) => {
    const quoteId = objectIdParam(req, name);
    const quote = quoteId ? await Quote.findById(quoteId, { askId: 1 }) : null;
    const ask = quote?.askId ? await Ask.findById(quote.askId, { buyerId: 1 }) : null;
    return ask ? { profileId: String(ask.buyerId) } : null;
};
export const sellerOfPo = (name = 'poId') => async (req) => {
    const poId = objectIdParam(req, name);
    const po = poId ? await Po.findById(poId, { sellerId: 1 }) : null;
    return po ? { profileId: String(po.sellerId) } : null;
};
export const sellerOfPile = (name = 'pileId') => async (req) => {
    // A pile hangs off a listing line, which belongs to one seller's listing.
    const pileId = objectIdParam(req, name);
    const pile = pileId ? await Pile.findById(pileId, { listingLineId: 1 }) : null;
    const line = pile ? await ListingLine.findById(pile.listingLineId, { listingId: 1 }) : null;
    const listing = line ? await Listing.findById(line.listingId, { sellerId: 1 }) : null;
    return listing ? { profileId: String(listing.sellerId) } : null;
};
