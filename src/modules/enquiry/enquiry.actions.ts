import type { Types } from 'mongoose';
import { Enquiry, type EnquiryDesk, type EnquiryDropReason } from '../../models/Enquiry.js';
import { Ask } from '../../models/Ask.js';
import { Buyer } from '../../models/Buyer.js';
import { Seller } from '../../models/Seller.js';
import { Sku } from '../../models/Sku.js';
import { Employee } from '../../models/Employee.js';
import { Role } from '../../models/Role.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { assertCounterpartyActive } from '../../shared/guards.js';
import { appendProxyLog } from '../../shared/proxyLog.js';
import type { DeliveryBand, ExpiryBand } from '../../models/ListingLine.js';
import * as demandService from '../demand/demand.service.js';
import { nextEnquiryNo } from '../chain/chain.numbering.js';
import { DROPPED, LISTED, PRE_TRADE, type EnquiryPartyKind } from './enquiry.status.js';
import { enquiryDeskOf, type EnquiryAudience } from './enquiry.service.js';

/**
 * Enquiry journey — the WRITE side of `enquiry` (DEC-051/052). None of these
 * touches the trade itself: creating a catalogue enquiry for a registered
 * buyer IS raising an ask (the same `raiseAsk` API-040 and API-202 call), and
 * every other trade action stays on its existing endpoint. What lives here is
 * what only the enquiry record has: the pre-trade enquiry, and the owner,
 * follow-up and notes each desk keeps on it.
 */

export interface StaffContext {
  employeeId: string;
  audience: EnquiryAudience;
  correlationId: string;
  permissions: readonly string[];
}

/** DEC-052 — buyer party needs Sales's call permission, seller party Purchase's. */
function assertMayActForParty(ctx: StaffContext, party: EnquiryPartyKind): void {
  const needed = party === 'buyer' ? PERMISSIONS.PROXY_BUYER_CALL : PERMISSIONS.PROXY_SELLER_CALL;
  if (!ctx.permissions.includes(needed)) {
    throw new AppError({
      code: 'PERMISSION_DENIED',
      messageEn: `You do not have the "${needed}" permission.`,
    });
  }
}

async function loadEnquiry(enquiryId: string) {
  const enquiry = await Enquiry.findById(enquiryId).catch(() => null);
  if (!enquiry) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Enquiry not found.' });
  return enquiry;
}

async function buyerByCounterparty(buyerCounterpartyId: string) {
  const buyer = await Buyer.findOne({ counterpartyId: buyerCounterpartyId }).catch(() => null);
  if (!buyer) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'No registered buyer with that id.',
      field: 'buyerCounterpartyId',
    });
  }
  return buyer;
}

async function sellerByCounterparty(sellerCounterpartyId: string) {
  const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId }).catch(() => null);
  if (!seller) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'No registered seller with that id.',
      field: 'sellerCounterpartyId',
    });
  }
  return seller;
}

// ---------------------------------------------------------------------------
// Create — API-212
// ---------------------------------------------------------------------------

export interface CreateEnquiryInput {
  party?: EnquiryPartyKind; // Default `buyer`.
  buyerCounterpartyId?: string;
  sellerCounterpartyId?: string;
  prospect?: { firm: string; contactName?: string; mobile?: string; place?: string };
  skuId?: string;
  productText?: string;
  qty: number;
  conditionRequirement?: { expiryBand: ExpiryBand; deliveryBand?: DeliveryBand };
  callNote: string;
}

/**
 * A registered buyer asking for a catalogue pack is an ask, raised exactly as
 * API-202 raises it (same `raiseAsk`, same call note on the ask). Everything
 * else — a prospect not yet registered on either side, a product not in the
 * catalogue, or a seller party at all (no automatic "raise a listing"
 * equivalent exists) — is a pre-trade enquiry (DEC-052), kept until Sales or
 * Purchase (whichever party it is) converts/marks-listed or drops it.
 */
