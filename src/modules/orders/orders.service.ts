import type { Types } from 'mongoose';
import { withTransaction } from '../../db/transaction.js';
import { So, type SoState } from '../../models/So.js';
import { Po } from '../../models/Po.js';
import { Movement } from '../../models/Movement.js';
import { Buyer } from '../../models/Buyer.js';
import { Seller } from '../../models/Seller.js';
import { Complaint, type ComplaintCategory } from '../../models/Complaint.js';
import { Refund, type RefundReasonCode } from '../../models/Refund.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { transitionToDispatchedLeg1 } from '../chain/chain.service.js';
import { writeChainEvent } from '../chain/chain.events.js';
import {
  toBuyerSoDto,
  toSellerPoDto,
  type BuyerSoDto,
  type SellerPoDto,
} from './orders.dto.js';

async function requireBuyer(buyerCounterpartyId: string) {
  const buyer = await Buyer.findOne({ counterpartyId: buyerCounterpartyId });
  if (!buyer) throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Buyers only.' });
  return buyer;
}
async function requireSeller(sellerCounterpartyId: string) {
  const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
  if (!seller) throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Sellers only.' });
  return seller;
}

// ---------------------------------------------------------------------------
// API-070 — 👤B side.
// ---------------------------------------------------------------------------

export async function listBuyerOrders(buyerCounterpartyId: string): Promise<BuyerSoDto[]> {
  const buyer = await requireBuyer(buyerCounterpartyId);
  const sos = await So.find({ buyerId: buyer._id }).sort({ createdAt: -1 });
  const leg1s = await Movement.find({ chainId: { $in: sos.map((s) => s.chainId) }, leg: 1 });
  const leg1ByChain = new Map(leg1s.map((m) => [(m.chainId as Types.ObjectId).toString(), m]));
  return sos.map((so) =>
    toBuyerSoDto(so, leg1ByChain.get((so.chainId as Types.ObjectId).toString()) ?? null),
  );
}

export async function getBuyerOrder(
  buyerCounterpartyId: string,
  soId: string,
): Promise<BuyerSoDto> {
  const buyer = await requireBuyer(buyerCounterpartyId);
  const so = await So.findOne({ _id: soId, buyerId: buyer._id });
  if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
  const leg1 = await Movement.findOne({ chainId: so.chainId, leg: 1 });
  return toBuyerSoDto(so, leg1);
}

// ---------------------------------------------------------------------------
// API-070 — 👤S side. BR-138 — blind on leg 2, no buyer identity ever.
// ---------------------------------------------------------------------------

export async function listSellerOrders(sellerCounterpartyId: string): Promise<SellerPoDto[]> {
  const seller = await requireSeller(sellerCounterpartyId);
  const pos = await Po.find({ sellerId: seller._id }).sort({ createdAt: -1 });
  const sos = await So.find({ _id: { $in: pos.map((p) => p.soId) } });
  const soById = new Map(sos.map((s) => [(s._id as Types.ObjectId).toString(), s]));
  const movements = await Movement.find({ chainId: { $in: pos.map((p) => p.chainId) } });
  const movementsByChain = new Map<string, typeof movements>();
  for (const m of movements) {
    const key = (m.chainId as Types.ObjectId).toString();
    const list = movementsByChain.get(key) ?? [];
    list.push(m);
    movementsByChain.set(key, list);
  }
  return pos.map((po) => {
    const so = soById.get((po.soId as Types.ObjectId).toString());
    const chainMovements = movementsByChain.get((po.chainId as Types.ObjectId).toString()) ?? [];
    const leg1 = chainMovements.find((m) => m.leg === 1) ?? null;
    const leg2Exists = chainMovements.some((m) => m.leg === 2);
    return toSellerPoDto(po, (so?.state as SoState) ?? 'po_released', leg1, leg2Exists);
  });
}

export async function getSellerOrder(
  sellerCounterpartyId: string,
  poId: string,
): Promise<SellerPoDto> {
  const seller = await requireSeller(sellerCounterpartyId);
  const po = await Po.findOne({ _id: poId, sellerId: seller._id });
  if (!po) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
  const so = await So.findById(po.soId);
  const movements = await Movement.find({ chainId: po.chainId });
  const leg1 = movements.find((m) => m.leg === 1) ?? null;
  const leg2Exists = movements.some((m) => m.leg === 2);
  return toSellerPoDto(po, (so?.state as SoState) ?? 'po_released', leg1, leg2Exists);
}

// ---------------------------------------------------------------------------
// API-075 — 👤S. The seller's own self-capture of leg 1 (distinct from the
// staff/Logistics `movement:write` recording of either leg, chain.routes.ts).
// ---------------------------------------------------------------------------

