import * as listingService from './listing.service.js';
import { changeListingLineRateSchema, createListingSchema, inquireSchema, } from './listing.validation.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
function sellerActor(req) {
    return { employeeId: req.auth.counterpartyId, correlationId: req.correlationId };
}
// API-030 — 👤B. The resolver runs here; no client-supplied scope accepted.
export async function getFeed(req, res) {
    const { cursor, limit } = req.validatedQuery;
    const result = await listingService.getBuyerFeed(req.auth.counterpartyId, cursor ?? 0, limit ?? 20);
    res.status(200).json({
        data: result.items,
        meta: { correlationId: req.correlationId, nextCursor: result.nextCursor },
    });
}
// API-031 — 👤B.
export async function getProductOffers(req, res) {
    const result = await listingService.getProductOffers(req.auth.counterpartyId, req.params.id);
    ok(res, req, result);
}
// API-032 — 👤B.
export async function getListingLineForBuy(req, res) {
    const result = await listingService.getListingLineForBuy(req.auth.counterpartyId, req.params.id);
    ok(res, req, result);
}
// New — WF-04, submits the buy screen. 👤B.
export async function postInquire(req, res) {
    const input = inquireSchema.parse(req.body);
    const result = await listingService.createPileRequest(req.auth.counterpartyId, req.params.id, input);
    ok(res, req, result, 201);
}
// New. 👤B — read-only, staff add locations (BR-094).
export async function getMyDeliveryLocations(req, res) {
    const result = await listingService.listMyDeliveryLocations(req.auth.counterpartyId);
    ok(res, req, result);
}
// API-033 — 👤S.
export async function postListing(req, res) {
    const input = createListingSchema.parse(req.body);
    const result = await listingService.createListing(req.auth.counterpartyId, input);
    ok(res, req, result, 201);
}
// API-034 — 👤S.
export async function getMyListings(req, res) {
    const { state } = req.validatedQuery;
    const result = await listingService.getMyListings(req.auth.counterpartyId, { state });
    ok(res, req, result);
}
// API-035 — 👤S. :id is the listing line id.
export async function patchListingLineRate(req, res) {
    const input = changeListingLineRateSchema.parse(req.body);
    const result = await listingService.changeListingLineRate(req.auth.counterpartyId, req.params.id, input, sellerActor(req));
    ok(res, req, result);
}
// API-036 — 👤S.
export async function postPauseListing(req, res) {
    await listingService.pauseListing(req.auth.counterpartyId, req.params.id);
    ok(res, req, { paused: true });
}
export async function postRelistListing(req, res) {
    await listingService.relistListing(req.auth.counterpartyId, req.params.id);
    ok(res, req, { relisted: true });
}
// API-037 — 👤S. :id is the listing line id.
export async function getPositionCard(req, res) {
    const result = await listingService.getPositionCard(req.auth.counterpartyId, req.params.id);
    ok(res, req, result);
}
// API-038 — 👤S.
export async function getBoardOpportunities(req, res) {
    const result = await listingService.getBoardOpportunities();
    ok(res, req, result);
}