export async function createEnquiry(
  input: CreateEnquiryInput,
  ctx: StaffContext,
): Promise<{ enquiryId: string; enquiryNo: string; askId?: string }> {
  const party = input.party ?? 'buyer';
  assertMayActForParty(ctx, party);

  if (party === 'buyer' && input.buyerCounterpartyId && input.skuId) {
    if (!input.conditionRequirement) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: 'An expiry requirement is needed to raise the ask.',
        field: 'conditionRequirement',
      });
    }
    const { askId, enquiryId } = await demandService.raiseAsk(
      input.buyerCounterpartyId,
      {
        skuId: input.skuId,
        allPacks: false,
        qty: input.qty,
        conditionRequirement: input.conditionRequirement,
      },
      { channel: 'sales_call', raisedBy: ctx.employeeId },
    );
    await appendProxyLog(Ask, askId, {
      actingStaffId: ctx.employeeId,
      callNote: input.callNote,
      action: 'raise_ask',
    });
    const enquiry = await Enquiry.findById(enquiryId, { enquiryNo: 1 });
    return { enquiryId, enquiryNo: enquiry!.enquiryNo, askId };
  }

  // Pre-trade (DEC-052) — buyer party without a catalogue pack yet, or any seller party.
  let buyerId: Types.ObjectId | null = null;
  let sellerId: Types.ObjectId | null = null;
  if (party === 'buyer' && input.buyerCounterpartyId) {
    const buyer = await buyerByCounterparty(input.buyerCounterpartyId);
    await assertCounterpartyActive(input.buyerCounterpartyId); // QR-015 — no new activity.
    buyerId = buyer._id as Types.ObjectId;
  }
  if (party === 'seller' && input.sellerCounterpartyId) {
    const seller = await sellerByCounterparty(input.sellerCounterpartyId);
    await assertCounterpartyActive(input.sellerCounterpartyId); // QR-015 — no new activity.
    sellerId = seller._id as Types.ObjectId;
  }
  let productId: Types.ObjectId | null = null;
  if (input.skuId) {
    const sku = await Sku.findById(input.skuId).catch(() => null);
    if (!sku)
      throw new AppError({ code: 'VALIDATION_FAILED', messageEn: 'Unknown pack.', field: 'skuId' });
    productId = sku.productId as Types.ObjectId;
  }

  const now = new Date();
  const created = await withTransaction(async (session) => {
    const [enquiry] = await Enquiry.create(
      [
        {
          enquiryNo: await nextEnquiryNo(now, session),
          kind: 'pre_trade',
          party,
          channel: 'sales_call',
          raisedAt: now,
          raisedBy: ctx.employeeId,
          buyerId,
          sellerId,
          prospect: buyerId || sellerId ? null : (input.prospect ?? null),
          skuId: input.skuId ?? null,
          productId,
          productText: input.skuId ? null : (input.productText ?? null),
          qty: input.qty,
          requirement: input.conditionRequirement
            ? {
                expiryBand: input.conditionRequirement.expiryBand,
                deliveryBand: input.conditionRequirement.deliveryBand ?? null,
              }
            : null,
          ...PRE_TRADE,
          statusChangedAt: now,
          notes: [
            {
              desk: party === 'buyer' ? 'sales' : 'purchase',
              authorId: ctx.employeeId,
              text: input.callNote,
              at: now,
            },
          ],
        },
      ],
      { session, ordered: true },
    );
    if (!enquiry) throw new Error('Enquiry.create returned no document.');
    await writeAuditLog(
      {
        actorId: ctx.employeeId,
        actorType: 'staff',
        entity: 'enquiry',
        entityId: enquiry._id as Types.ObjectId,
        field: 'status',
        newValue: 'pre_trade',
        correlationId: ctx.correlationId,
      },
      session,
    );
    return enquiry;
  });
  return { enquiryId: String(created._id), enquiryNo: created.enquiryNo };
}

// ---------------------------------------------------------------------------
// Edit — API-219 (pre-trade only)
// ---------------------------------------------------------------------------

