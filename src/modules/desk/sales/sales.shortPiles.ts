import type { Types } from 'mongoose';
import { Pile } from '../../../models/Pile.js';
import { PileRequest } from '../../../models/PileRequest.js';
import { ListingLine } from '../../../models/ListingLine.js';
import { Sku } from '../../../models/Sku.js';
import { Product } from '../../../models/Product.js';
import { Buyer } from '../../../models/Buyer.js';
import { Counterparty } from '../../../models/Counterparty.js';
import { AppError } from '../../../shared/errors.js';
import { assertValidObjectId } from '../../../shared/objectId.js';
import { writeAuditLog } from '../../../shared/audit.js';
import type { Visibility } from '../../../shared/scope.js';
import { withTransaction } from '../../../db/transaction.js';
import { syncEnquiriesForPile } from '../../enquiry/enquiry.sync.js';
import { raiseAsk } from '../../demand/demand.service.js';
import { offerPileRequests } from '../../demand/pileOffer.service.js';
import { recordCallAction } from './sales.calls.js';

/**
 * 2 Nov - BR-134: where a pile exceeds what the seller can send, "the shortfall goes to desk
 * adjudication, case by case, with no automatic rule". The fan-out stops at that point (it makes no
 * order and flags the pile `shortfall`); this is the desk's half. Sales divides the boxes the seller
 * can send between the buyers on the pile - it is Sales who knows the buyers (BR-365 keeps their
 * names from Purchase) - and the pile then goes ahead for those buyers only.
 *
 * What a buyer asked for and does not get goes back to him as an open ask for the rest, so Purchase
 * finds another seller for it (BR-374) instead of the boxes being lost.
 */
export interface ShortPileRequestDto {
  pileRequestId: string;
  buyerId: string;
  firm: string;
  boxes: number;
  requestedAt: string;
}

export interface ShortPileDto {
  pileId: string;
  brand: string;
  packLabel: string;
  /** What the seller confirmed he can send. */
  canSend: number;
  /** What the buyers asked for, together. */
  asked: number;
  decidedAt: string | null;
  /** First come, first served: the order the buyers asked in. */
  requests: ShortPileRequestDto[];
}

const idOf = (value: unknown): string => String(value);

/**
 * The short piles waiting on the desk. A pile is shown only to someone who can see every buyer on
 * it: dividing boxes between buyers needs all of them, so a pile that spans two books goes to the
 * leader (or Controller) who sees both.
 */
export async function listShortPiles(visibility: Visibility): Promise<ShortPileDto[]> {
  const piles = await Pile.find({
    decision: 'confirmed',
    shortfall: true,
    executedAt: { $ne: null },
    shortfallResolvedAt: null,
  }).sort({ decidedAt: 1 });
  if (piles.length === 0) return [];

  const lines = await ListingLine.find({ _id: { $in: piles.map((p) => p.listingLineId) } });
  const lineById = new Map(lines.map((l) => [idOf(l._id), l]));
  const skus = await Sku.find({ _id: { $in: lines.map((l) => l.skuId) } });
  const skuById = new Map(skus.map((s) => [idOf(s._id), s]));
  const products = await Product.find({ _id: { $in: skus.map((s) => s.productId) } });
  const productById = new Map(products.map((p) => [idOf(p._id), p]));
  const requests = await PileRequest.find({ pileId: { $in: piles.map((p) => p._id) } }).sort({
    requestedAt: 1,
  });
  const buyers = await Buyer.find({ _id: { $in: requests.map((r) => r.buyerId) } });
  const buyerById = new Map(buyers.map((b) => [idOf(b._id), b]));
  const counterparties = await Counterparty.find({
    _id: { $in: buyers.map((b) => b.counterpartyId) },
  });
  const firmByCounterparty = new Map(counterparties.map((c) => [idOf(c._id), c.firm]));

  const result: ShortPileDto[] = [];
  for (const pile of piles) {
    const mine = requests.filter((r) => idOf(r.pileId) === idOf(pile._id));
    if (mine.length === 0) continue;
    if (!mine.every((r) => visibility.allowsProfile(idOf(r.buyerId)))) continue;
    const line = lineById.get(idOf(pile.listingLineId));
    const sku = line ? skuById.get(idOf(line.skuId)) : undefined;
    const product = sku ? productById.get(idOf(sku.productId)) : undefined;
    result.push({
      pileId: idOf(pile._id),
      brand: product?.brand ?? '-',
      packLabel: sku?.packLabel ?? '-',
      canSend: pile.confirmedQty ?? 0,
      asked: mine.reduce((sum, r) => sum + r.qty, 0),
      decidedAt: pile.decidedAt ? pile.decidedAt.toISOString() : null,
      requests: mine.map((r) => {
        const buyer = buyerById.get(idOf(r.buyerId));
        return {
          pileRequestId: idOf(r._id),
          buyerId: idOf(r.buyerId),
          firm: (buyer && firmByCounterparty.get(idOf(buyer.counterpartyId))) || '-',
          boxes: r.qty,
          requestedAt: r.requestedAt.toISOString(),
        };
      }),
    });
  }
  return result;
}

