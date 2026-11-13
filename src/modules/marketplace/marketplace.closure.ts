import type { ClientSession, Types } from 'mongoose';
import { BookAssignment } from '../../models/BookAssignment.js';
import { Buyer } from '../../models/Buyer.js';
import { Counterparty } from '../../models/Counterparty.js';
import { Employee } from '../../models/Employee.js';
import type { StopReasonCode } from '../../models/Listing.js';
import { Pile } from '../../models/Pile.js';
import { PileRequest } from '../../models/PileRequest.js';
import { Product } from '../../models/Product.js';
import { Role } from '../../models/Role.js';
import { writeAuditLog } from '../../shared/audit.js';
import { syncEnquiriesForPile } from '../enquiry/enquiry.sync.js';
import { notifyStaff } from '../notice/notice.service.js';

/**
 * RECTIFY-01 Phase 0 — what a stop does to the buyers' open requests, and how Sales hears of it.
 * Kept apart from `marketplace.service.ts` because the pile fan-out job (which that service's own
 * imports reach) closes a confirmed pile the same way, and must not import the service back.
 *
 * The wall (BR-060/BR-069): a Sales notice names buyers and never the seller.
 */

/** What one act is done for, and by whom — handed down to every cascaded change. */
export interface StopContext {
  employeeId: string;
  correlationId: string;
  reasonCode: StopReasonCode;
  note: string;
  /** Set by the emergency script so one run can be undone as one batch. */
  stopBatchId: string | null;
  now: Date;
}

export const id = (value: unknown): string => String(value);
export const reasonText = (ctx: Pick<StopContext, 'reasonCode' | 'note'>): string =>
  `${ctx.reasonCode}: ${ctx.note}`;

export async function activeAdminIds(): Promise<string[]> {
  const adminRole = await Role.findOne({ key: 'admin' }, { _id: 1 });
  if (!adminRole) return [];
  const admins = await Employee.find({ active: true, roleIds: adminRole._id }, { _id: 1 });
  return admins.map((admin) => id(admin._id));
}

/**
 * Who on the Sales desk hears about this buyer: his book owner, and nobody else. A buyer in the Queue,
 * or whose owner has left, goes to the active Admins — the same fallback the rate-change notices use.
 */
export async function salesDeskFor(
  buyerId: unknown,
  admins: () => Promise<string[]>,
): Promise<string[]> {
  const assignment = await BookAssignment.findOne({ buyerId }, { ownerEmployeeId: 1 });
  if (assignment) {
    const owner = await Employee.findOne(
      { _id: assignment.ownerEmployeeId, active: true },
      { _id: 1 },
    );
    if (owner) return [id(owner._id)];
  }
  return admins();
}

export async function firmOfBuyer(buyerId: unknown): Promise<string> {
  const buyer = await Buyer.findById(buyerId, { counterpartyId: 1 });
  const counterparty = buyer
    ? await Counterparty.findById(buyer.counterpartyId, { firm: 1 })
    : null;
  return counterparty?.firm ?? 'a buyer';
}

export async function productNameOf(productId: unknown): Promise<string> {
  const product = await Product.findById(productId, { brand: 1 });
  return product?.brand ?? 'a listed product';
}

export type BuyerToCall = { buyerId: Types.ObjectId; boxes: number };

/**
 * Closes one pile as a desk decline: the same write the seller's own decline makes, so the enquiries
 * read `declined` — but no strike, and the buyers are not told (LOCK-24.1 to .3). `from` is the
 * decision it must still hold: the conditional update is the lock, so a seller deciding the same pile
 * at this instant finds it taken, or this finds it taken. Returns who was on it, or null if it was
 * not claimed.
 */