export interface EditEnquiryInput {
  qty?: number;
  conditionRequirement?: { expiryBand: ExpiryBand; deliveryBand?: DeliveryBand };
  prospect?: { firm: string; contactName?: string; mobile?: string; place?: string };
  productText?: string;
  callNote: string;
}

/**
 * DEC-052 — the still-draft descriptive fields on a pre-trade enquiry: qty,
 * the requirement, and whichever of prospect/productText it actually has.
 * Identity (buyer/prospect, catalogue pack) is not editable here — that is
 * what converting does. Refuses once the enquiry is no longer pre-trade.
 */
export async function editEnquiry(
  enquiryId: string,
  input: EditEnquiryInput,
  ctx: StaffContext,
): Promise<void> {
  const enquiry = await loadEnquiry(enquiryId);
  if (enquiry.status !== 'pre_trade') {
    throw new AppError({
      code: 'ENQUIRY_NOT_OPEN',
      messageEn: 'Only an open pre-trade enquiry can be edited.',
    });
  }
  assertMayActForParty(ctx, enquiry.party as EnquiryPartyKind);
  if (input.prospect && !enquiry.prospect) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This enquiry is for a registered party, not a prospect.',
      field: 'prospect',
    });
  }
  if (input.productText && !enquiry.productText) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This enquiry is for a catalogue pack, not free text.',
      field: 'productText',
    });
  }

  const now = new Date();
  const desk = enquiry.party === 'seller' ? 'purchase' : 'sales';
  await withTransaction(async (session) => {
    await Enquiry.updateOne(
      { _id: enquiry._id },
      {
        $set: {
          ...(input.qty !== undefined ? { qty: input.qty } : {}),
          ...(input.conditionRequirement
            ? {
                requirement: {
                  expiryBand: input.conditionRequirement.expiryBand,
                  deliveryBand: input.conditionRequirement.deliveryBand ?? null,
                },
              }
            : {}),
          ...(input.prospect ? { prospect: input.prospect } : {}),
          ...(input.productText ? { productText: input.productText } : {}),
        },
        $push: {
          notes: { desk, authorId: ctx.employeeId, text: input.callNote, at: now },
        },
      },
      { session },
    );
    await writeAuditLog(
      {
        actorId: ctx.employeeId,
        actorType: 'staff',
        entity: 'enquiry',
        entityId: enquiry._id as Types.ObjectId,
        field: 'edit',
        newValue: input,
        correlationId: ctx.correlationId,
      },
      session,
    );
  });
}

// ---------------------------------------------------------------------------
// Convert and drop — API-213, API-214 (pre-trade only)
// ---------------------------------------------------------------------------

export interface ConvertEnquiryInput {
  buyerCounterpartyId: string;
  skuId: string;
  qty?: number;
  conditionRequirement: { expiryBand: ExpiryBand; deliveryBand?: DeliveryBand };
  callNote: string;
}

/**
 * DEC-052 — the buyer is registered and the pack exists: raise the ask as
 * this same enquiry. Buyer party only — a seller enquiry has no equivalent
 * one-step conversion (a real listing needs rate/MOQ/batch terms this record
 * does not collect); Purchase marks it `listed` instead, once made.
 */
export async function convertEnquiry(
  enquiryId: string,
  input: ConvertEnquiryInput,
  ctx: StaffContext,
): Promise<{ enquiryId: string; askId: string }> {
  const enquiry = await loadEnquiry(enquiryId);
  if (enquiry.status !== 'pre_trade') {
    throw new AppError({
      code: 'ENQUIRY_NOT_OPEN',
      messageEn: 'Only an open pre-trade enquiry can be converted to an ask.',
    });
  }
  if (enquiry.party === 'seller') {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'A seller enquiry does not convert to an ask — mark it listed instead.',
    });
  }
  assertMayActForParty(ctx, 'buyer');
  // raiseAsk re-checks the enquiry inside its own transaction; the check above
  // only refuses early, before the buyer and head-start lookups.
  const { askId } = await demandService.raiseAsk(
    input.buyerCounterpartyId,
    {
      skuId: input.skuId,
      allPacks: false,
      qty: input.qty ?? enquiry.qty,
      conditionRequirement: input.conditionRequirement,
    },
    { enquiryId, channel: 'sales_call', raisedBy: ctx.employeeId },
  );
  await appendProxyLog(Ask, askId, {
    actingStaffId: ctx.employeeId,
    callNote: input.callNote,
    action: 'convert_enquiry',
  });
  return { enquiryId, askId };
}

