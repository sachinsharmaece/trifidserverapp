import type { Request, Response } from 'express';
import * as demandService from './demand.service.js';
import * as pileOfferService from './pileOffer.service.js';
import {
  acceptAskFillSchema,
  confirmPileSchema,
  postQuoteSchema,
  raiseAskSchema,
} from './demand.validation.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

// BR-378 — 👤B. The deals given to him that wait on his word.
export async function getMyPileOffers(req: Request, res: Response): Promise<void> {
  ok(res, req, await pileOfferService.listMyPileOffers(req.auth!.counterpartyId!));
}

// BR-378 — 👤B. Idempotency-Key required — this makes an order.
export async function postAcceptPileOffer(req: Request, res: Response): Promise<void> {
  const buyerCounterpartyId = req.auth!.counterpartyId!;
  const result = await pileOfferService.acceptPileOffer(
    req.params.id as string,
    buyerCounterpartyId,
    {
      actorId: buyerCounterpartyId,
      actorType: 'counterparty',
      correlationId: req.correlationId,
    },
  );
  ok(res, req, { soId: result.soId, boxes: result.boxes }, 201);
}

// BR-378 — 👤B. He walks away; the boxes go back on the listing.
export async function postDeclinePileOffer(req: Request, res: Response): Promise<void> {
  const buyerCounterpartyId = req.auth!.counterpartyId!;
  ok(
    res,
    req,
    await pileOfferService.declinePileOffer(req.params.id as string, buyerCounterpartyId, {
      actorId: buyerCounterpartyId,
      actorType: 'counterparty',
      correlationId: req.correlationId,
    }),
  );
}

// API-040 — 👤B.
export async function postAsk(req: Request, res: Response): Promise<void> {
  const input = raiseAskSchema.parse(req.body);
  const result = await demandService.raiseAsk(req.auth!.counterpartyId!, input);
  ok(res, req, result, 201);
}

// API-041 — 👤B.
export async function getMyAsks(req: Request, res: Response): Promise<void> {
  const result = await demandService.listMyAsks(req.auth!.counterpartyId!);
  ok(res, req, result);
}

// API-042 — 👤B. Idempotency-Key required — this creates a chain per seller portion.
export async function postAcceptFill(req: Request, res: Response): Promise<void> {
  const input = acceptAskFillSchema.parse(req.body);
  const result = await demandService.acceptAskFill(
    req.auth!.counterpartyId!,
    req.params.id as string,
    input,
    req.correlationId,
  );
  ok(res, req, result, 201);
}

// API-043 — 👤B.
export async function postDeclineAsk(req: Request, res: Response): Promise<void> {
  await demandService.declineAsk(req.auth!.counterpartyId!, req.params.id as string);
  ok(res, req, { declined: true });
}

// API-044 — 👤S.
export async function getDemandBoard(req: Request, res: Response): Promise<void> {
  const result = await demandService.getDemandBoard(req.auth!.counterpartyId!);
  ok(res, req, result);
}

// API-045 — 👤S.
export async function postQuote(req: Request, res: Response): Promise<void> {
  const input = postQuoteSchema.parse(req.body);
  const result = await demandService.postQuote(
    req.auth!.counterpartyId!,
    req.params.id as string,
    input,
    { holdForSales: true }, // Published as a listing at once; Sales gives it to the asking buyer.
  );
  ok(res, req, result, 201);
}

// API-046 — 👤S.
export async function getMyQuotes(req: Request, res: Response): Promise<void> {
  const result = await demandService.listMyQuotes(req.auth!.counterpartyId!);
  ok(res, req, result);
}

// API-048 — 👤S.
export async function getConfirmations(req: Request, res: Response): Promise<void> {
  const result = await demandService.listConfirmations(req.auth!.counterpartyId!);
  ok(res, req, result);
}

// API-049 — 👤S. Idempotency-Key required — schedules the deferred fan-out.
export async function postConfirmPile(req: Request, res: Response): Promise<void> {
  const input = confirmPileSchema.parse(req.body);
  const result = await demandService.confirmPile(
    req.auth!.counterpartyId!,
    req.params.id as string,
    input,
    req.correlationId,
  );
  ok(res, req, result, 201);
}

// New — BR-137's undo half.
export async function postUndoPileConfirm(req: Request, res: Response): Promise<void> {
  await demandService.undoPileConfirm(req.auth!.counterpartyId!, req.params.id as string);
  ok(res, req, { undone: true });
}

// API-050 — 👤S.
export async function postRequotePile(req: Request, res: Response): Promise<void> {
  await demandService.requotePile(req.auth!.counterpartyId!, req.params.id as string);
  ok(res, req, { requoted: true });
}
export async function postDeclinePile(req: Request, res: Response): Promise<void> {
  await demandService.declinePile(req.auth!.counterpartyId!, req.params.id as string);
  ok(res, req, { declined: true });
}

// API-051 — 👤S. Gated on config.claim_board, which ships off (BR-140).
export async function getClaims(req: Request, res: Response): Promise<void> {
  const result = await demandService.getClaimBoard(req.auth!.counterpartyId!);
  ok(res, req, result);
}
export async function postClaim(req: Request, res: Response): Promise<void> {
  const result = await demandService.claimPile(req.auth!.counterpartyId!, req.params.id as string);
  ok(res, req, result, 201);
}
export async function postUndoClaim(req: Request, res: Response): Promise<void> {
  await demandService.undoClaim(req.auth!.counterpartyId!, req.params.id as string);
  ok(res, req, { undone: true });
}