async function declinePile(
  pileId: Types.ObjectId,
  from: null | 'confirmed',
  ctx: StopContext,
  session: ClientSession,
): Promise<BuyerToCall[] | null> {
  const claimed = await Pile.findOneAndUpdate(
    // A confirmed pile is only closed before its buyers were given their deal.
    from === 'confirmed'
      ? { _id: pileId, decision: 'confirmed', executedAt: null }
      : { _id: pileId, decision: null },
    { $set: { decision: 'declined', decidedAt: ctx.now, deskDeclined: true } },
    { session },
  );
  if (!claimed) return null;
  const requests = await PileRequest.find({ pileId }).session(session);
  await writeAuditLog(
    {
      actorId: ctx.employeeId,
      actorType: 'staff',
      entity: 'pile',
      entityId: pileId,
      field: 'decision',
      oldValue: from,
      newValue:
        from === 'confirmed'
          ? 'declined (listing stopped by TriFid before the buyers were given their deal)'
          : 'declined (listing stopped by TriFid)',
      reason: reasonText(ctx),
      correlationId: ctx.correlationId,
    },
    session,
  );
  await syncEnquiriesForPile(pileId, session, ctx.now);
  return requests.map((request) => ({
    buyerId: request.buyerId as Types.ObjectId,
    boxes: request.qty,
  }));
}

/**
 * Open piles on the stopped lines (no decision yet) close as a desk decline. Returns who was on
 * them, for the Sales call list.
 */
export async function declineOpenPiles(
  lineIds: Array<Types.ObjectId | string>,
  ctx: StopContext,
  session: ClientSession,
): Promise<{ pilesClosed: number; toCall: BuyerToCall[] }> {
  const piles = await Pile.find({ listingLineId: { $in: lineIds }, decision: null }).session(
    session,
  );
  const toCall: BuyerToCall[] = [];
  let pilesClosed = 0;
  for (const pile of piles) {
    const buyers = await declinePile(pile._id as Types.ObjectId, null, ctx, session);
    if (!buyers) continue;
    pilesClosed += 1;
    toCall.push(...buyers);
  }
  return { pilesClosed, toCall };
}

/** Tells each Sales person which of the buyers they own to ring. Buyers' names are Sales's to see; the seller's never. */
export async function tellSalesToCall(
  buyers: BuyerToCall[],
  productName: string,
  session: ClientSession,
): Promise<void> {
  if (buyers.length === 0) return;
  let adminCache: Promise<string[]> | null = null;
  const admins = () => (adminCache ??= activeAdminIds());

  // One line per buyer (boxes added up across his piles), grouped by who hears of him.
  const boxesByBuyer = new Map<string, number>();
  for (const { buyerId, boxes } of buyers) {
    boxesByBuyer.set(id(buyerId), (boxesByBuyer.get(id(buyerId)) ?? 0) + boxes);
  }
  const byRecipient = new Map<string, string[]>();
  for (const buyerId of boxesByBuyer.keys()) {
    for (const employeeId of await salesDeskFor(buyerId, admins)) {
      byRecipient.set(employeeId, [...(byRecipient.get(employeeId) ?? []), buyerId]);
    }
  }
  for (const [employeeId, buyerIds] of byRecipient) {
    const lines: string[] = [];
    for (const buyerId of buyerIds) {
      lines.push(`${await firmOfBuyer(buyerId)} (${boxesByBuyer.get(buyerId)} boxes)`);
    }
    await notifyStaff(
      [employeeId],
      {
        kind: 'listing_stopped',
        title: `Listing stopped: ${productName} — call the buyers`,
        body:
          `TriFid stopped a listing of ${productName}. Their requests on it are closed and they ` +
          `have not been told. Please call: ${lines.join(', ')}.`,
        link: buyerIds.length === 1 ? `/sales/buyers/${buyerIds[0]}` : null,
      },
      session,
    );
  }
}

/**
 * A pile the seller confirmed whose buyers had not yet been given their deal when staff stopped the
 * listing. The fan-out calls this instead of offering: the pile closes as a desk decline, and Sales
 * is told whom to ring. Returns false when the pile was no longer there to close (another runner
 * got it first, or it was already offered).
 */
export async function declineConfirmedPileOfStoppedListing(
  pileId: Types.ObjectId,
  productId: unknown,
  ctx: StopContext,
  session: ClientSession,
): Promise<boolean> {
  const buyers = await declinePile(pileId, 'confirmed', ctx, session);
  if (!buyers) return false;
  await tellSalesToCall(buyers, await productNameOf(productId), session);
  return true;
}