interface DispatchLeg1Input {
  mode: 'transport' | 'bus';
  transporter?: string;
  lr?: string;
  busNo?: string;
  driver?: string;
  driverMobile?: string;
  photoRef?: string;
  freightTerms: 'prepaid' | 'to_pay';
  freightAmountPaise: number;
}

export async function postDispatchLeg1(
  sellerCounterpartyId: string,
  poId: string,
  input: DispatchLeg1Input,
  actor: { correlationId: string },
): Promise<{ dispatched: true }> {
  const seller = await requireSeller(sellerCounterpartyId);
  const po = await Po.findOne({ _id: poId, sellerId: seller._id });
  if (!po) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
  if (po.state !== 'released') {
    throw new AppError({
      code: 'ORDER_NOT_DISPATCHABLE',
      messageEn: 'This order has already been dispatched or is no longer active.',
    });
  }

  await withTransaction(async (session) => {
    await Movement.create(
      [
        {
          chainId: po.chainId,
          leg: 1,
          mode: input.mode,
          transporter: input.transporter ?? null,
          lr: input.lr ?? null,
          busNo: input.busNo ?? null,
          driver: input.driver ?? null,
          driverMobile: input.driverMobile ?? null,
          photoRef: input.photoRef ?? null,
          freightTerms: input.freightTerms,
          freightAmountPaise: input.freightAmountPaise,
          recordedBy: seller._id,
        },
      ],
      { session, ordered: true },
    );
    await writeChainEvent(
      {
        chainId: po.chainId as Types.ObjectId,
        type: 'leg1_dispatched',
        refCollection: 'po',
        refId: po._id as Types.ObjectId,
        actorId: (seller._id as Types.ObjectId).toString(),
        actorType: 'counterparty',
        summary: `PO ${po.poNo} dispatched, leg 1 (${input.mode}).`,
      },
      session,
    );
    await writeAuditLog(
      {
        actorId: (seller._id as Types.ObjectId).toString(),
        actorType: 'counterparty',
        entity: 'po',
        entityId: po._id as Types.ObjectId,
        field: 'dispatch_leg1',
        newValue: { mode: input.mode },
        correlationId: actor.correlationId,
      },
      session,
    );
  });

  await transitionToDispatchedLeg1(
    (po.soId as Types.ObjectId).toString(),
    (po._id as Types.ObjectId).toString(),
  );

  return { dispatched: true };
}

// ---------------------------------------------------------------------------
// API-076 — 👤S. A desk lifeline flag; not auto-actioned (see Po.ts comment).
// ---------------------------------------------------------------------------

export async function postExtensionRequest(
  sellerCounterpartyId: string,
  poId: string,
  reason: string,
): Promise<{ requested: true }> {
  const seller = await requireSeller(sellerCounterpartyId);
  const po = await Po.findOne({ _id: poId, sellerId: seller._id });
  if (!po) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
  if (po.state !== 'released') {
    throw new AppError({
      code: 'ORDER_NOT_DISPATCHABLE',
      messageEn: 'An extension can only be requested before dispatch.',
    });
  }
  po.extensionRequestedAt = new Date();
  po.extensionReason = reason;
  await po.save();
  return { requested: true };
}

// ---------------------------------------------------------------------------
// API-073 — 👤B. BR-192 — the buyer's tap is an accelerator, not a
// requirement; silence would otherwise default to the same outcome after
// seven days once a scheduled job exists for it (not built this session —
// see chain.service.ts's own note on the same gap for `closed`).
// ---------------------------------------------------------------------------

export async function confirmReceipt(
  buyerCounterpartyId: string,
  soId: string,
): Promise<{ closed: true }> {
  const buyer = await requireBuyer(buyerCounterpartyId);
  const so = await So.findOne({ _id: soId, buyerId: buyer._id });
  if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
  if (so.state !== 'dispatched_leg2') {
    throw new AppError({
      code: 'ORDER_NOT_YET_DELIVERABLE',
      messageEn: 'This order has not left Indore on its second leg yet.',
    });
  }
  so.state = 'closed';
  await so.save();
  return { closed: true };
}

// ---------------------------------------------------------------------------
// API-074 — 👤B. BR-201's five fixed categories; the seven-day clock stops
// the moment a complaint is raised (`state: 'disputed'` is a terminal, no
// further auto-close job can fire against it).
// ---------------------------------------------------------------------------

interface PostComplaintInput {
  category: ComplaintCategory;
  note?: string;
}