export interface ShortPileAllocation {
  pileRequestId: string;
  boxes: number;
}

export interface ResolveShortPileResult {
  /** Boxes now offered to the buyers (each to take or walk away from), together. */
  offeredBoxes: number;
  /** Boxes asked for and not given, now open as asks. */
  backOnAskBoxes: number;
  /** What the seller still has on the line afterwards. */
  lineQty: number;
}

/** Whether `allocations` is a fair division of this pile: every buyer once, whole boxes, no more than he asked or the seller can send. */
function assertValidDivision(
  requests: Array<{ _id: unknown; qty: number }>,
  allocations: ShortPileAllocation[],
  canSend: number,
): Map<string, number> {
  const given = new Map<string, number>();
  for (const a of allocations) {
    if (given.has(a.pileRequestId)) {
      throw new AppError({ code: 'VALIDATION_FAILED', messageEn: 'A buyer is listed twice.' });
    }
    given.set(a.pileRequestId, a.boxes);
  }
  const requestIds = new Set(requests.map((r) => idOf(r._id)));
  if (given.size !== requests.length || [...given.keys()].some((id) => !requestIds.has(id))) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Give a number of boxes (0 if none) for every buyer on the pile.',
    });
  }
  let total = 0;
  for (const r of requests) {
    const boxes = given.get(idOf(r._id))!;
    if (!Number.isInteger(boxes) || boxes < 0 || boxes > r.qty) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: `A buyer gets whole boxes, from 0 up to the ${r.qty} he asked for.`,
      });
    }
    total += boxes;
  }
  if (total > canSend) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: `The seller can send ${canSend} boxes; ${total} is more than that.`,
    });
  }
  return given;
}

/**
 * Divides a short pile. `allocations` names every request on the pile once, with the boxes that
 * buyer gets (0 to what he asked); together they may not exceed what the seller confirmed. The
 * orders, the stock taken off the line, the leftover asks and the "resolved" mark are one
 * transaction: all of it, or none.
 */
