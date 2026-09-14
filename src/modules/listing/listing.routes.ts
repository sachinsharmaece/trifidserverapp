import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import * as controller from './listing.controller.js';
import {
  feedQuerySchema,
  createListingSchema,
  listMyListingsQuerySchema,
} from './listing.validation.js';

export const listingRouter = Router();

// API-030 — 👤B.
listingRouter.get('/listings', authenticate, validateQuery(feedQuerySchema), controller.getFeed);
// API-031 — 👤B.
listingRouter.get('/products/:id/offers', authenticate, controller.getProductOffers);
// API-032 — 👤B.
listingRouter.get('/listings/lines/:id', authenticate, controller.getListingLineForBuy);
// New — WF-04. 👤B. Idempotency-Key required — creates a pile request.
listingRouter.post(
  '/listings/lines/:id/inquire',
  authenticate,
  requireIdempotencyKey(),
  controller.postInquire,
);
// New. 👤B.
listingRouter.get('/me/locations', authenticate, controller.getMyDeliveryLocations);

// API-033 — 👤S.
listingRouter.post(
  '/listings',
  authenticate,
  validateBody(createListingSchema),
  controller.postListing,
);
// API-034 — 👤S.
listingRouter.get(
  '/listings/mine',
  authenticate,
  validateQuery(listMyListingsQuerySchema),
  controller.getMyListings,
);
// API-035 — 👤S.
listingRouter.patch('/listings/lines/:id/rate', authenticate, controller.patchListingLineRate);
// API-036 — 👤S.
listingRouter.post('/listings/:id/pause', authenticate, controller.postPauseListing);
listingRouter.post('/listings/:id/relist', authenticate, controller.postRelistListing);
// API-037 — 👤S.
listingRouter.get('/listings/lines/:id/position', authenticate, controller.getPositionCard);
// API-038 — 👤S.
listingRouter.get('/board/opportunities', authenticate, controller.getBoardOpportunities);