export async function dropEnquiry(
  enquiryId: string,
  input: { reason: EnquiryDropReason; callNote: string },
  ctx: StaffContext,
): Promise<void> {
  const enquiry = await loadEnquiry(enquiryId);
  if (enquiry.status !== 'pre_trade') {
    throw new AppError({
      code: 'ENQUIRY_NOT_OPEN',
      messageEn: 'Only an open pre-trade enquiry can be dropped.',
    });
  }
  assertMayActForParty(ctx, enquiry.party as EnquiryPartyKind);
  const desk = enquiry.party === 'seller' ? 'purchase' : 'sales';
  const now = new Date();
  await withTransaction(async (session) => {
    const result = await Enquiry.updateOne(
      { _id: enquiry._id, status: 'pre_trade' },
      {
        $set: { ...DROPPED, statusChangedAt: now, closedAt: now, dropReason: input.reason },
        $push: { notes: { desk, authorId: ctx.employeeId, text: input.callNote, at: now } },
      },
      { session },
    );
    if (result.matchedCount === 0) {
      throw new AppError({
        code: 'ENQUIRY_NOT_OPEN',
        messageEn: 'Only an open pre-trade enquiry can be dropped.',
      });
    }
    await writeAuditLog(
      {
        actorId: ctx.employeeId,
        actorType: 'staff',
        entity: 'enquiry',
        entityId: enquiry._id as Types.ObjectId,
        field: 'status',
        oldValue: 'pre_trade',
        newValue: 'dropped',
        reason: input.reason,
        correlationId: ctx.correlationId,
      },
      session,
    );
  });
}

/**
 * DEC-052 — a seller pre-trade enquiry's other exit: Purchase made him a
 * listing separately (on the existing seller-listing screen), so this
 * enquiry is done. No automatic link to that listing — see enquiry.status.ts.
 */
export async function markEnquiryListed(
  enquiryId: string,
  input: { callNote: string },
  ctx: StaffContext,
): Promise<void> {
  const enquiry = await loadEnquiry(enquiryId);
  if (enquiry.status !== 'pre_trade' || enquiry.party !== 'seller') {
    throw new AppError({
      code: 'ENQUIRY_NOT_OPEN',
      messageEn: 'Only an open pre-trade seller enquiry can be marked listed.',
    });
  }
  assertMayActForParty(ctx, 'seller');
  const now = new Date();
  await withTransaction(async (session) => {
    const result = await Enquiry.updateOne(
      { _id: enquiry._id, status: 'pre_trade' },
      {
        $set: { ...LISTED, statusChangedAt: now, closedAt: now },
        $push: {
          notes: { desk: 'purchase', authorId: ctx.employeeId, text: input.callNote, at: now },
        },
      },
      { session },
    );
    if (result.matchedCount === 0) {
      throw new AppError({
        code: 'ENQUIRY_NOT_OPEN',
        messageEn: 'Only an open pre-trade seller enquiry can be marked listed.',
      });
    }
    await writeAuditLog(
      {
        actorId: ctx.employeeId,
        actorType: 'staff',
        entity: 'enquiry',
        entityId: enquiry._id as Types.ObjectId,
        field: 'status',
        oldValue: 'pre_trade',
        newValue: 'listed',
        correlationId: ctx.correlationId,
      },
      session,
    );
  });
}

// ---------------------------------------------------------------------------
// Owner, follow-up, notes — API-215 to API-218 (enquiry:manage)
// ---------------------------------------------------------------------------

type WorkDesk = Exclude<EnquiryDesk, 'full'>;