export async function postComplaint(
  buyerCounterpartyId: string,
  soId: string,
  input: PostComplaintInput,
): Promise<{ complaintId: string }> {
  const buyer = await requireBuyer(buyerCounterpartyId);
  const so = await So.findOne({ _id: soId, buyerId: buyer._id });
  if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
  if (so.state !== 'dispatched_leg2' && so.state !== 'delivered') {
    throw new AppError({
      code: 'COMPLAINT_WINDOW_CLOSED',
      messageEn: 'A complaint can only be raised after leg 2 has dispatched, within the window.',
    });
  }

  const complaint = await Complaint.create({
    soId: so._id,
    buyerId: buyer._id,
    category: input.category,
    note: input.note ?? null,
  });
  so.state = 'disputed';
  await so.save();
  return { complaintId: (complaint._id as Types.ObjectId).toString() };
}

export async function getComplaints(
  buyerCounterpartyId: string,
  soId: string,
): Promise<Array<{ complaintId: string; category: ComplaintCategory; state: string }>> {
  const buyer = await requireBuyer(buyerCounterpartyId);
  const so = await So.findOne({ _id: soId, buyerId: buyer._id });
  if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
  const complaints = await Complaint.find({ soId: so._id }).sort({ createdAt: -1 });
  return complaints.map((c) => ({
    complaintId: (c._id as Types.ObjectId).toString(),
    category: c.category as ComplaintCategory,
    state: c.state,
  }));
}

// ---------------------------------------------------------------------------
// New — 👤B. No contract entry names a buyer-facing refund list (refunds are
// staff/Accounts registers only, API_CONTRACT.md §7); added so the buyer app
// has something real to show on its own "Refunds" screen, in the same
// wall-respecting shape as everything else here (own refunds only, no
// runId/targetAccountMasked beyond what he is entitled to see).
// ---------------------------------------------------------------------------

export interface BuyerRefundDto {
  refundId: string;
  amountPaise: number;
  reasonCode: RefundReasonCode;
  state: string;
  createdAt: Date;
}

export async function listBuyerRefunds(buyerCounterpartyId: string): Promise<BuyerRefundDto[]> {
  const buyer = await requireBuyer(buyerCounterpartyId);
  const refunds = await Refund.find({ buyerId: buyer._id }).sort({ createdAt: -1 });
  return refunds.map((r) => ({
    refundId: (r._id as Types.ObjectId).toString(),
    amountPaise: r.amountPaise,
    reasonCode: r.reasonCode as RefundReasonCode,
    state: r.state,
    createdAt: (r as unknown as { createdAt: Date }).createdAt,
  }));
}

// ---------------------------------------------------------------------------
// API-077 — documents. Honest about what exists: `margPdfRef`/`photoRef` are
// opaque string refs (models/MargBill.ts, models/Movement.ts) — this session
// never wired real object storage or signed URLs to them (models/File.ts's
// own comment: "shape and route contracts only... real object storage
// integration is a later milestone"). This lists what a document IS and
// whether a ref exists, rather than fabricating a download URL that would
// 404. `download` is deliberately absent from the DTO, not merely empty.
// ---------------------------------------------------------------------------

export interface OrderDocumentDto {
  kind: 'invoice' | 'eway_bill' | 'lr' | 'dispatch_photo';
  available: boolean;
  ref?: string;
}

/**
 * The access token carries no buyer/seller discriminator (`shared/tokens.ts`
 * `AccessTokenClaims` — a `both` firm's counterpartyId is the same value
 * either app calls with), so ownership is resolved by trying both sides
 * rather than trusting a client-asserted role.
 */
async function loadSoForActor(
  actorCounterpartyId: string,
  soId: string,
): Promise<InstanceType<typeof So>> {
  const buyer = await Buyer.findOne({ counterpartyId: actorCounterpartyId });
  if (buyer) {
    const so = await So.findOne({ _id: soId, buyerId: buyer._id });
    if (so) return so;
  }
  const seller = await Seller.findOne({ counterpartyId: actorCounterpartyId });
  if (seller) {
    const so = await So.findOne({ _id: soId, sellerId: seller._id });
    if (so) return so;
  }
  throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
}

export async function getOrderDocuments(
  actorCounterpartyId: string,
  soId: string,
): Promise<OrderDocumentDto[]> {
  const so = await loadSoForActor(actorCounterpartyId, soId);
  const { MargBill } = await import('../../models/MargBill.js');
  const margBill = await MargBill.findOne({ soId: so._id, state: 'matched' });
  const leg1 = await Movement.findOne({ chainId: so.chainId, leg: 1 });

  return [
    { kind: 'invoice', available: !!margBill?.margPdfRef, ref: margBill?.margPdfRef ?? undefined },
    { kind: 'eway_bill', available: !!margBill?.ewayNo, ref: margBill?.ewayNo ?? undefined },
    { kind: 'lr', available: !!leg1?.lr, ref: leg1?.lr ?? undefined },
    {
      kind: 'dispatch_photo',
      available: !!leg1?.photoRef,
      ref: leg1?.photoRef ?? undefined,
    },
  ];
}
