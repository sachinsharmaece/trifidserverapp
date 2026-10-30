import type { Request, Response } from 'express';
import { Ask } from '../../models/Ask.js';
import { So } from '../../models/So.js';
import { Pile } from '../../models/Pile.js';
import { Quote } from '../../models/Quote.js';
import { ListingLine } from '../../models/ListingLine.js';
import { appendProxyLog } from '../../shared/proxyLog.js';
import { recordCallAction } from '../desk/sales/sales.calls.js';
import * as demandService from '../demand/demand.service.js';
import * as listingService from '../listing/listing.service.js';
import * as ordersService from '../orders/orders.service.js';
import {
  cheapestOfferOnHisBoard,
  placeOnListedOffer,
  type WantsItResult,
} from './proxy.wantsIt.js';
import { AppError } from '../../shared/errors.js';
import type {
  proxyRaiseAskSchema,
  proxyRaiseAsksSchema,
  proxyAcceptAskFillSchema,
  proxyDeclineAskSchema,
  proxyPromotionDecisionSchema,
  proxyCreateListingSchema,
  proxyPostQuoteSchema,
  proxyConfirmPileSchema,
  proxyPileDecisionSchema,
  proxyListBuyerAsksQuerySchema,
  proxyWantsItSchema,
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
  const { buyerCounterpartyId, callNote, expectedRatePaise, direction, ...input } =
    req.body as z.infer<typeof proxyRaiseAskSchema>;
  // DEC-051 — the enquiry it opens is recorded as a Sales call, by this staff member.
  const result = await demandService.raiseAsk(buyerCounterpartyId, input, {
    channel: 'sales_call',
    raisedBy: actingStaffId(req),
    ...(expectedRatePaise ? { expectedRatePaise } : {}),
  });
  await appendProxyLog(Ask, result.askId, {
    actingStaffId: actingStaffId(req),
    callNote,
    action: 'raise_ask',
  });
  await recordCallAction({
    buyerCounterpartyId,
    employeeId: actingStaffId(req),
    direction,
    outcome: 'asked_for_a_rate',
    note: callNote,
    producedAskId: result.askId,
  });
  ok(res, req, result, 201);
}

// 29 Oct — "He wants it" on a listed offer: a pile request (Purchase → Confirmations) or the
// pool for that offer, never an ask — an ask is only for what is not on his board.
export async function postBuyerCallWantsIt(req: Request, res: Response): Promise<void> {
  const { buyerCounterpartyId, callNote, direction, qty, deliveryLocationId } = req.body as z.infer<
    typeof proxyWantsItSchema
  >;
  const result = await placeOnListedOffer(buyerCounterpartyId, String(req.params.id), {
    qty,
    raisedBy: actingStaffId(req),
    ...(deliveryLocationId ? { deliveryLocationId } : {}),
  });
  await recordCallAction({
    buyerCounterpartyId,
    employeeId: actingStaffId(req),
    direction,
    outcome: 'asked_for_a_rate',
    note: callNote,
  });
  ok(res, req, result, 201);
}

// "Log a buyer call" for a call that names several products, under the one call note.
// 29 Oct — each line goes where its product belongs: if it is on his board he is put on the
// cheapest offer (a pile, or its pool — Purchase → Confirmations); if not, it is an ask
// (Purchase → Demand). Not all-or-nothing — each line stands on its own — so a line that
// fails is reported by position and the rest stay saved; the rep retries only that one.
export async function postBuyerCallAsks(req: Request, res: Response): Promise<void> {
  const { buyerCounterpartyId, callNote, lines, direction } = req.body as z.infer<
    typeof proxyRaiseAsksSchema
  >;
  const results: Array<
    | ({ index: number } & (
        | { kind: 'ask'; askId: string; merged: boolean } // merged — added to his open ask (BR-371)
        | WantsItResult
      ))
    | { index: number; error: string; code: string | null }
  > = [];
  for (const [index, line] of lines.entries()) {
    try {
      const { expectedRatePaise, ...askLine } = line;
      const offerId = await cheapestOfferOnHisBoard(buyerCounterpartyId, askLine);
      if (offerId) {
        const placed = await placeOnListedOffer(buyerCounterpartyId, offerId, {
          qty: askLine.qty,
          raisedBy: actingStaffId(req),
        });
        await recordCallAction({
          buyerCounterpartyId,
          employeeId: actingStaffId(req),
          direction,
          outcome: 'asked_for_a_rate',
          note: callNote,
        });
        results.push({ index, ...placed });
        continue;
      }
      const result = await demandService.raiseAsk(buyerCounterpartyId, askLine, {
        channel: 'sales_call',
        raisedBy: actingStaffId(req),
        ...(expectedRatePaise ? { expectedRatePaise } : {}),
      });
      await appendProxyLog(Ask, result.askId, {
        actingStaffId: actingStaffId(req),
        callNote,
        action: 'raise_ask',
      });
      await recordCallAction({
        buyerCounterpartyId,
        employeeId: actingStaffId(req),
        direction,
        outcome: 'asked_for_a_rate',
        note: callNote,
        producedAskId: result.askId,
      });
      results.push({ index, kind: 'ask', askId: result.askId, merged: result.merged });
    } catch (error) {
      if (!(error instanceof AppError)) throw error; // A real fault, not a rejected line.
      results.push({ index, error: error.messageEn, code: error.code });
    }
  }
  ok(res, req, { results }, 201);
}