export async function resolveShortPile(
  pileId: string,
  input: { allocations: ShortPileAllocation[]; reason: string },
  actor: { employeeId: string; correlationId: string },
  visibility: Visibility,
): Promise<ResolveShortPileResult> {
  assertValidObjectId(pileId, 'pileId');
  const pile = await Pile.findById(pileId);
  if (!pile) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Pile not found.' });
  if (pile.decision !== 'confirmed' || !pile.executedAt || !pile.shortfall) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This pile is not short, so there is nothing to divide.',
    });
  }
  if (pile.shortfallResolvedAt) {
    throw new AppError({
      code: 'PILE_ALREADY_DECIDED',
      messageEn: 'This short pile has already been divided between the buyers.',
    });
  }

  const requests = await PileRequest.find({ pileId: pile._id }).sort({ requestedAt: 1 });
  if (!requests.every((r) => visibility.allowsProfile(idOf(r.buyerId)))) {
    throw new AppError({
      code: 'OUT_OF_SCOPE',
      messageEn: 'Some buyers on this pile are outside your book. Ask the leader to divide it.',
    });
  }
  const canSend = pile.confirmedQty ?? 0;
  const given = assertValidDivision(requests, input.allocations, canSend);
  const total = [...given.values()].reduce((sum, boxes) => sum + boxes, 0);

  const line = await ListingLine.findById(pile.listingLineId);
  if (!line) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Listing not found.' });
  const buyerCounterpartyId = new Map<string, string>();
  for (const b of await Buyer.find({ _id: { $in: requests.map((r) => r.buyerId) } })) {
    buyerCounterpartyId.set(idOf(b._id), idOf(b.counterpartyId));
  }

  let backOnAskBoxes = 0;
  const outcomes: Array<{ buyerId: string; asked: number; got: number }> = [];

  const lineQty = await withTransaction(async (session) => {
    // The transaction can be retried: start from nothing each time.
    backOnAskBoxes = 0;
    outcomes.length = 0;
    // BR-378 — each buyer who gets boxes is given the deal (held 24 hours); the order is his to make.
    await offerPileRequests(
      requests
        .filter((request) => given.get(idOf(request._id))! > 0)
        .map((request) => ({ request, qty: given.get(idOf(request._id))! })),
      session,
    );
    for (const request of requests) {
      const got = given.get(idOf(request._id))!;
      const left = request.qty - got;
      if (left > 0) {
        await raiseAsk(
          buyerCounterpartyId.get(idOf(request.buyerId))!,
          {
            skuId: idOf(line.skuId),
            allPacks: false,
            qty: left,
            conditionRequirement: {
              expiryBand: line.expiryBand,
              ...(line.deliveryBand ? { deliveryBand: line.deliveryBand } : {}),
            },
          },
          { channel: 'sales_call', raisedBy: actor.employeeId, session },
        );
        backOnAskBoxes += left;
      }
      outcomes.push({ buyerId: idOf(request.buyerId), asked: request.qty, got });
    }

    line.qty = Math.max(0, line.qty - total);
    await line.save({ session });
    pile.shortfallResolvedAt = new Date();
    pile.shortfallResolvedBy = actor.employeeId as unknown as Types.ObjectId;
    await pile.save({ session });
    await syncEnquiriesForPile(pile._id as Types.ObjectId, session);
    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'pile',
        entityId: pile._id as Types.ObjectId,
        field: 'shortfallResolvedAt',
        // DEC-014: the reason is what the rule staff actually apply is later read from.
        newValue: {
          canSend,
          offeredBoxes: total,
          backOnAskBoxes,
          allocations: outcomes,
          reason: input.reason,
        },
        correlationId: actor.correlationId,
      },
      session,
    );
    return line.qty;
  });

  // Each buyer's call history says what he got, so the next call starts from it.
  for (const o of outcomes) {
    const cpId = buyerCounterpartyId.get(o.buyerId);
    if (!cpId) continue;
    const note =
      o.got === o.asked
        ? `Short pile divided: offered all ${o.asked} boxes asked for.`
        : o.got > 0
          ? `Short pile divided: offered ${o.got} of ${o.asked} boxes; the other ${o.asked - o.got} are open as an ask.`
          : `Short pile divided: none of the ${o.asked} boxes could be offered; they are open as an ask.`;
    await recordCallAction({
      buyerCounterpartyId: cpId,
      employeeId: actor.employeeId,
      outcome: null, // A deal is given, not yet an order.
      note,
    });
  }

  return { offeredBoxes: total, backOnAskBoxes, lineQty };
}