/** The permission that makes an employee eligible to own a desk's half of an enquiry. */
const DESK_PERMISSION: Record<WorkDesk, string> = {
  sales: PERMISSIONS.PROXY_BUYER_CALL,
  purchase: PERMISSIONS.PROXY_SELLER_CALL,
};

/**
 * Sales works the Sales half, Purchase the Purchase half; the full view
 * (Controller, Admin) may work either. Logistics has no half to work.
 */
function assertMayWorkDesk(ctx: StaffContext, desk: WorkDesk | undefined): WorkDesk {
  const own = enquiryDeskOf(ctx.audience);
  if (!own) {
    throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Not available to this desk.' });
  }
  if (own === 'full') {
    if (!desk) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: 'Say which desk — sales or purchase.',
        field: 'desk',
      });
    }
    return desk;
  }
  if (desk && desk !== own) {
    throw new AppError({
      code: 'PERMISSION_DENIED',
      messageEn: `The ${own} desk cannot change the ${desk} desk's half of an enquiry.`,
    });
  }
  return own;
}

async function eligibleEmployeeIds(desk: WorkDesk): Promise<Set<string>> {
  const roles = await Role.find({ permissionKeys: DESK_PERMISSION[desk] }, { _id: 1 });
  const employees = await Employee.find(
    { roleIds: { $in: roles.map((r) => r._id) }, active: true },
    { _id: 1 },
  );
  return new Set(employees.map((e) => String(e._id)));
}

/** `API-218` — who can own this desk's half: active staff holding that desk's call permission. */
export async function listAssignees(
  desk: WorkDesk,
  ctx: StaffContext,
): Promise<Array<{ employeeId: string; name: string }>> {
  assertMayWorkDesk(ctx, desk);
  const ids = [...(await eligibleEmployeeIds(desk))];
  const employees = await Employee.find({ _id: { $in: ids } }, { person: 1 }).sort({ person: 1 });
  return employees.map((e) => ({ employeeId: String(e._id), name: e.person }));
}

export async function setOwner(
  enquiryId: string,
  input: { desk?: WorkDesk; employeeId: string | null },
  ctx: StaffContext,
): Promise<void> {
  const desk = assertMayWorkDesk(ctx, input.desk);
  const enquiry = await loadEnquiry(enquiryId);
  if (input.employeeId && !(await eligibleEmployeeIds(desk)).has(input.employeeId)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: `That person cannot own the ${desk} side of an enquiry.`,
      field: 'employeeId',
    });
  }
  const oldValue = enquiry.owners?.[desk] ? String(enquiry.owners[desk]) : null;
  await withTransaction(async (session) => {
    await Enquiry.updateOne(
      { _id: enquiry._id },
      { $set: { [`owners.${desk}`]: input.employeeId } },
      { session },
    );
    await writeAuditLog(
      {
        actorId: ctx.employeeId,
        actorType: 'staff',
        entity: 'enquiry',
        entityId: enquiry._id as Types.ObjectId,
        field: `owners.${desk}`,
        oldValue,
        newValue: input.employeeId,
        correlationId: ctx.correlationId,
      },
      session,
    );
  });
}

export async function setFollowUp(
  enquiryId: string,
  input: { desk?: WorkDesk; at: Date | null },
  ctx: StaffContext,
): Promise<void> {
  const desk = assertMayWorkDesk(ctx, input.desk);
  const enquiry = await loadEnquiry(enquiryId);
  await Enquiry.updateOne({ _id: enquiry._id }, { $set: { [`followUp.${desk}`]: input.at } });
}

export async function addNote(
  enquiryId: string,
  input: { text: string },
  ctx: StaffContext,
): Promise<void> {
  const desk = enquiryDeskOf(ctx.audience);
  if (!desk) {
    throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Not available to this desk.' });
  }
  const enquiry = await loadEnquiry(enquiryId);
  await Enquiry.updateOne(
    { _id: enquiry._id },
    { $push: { notes: { desk, authorId: ctx.employeeId, text: input.text, at: new Date() } } },
  );
}