// Feeds the "Advance an ask on a call" pickers — same read a buyer's own
// GET /asks calls, just addressed at the counterparty the staff member has
// on the phone rather than the token's own identity.
export async function getBuyerCallAsks(req: Request, res: Response): Promise<void> {
  const { buyerCounterpartyId } = req.validatedQuery as z.infer<
    typeof proxyListBuyerAsksQuerySchema
  >;
  const result = await demandService.listMyAsks(buyerCounterpartyId);
  ok(res, req, result);
}

// Maps to API-042 — advancing an ask, or confirming a rate over the phone;
// this codebase has one accept endpoint for both.
export async function postBuyerCallAcceptFill(req: Request, res: Response): Promise<void> {
  const { buyerCounterpartyId, callNote, direction, ...input } = req.body as z.infer<
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
  await recordCallAction({
    buyerCounterpartyId,
    employeeId: staffId,
    direction,
    outcome: 'placed_an_order',
    note: callNote,
    producedAskId: askId,
  });
  ok(res, req, result, 201);
}

// Maps to API-043 — walking away, free, never a strike.
export async function postBuyerCallDecline(req: Request, res: Response): Promise<void> {
  const { buyerCounterpartyId, callNote, direction } = req.body as z.infer<
    typeof proxyDeclineAskSchema
  >;
  const askId = req.params.id as string;
  await demandService.declineAsk(buyerCounterpartyId, askId);
  await appendProxyLog(Ask, askId, {
    actingStaffId: actingStaffId(req),
    callNote,
    action: 'decline_ask',
  });
  await recordCallAction({
    buyerCounterpartyId,
    employeeId: actingStaffId(req),
    direction,
    outcome: null,
    note: `Declined the ask. ${callNote}`,
    producedAskId: askId,
  });
  ok(res, req, { declined: true });
}

// Maps to API-071 — the WF-11 promoted-fallback accept/decline, a buyer
// decision Sales may also log on a call.
export async function postBuyerCallAcceptPromotion(req: Request, res: Response): Promise<void> {
  const { buyerCounterpartyId, callNote, direction } = req.body as z.infer<
    typeof proxyPromotionDecisionSchema
  >;
  const soId = req.params.id as string;
  await ordersService.acceptPromotion(buyerCounterpartyId, soId, req.correlationId);
  await appendProxyLog(So, soId, {
    actingStaffId: actingStaffId(req),
    callNote,
    action: 'accept_promotion',
  });
  await recordCallAction({
    buyerCounterpartyId,
    employeeId: actingStaffId(req),
    direction,
    outcome: null,
    note: `Accepted the promoted offer. ${callNote}`,
  });
  ok(res, req, { accepted: true });
}

export async function postBuyerCallRejectPromotion(req: Request, res: Response): Promise<void> {
  const { buyerCounterpartyId, callNote, direction } = req.body as z.infer<
    typeof proxyPromotionDecisionSchema
  >;
  const soId = req.params.id as string;
  await ordersService.rejectPromotion(buyerCounterpartyId, soId);
  await appendProxyLog(So, soId, {
    actingStaffId: actingStaffId(req),
    callNote,
    action: 'reject_promotion',
  });
  await recordCallAction({
    buyerCounterpartyId,
    employeeId: actingStaffId(req),
    direction,
    outcome: null,
    note: `Turned down the promoted offer. ${callNote}`,
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

// Maps to API-045 — Purchase raises a quote on the seller's behalf from the
// Demand screen. Same postQuote as the seller's own POST /asks/:id/quotes, so
// BR-105 (batch), BR-124, BR-126 (hold) and BR-273 (gap codes) all still apply.
export async function postSellerCallQuote(req: Request, res: Response): Promise<void> {
  const { sellerCounterpartyId, callNote, ...input } = req.body as z.infer<
    typeof proxyPostQuoteSchema
  >;
  const result = await demandService.postQuote(
    sellerCounterpartyId,
    req.params.id as string,
    input,
    { holdForSales: true }, // Published as a listing at once; Sales gives it to the asking buyer.
  );
  await appendProxyLog(Quote, result.quoteId, {
    actingStaffId: actingStaffId(req),
    callNote,
    action: 'post_quote',
  });
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
