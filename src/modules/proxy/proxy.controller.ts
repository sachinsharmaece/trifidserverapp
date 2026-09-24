import type { Request, Response } from 'express';
import { Ask } from '../../models/Ask.js';
import { So } from '../../models/So.js';
import { Pile } from '../../models/Pile.js';
import { ListingLine } from '../../models/ListingLine.js';
import { appendProxyLog } from '../../shared/proxyLog.js';
import * as demandService from '../demand/demand.service.js';
import * as listingService from '../listing/listing.service.js';
import * as ordersService from '../orders/orders.service.js';
import type {
  proxyRaiseAskSchema,
  proxyAcceptAskFillSchema,
  proxyDeclineAskSchema,
  proxyPromotionDecisionSchema,
  proxyCreateListingSchema,
  proxyConfirmPileSchema,
  proxyPileDecisionSchema,
} from './proxy.validation.js';
import type { z } from 'zod';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

function actingStaffId(req: Request): string {
  return req.auth!.employeeId!;
}

// --- Buyer-side (Sales desk) --------------------------------------------

// Maps to API-040 — "log a buyer call". Calls the exact same raiseAsk a
// buyer's own POST /asks would call; the call note lands on the Ask this
// creates.
export async function postBuyerCallAsk(req: Request, res: Response): Promise<void> {
  const { buyerCounterpartyId, callNote, ...input } = req.body as z.infer<
    typeof proxyRaiseAskSchema
  >;
  // DEC-051 — the enquiry it opens is recorded as a Sales call, by this staff member.
  const result = await demandService.raiseAsk(buyerCounterpartyId, input, {
    channel: 'sales_call',
    raisedBy: actingStaffId(req),
  });
  await appendProxyLog(Ask, result.askId, {
    actingStaffId: actingStaffId(req),
    callNote,
    action: 'raise_ask',
  });
  ok(res, req, result, 201);
}

// Maps to API-042 — advancing an ask, or confirming a rate over the phone;
// this codebase has one accept endpoint for both.
export async function postBuyerCallAcceptFill(req: Request, res: Response): Promise<void> {
  const { buyerCounterpartyId, callNote, ...input } = req.body as z.infer<
    typeof proxyAcceptAskFillSchema
  >;
  const askId = req.params.id as string;
  const result = await demandService.acceptAskFill(
    buyerCounterpartyId,
    askId,
    input,
    req.correlationId,
  );
  const staffId = actingStaffId(req);
  await appendProxyLog(Ask, askId, { actingStaffId: staffId, callNote, action: 'accept_fill' });
  await Promise.all(
    result.soIds.map((soId) =>
      appendProxyLog(So, soId, { actingStaffId: staffId, callNote, action: 'accept_fill' }),
    ),
  );
  ok(res, req, result, 201);
}

// Maps to API-043 — walking away, free, never a strike.
export async function postBuyerCallDecline(req: Request, res: Response): Promise<void> {
  const { buyerCounterpartyId, callNote } = req.body as z.infer<typeof proxyDeclineAskSchema>;
  const askId = req.params.id as string;
  await demandService.declineAsk(buyerCounterpartyId, askId);
  await appendProxyLog(Ask, askId, {
    actingStaffId: actingStaffId(req),
    callNote,
    action: 'decline_ask',
  });
  ok(res, req, { declined: true });
}

// Maps to API-071 — the WF-11 promoted-fallback accept/decline, a buyer
// decision Sales may also log on a call.
export async function postBuyerCallAcceptPromotion(req: Request, res: Response): Promise<void> {
  const { buyerCounterpartyId, callNote } = req.body as z.infer<
    typeof proxyPromotionDecisionSchema
  >;
  const soId = req.params.id as string;
  await ordersService.acceptPromotion(buyerCounterpartyId, soId, req.correlationId);
  await appendProxyLog(So, soId, {
    actingStaffId: actingStaffId(req),
    callNote,
    action: 'accept_promotion',
  });
  ok(res, req, { accepted: true });
}

export async function postBuyerCallRejectPromotion(req: Request, res: Response): Promise<void> {
  const { buyerCounterpartyId, callNote } = req.body as z.infer<
    typeof proxyPromotionDecisionSchema
  >;
  const soId = req.params.id as string;
  await ordersService.rejectPromotion(buyerCounterpartyId, soId);
  await appendProxyLog(So, soId, {
    actingStaffId: actingStaffId(req),
    callNote,
    action: 'reject_promotion',
  });
  ok(res, req, { rejected: true });
}

// --- Seller-side (Purchase desk) ----------------------------------------

// Maps to API-033 — "log a seller call". Same fields, same validation
// (shelf-life floor, MOQ, the two delivery bands) as the seller's own
// POST /listings.
export async function postSellerCallListing(req: Request, res: Response): Promise<void> {
  const { sellerCounterpartyId, callNote, ...input } = req.body as z.infer<
    typeof proxyCreateListingSchema
  >;
  const result = await listingService.createListing(sellerCounterpartyId, input);
  const staffId = actingStaffId(req);
  await Promise.all(
    result.lineIds.map((lineId) =>
      appendProxyLog(ListingLine, lineId, {
        actingStaffId: staffId,
        callNote,
        action: 'create_listing',
      }),
    ),
  );
  ok(res, req, result, 201);
}

// Maps to API-049 — the fan-out. Same exact-expiry-and-batch gate as every
// other confirm path (IC-21); a phone-based confirm does not bypass it.
export async function postSellerCallConfirmPile(req: Request, res: Response): Promise<void> {
  const { sellerCounterpartyId, callNote, ...input } = req.body as z.infer<
    typeof proxyConfirmPileSchema
  >;
  const pileId = req.params.id as string;
  const result = await demandService.confirmPile(
    sellerCounterpartyId,
    pileId,
    input,
    req.correlationId,
  );
  await appendProxyLog(Pile, pileId, {
    actingStaffId: actingStaffId(req),
    callNote,
    action: 'confirm_pile',
  });
  ok(res, req, result, 201);
}

// Maps to API-050 — the other two exits.
export async function postSellerCallRequotePile(req: Request, res: Response): Promise<void> {
  const { sellerCounterpartyId, callNote } = req.body as z.infer<typeof proxyPileDecisionSchema>;
  const pileId = req.params.id as string;
  await demandService.requotePile(sellerCounterpartyId, pileId);
  await appendProxyLog(Pile, pileId, {
    actingStaffId: actingStaffId(req),
    callNote,
    action: 'requote_pile',
  });
  ok(res, req, { requoted: true });
}

export async function postSellerCallDeclinePile(req: Request, res: Response): Promise<void> {
  const { sellerCounterpartyId, callNote } = req.body as z.infer<typeof proxyPileDecisionSchema>;
  const pileId = req.params.id as string;
  await demandService.declinePile(sellerCounterpartyId, pileId);
  await appendProxyLog(Pile, pileId, {
    actingStaffId: actingStaffId(req),
    callNote,
    action: 'decline_pile',
  });
  ok(res, req, { declined: true });
}
