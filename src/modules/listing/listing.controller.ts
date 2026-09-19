import type { Request, Response } from 'express';
import * as listingService from './listing.service.js';
import {
  changeListingLineRateSchema,
  createListingSchema,
  inquireSchema,
} from './listing.validation.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

function sellerActor(req: Request): { employeeId: string; correlationId: string } {
  return { employeeId: req.auth!.counterpartyId!, correlationId: req.correlationId };
}

// API-030 — 👤B. The resolver runs here; no client-supplied scope accepted.
export async function getFeed(req: Request, res: Response): Promise<void> {
  const { cursor, limit } = req.validatedQuery as { cursor?: number; limit?: number };
  const result = await listingService.getBuyerFeed(
    req.auth!.counterpartyId!,
    cursor ?? 0,
    limit ?? 20,
  );
  res.status(200).json({
    data: result.items,
    meta: { correlationId: req.correlationId, nextCursor: result.nextCursor },
  });
}

// API-031 — 👤B.
export async function getProductOffers(req: Request, res: Response): Promise<void> {
  const result = await listingService.getProductOffers(
    req.auth!.counterpartyId!,
    req.params.id as string,
  );
  ok(res, req, result);
}

// API-032 — 👤B.
export async function getListingLineForBuy(req: Request, res: Response): Promise<void> {
  const result = await listingService.getListingLineForBuy(
    req.auth!.counterpartyId!,
    req.params.id as string,
  );
  ok(res, req, result);
}

// New — WF-04, submits the buy screen. 👤B.
export async function postInquire(req: Request, res: Response): Promise<void> {
  const input = inquireSchema.parse(req.body);
  const result = await listingService.createPileRequest(
    req.auth!.counterpartyId!,
    req.params.id as string,
    input,
  );
  ok(res, req, result, 201);
}

// New. 👤B — read-only, staff add locations (BR-094).
export async function getMyDeliveryLocations(req: Request, res: Response): Promise<void> {
  const result = await listingService.listMyDeliveryLocations(req.auth!.counterpartyId!);
  ok(res, req, result);
}

// API-033 — 👤S.
export async function postListing(req: Request, res: Response): Promise<void> {
  const input = createListingSchema.parse(req.body);
  const result = await listingService.createListing(req.auth!.counterpartyId!, input);
  ok(res, req, result, 201);
}

// API-034 — 👤S.
export async function getMyListings(req: Request, res: Response): Promise<void> {
  const { state } = req.validatedQuery as { state?: string };
  const result = await listingService.getMyListings(req.auth!.counterpartyId!, { state });
  ok(res, req, result);
}

// API-035 — 👤S. :id is the listing line id.
export async function patchListingLineRate(req: Request, res: Response): Promise<void> {
  const input = changeListingLineRateSchema.parse(req.body);
  const result = await listingService.changeListingLineRate(
    req.auth!.counterpartyId!,
    req.params.id as string,
    input,
    sellerActor(req),
  );
  ok(res, req, result);
}

// API-036 — 👤S.
export async function postPauseListing(req: Request, res: Response): Promise<void> {
  await listingService.pauseListing(req.auth!.counterpartyId!, req.params.id as string);
  ok(res, req, { paused: true });
}
export async function postRelistListing(req: Request, res: Response): Promise<void> {
  await listingService.relistListing(req.auth!.counterpartyId!, req.params.id as string);
  ok(res, req, { relisted: true });
}

// API-037 — 👤S. :id is the listing line id.
export async function getPositionCard(req: Request, res: Response): Promise<void> {
  const result = await listingService.getPositionCard(
    req.auth!.counterpartyId!,
    req.params.id as string,
  );
  ok(res, req, result);
}

// API-038 — 👤S.
export async function getBoardOpportunities(req: Request, res: Response): Promise<void> {
  const result = await listingService.getBoardOpportunities();
  ok(res, req, result);
}
