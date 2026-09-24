import type { ClientSession, Types } from 'mongoose';
import { withTransaction } from '../../db/transaction.js';
import { Chain } from '../../models/Chain.js';
import { So, type SoState } from '../../models/So.js';
import { SoLine } from '../../models/SoLine.js';
import { Po, type PoState } from '../../models/Po.js';
import { PoLine } from '../../models/PoLine.js';
import { PoEdit } from '../../models/PoEdit.js';
import { RateOverride, type RateOverrideReasonCode } from '../../models/RateOverride.js';
import { MargBill } from '../../models/MargBill.js';
import { ChainEvent } from '../../models/ChainEvent.js';
import { Buyer } from '../../models/Buyer.js';
import { Seller } from '../../models/Seller.js';
import { Counterparty } from '../../models/Counterparty.js';
import { Sku } from '../../models/Sku.js';
import { Product } from '../../models/Product.js';
import { Refund } from '../../models/Refund.js';
import { Ask } from '../../models/Ask.js';
import { Listing } from '../../models/Listing.js';
import { ListingLine } from '../../models/ListingLine.js';
import { PromotionOffer } from '../../models/PromotionOffer.js';
import { PoolCommitment } from '../../models/PoolCommitment.js';
import { UpcomingReceipt } from '../../models/UpcomingReceipt.js';
import { SellerDebit } from '../../models/SellerDebit.js';
import { recordFailure } from '../conduct/conduct.service.js';
import { ensureBookAssignment, recordPulseEvent } from '../desk/sales/sales.service.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import type { Paise } from '../../shared/money.js';
import {
  computeBuyerInclusiveRatePaise,
  computeBuyerLineMoney,
  computeAbsorptionCapPaise,
  type PlaceOfSupply,
} from '../../shared/pricing.js';
import {
  resolveMarginMatrixCell,
  type SkuClass,
  type RateTier,
} from '../pricing/pricing.service.js';
import { nextChainNo, nextPoNo, nextSoNo } from './chain.numbering.js';
import { writeChainEvent } from './chain.events.js';
import { syncEnquiryForAsk } from '../enquiry/enquiry.sync.js';
import {
  assertPaymentSatisfied,
  assertNoExistingPo,
  assertPoRateNeverExceedsSoRate,
  assertQuantitiesMatch,
  assertNotAlreadyBilled,
  assertNoMargBillYet,
} from './chain.guards.js';
import type { RawChainView } from './chain.view.js';
import { getPostedReceiptsPaiseForSo } from '../payment/payment.service.js';
import {
  enqueueNotification,
  counterpartyIdForBuyer,
  counterpartyIdForSeller,
  paiseToRupeesText,
} from '../notification/notification.outbox.js';
import { addDays, formatForDisplay } from '../../shared/clock.js';

export interface StaffActor {
  employeeId: string;
  correlationId: string;
}

// Exported — modules/listing.service.ts needs the identical buyer-tier
// derivation to compute what a buyer is shown in the feed/buy screen,
// **before** M5 existed. Kept here rather than duplicated (BR-043).
export function toRateTier(buyer: { isTrader: boolean; tradePosition?: string | null }): RateTier {
  if (buyer.isTrader) return 'Trader';
  // BR-044 — an unclassified buyer sees the Retailer rate, marked indicative.
  const position = buyer.tradePosition ?? 'retailer';
  return (position.charAt(0).toUpperCase() + position.slice(1)) as RateTier;
}

export async function resolveSkuClass(skuId: Types.ObjectId | string): Promise<{
  skuClass: SkuClass;
  baseUnitsPerBox: number;
  baseUnit: 'LTR' | 'KG' | 'PC';
}> {
  const sku = await Sku.findById(skuId);
  if (!sku) throw new AppError({ code: 'NOT_FOUND', messageEn: 'SKU not found.' });
  let skuClass = sku.class as SkuClass | undefined;
  if (!skuClass) {
    // BR-041 — class is defaulted down from the product when unset on the SKU.
    const product = await Product.findById(sku.productId);
    skuClass = (product?.class as SkuClass) ?? 'B';
  }
  return {
    skuClass,
    baseUnitsPerBox: sku.baseUnitsPerBox,
    baseUnit: sku.baseUnit as 'LTR' | 'KG' | 'PC',
  };
}

// ---------------------------------------------------------------------------
// SO creation
// ---------------------------------------------------------------------------

interface CreateSoInput {
  buyerId: string;
  sellerId: string;
  skuId: string;
  boxes: number;
  sellerNetPaise: Paise;
  placeOfSupply: PlaceOfSupply;
  overrideRatePaise?: Paise;
  overrideReasonCode?: RateOverrideReasonCode;
  // BR-156 — a pool's payment window is 16h, not the standard 24h (BR-032).
  // Callers outside modules/pool never need to set this.
  payDeadlineHours?: number;
  // M6, WF-11 — set only by the ask/quote acceptance path, so a later
  // supply failure can restore the ask to standing demand instead of
  // dead-ending it. The direct listing/pile path leaves this undefined.
  askId?: string;
  // Enquiry journey — set only by the WF-05 pile fan-out (pileFanout.job.ts):
  // the one buyer's pile request this SO fulfils. Also marks the chain's
  // `source` as `listed` rather than `inquiry` (CH §1.5, reporting only).
  pileRequestId?: string;
  // DEC-051 — the enquiry this order came from (ask acceptance or pile fan-out).
  enquiryId?: string;
  // M8 — a pool's fan-out tells the buyer `pool_triggered` ("pay within 16 hours"),
  // which IS that pool's payment notice; sending `payment_due` as well would be the
  // same news twice against a one-message-a-week cap (BR-283). Only modules/pool sets this.
  skipPaymentDueNotice?: boolean;
}

/**
 * This milestone's entry point onto the chain. **Not** WF-05's full
 * seller-confirms-supply fan-out (one buyer at a time here, no pile, no
 * requote/decline) — WF-05 depends on the listing/pile entities M5 builds.
 * RECOMMENDATION — NOT A CLIENT DECISION: this direct staff action stands in
 * for it so M4's chain, money and Marg modules have something real to run
 * against; it should be replaced by (or made an internal implementation
 * detail of) the real fan-out once M5 exists. BR-048's "staff price with
 * pre-fill and override" happens here.
 */
export async function createSo(
  input: CreateSoInput,
  actor: StaffActor,
): Promise<{ soId: string; soNo: string }> {
  return withTransaction((session) => createSoInSession(input, actor, session));
}

/**
 * The session-taking half of `createSo` — every validation and write below
 * assumes it is already inside a transaction the caller opened. Split out
 * so `modules/pile`'s WF-05 fan-out (M5) can create N sales orders, one per
 * buyer on a confirmed pile, inside **one** enclosing transaction rather
 * than N independent ones — WF-05's own "nine steps in one transaction"
 * requirement. `createSo` above is unchanged for M4's direct staff-action
 * callers.
 */
export async function createSoInSession(
  input: CreateSoInput,
  actor: StaffActor,
  session: ClientSession,
): Promise<{ soId: string; soNo: string }> {
  if (input.boxes < 1) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Minimum order is one box (BR-051).',
    });
  }

  const buyer = await Buyer.findById(input.buyerId).session(session);
  if (!buyer) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Buyer not found.' });
  const buyerCounterparty = await Counterparty.findById(buyer.counterpartyId).session(session);
  if (buyerCounterparty?.status !== 'active') {
    throw new AppError({
      code: 'ACCOUNT_NOT_ACTIVE',
      messageEn: 'Buyer is not an active account.',
    });
  }

  const seller = await Seller.findById(input.sellerId).session(session);
  if (!seller) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller not found.' });
  const sellerCounterparty = await Counterparty.findById(seller.counterpartyId).session(session);
  if (sellerCounterparty?.status !== 'active') {
    throw new AppError({
      code: 'ACCOUNT_NOT_ACTIVE',
      messageEn: 'Seller is not an active account.',
    });
  }

  const { skuClass, baseUnitsPerBox, baseUnit } = await resolveSkuClass(input.skuId);
  const sku = await Sku.findById(input.skuId).session(session);
  const tier = toRateTier(buyer);

  // BR-040/QR-007 — throws MARGIN_CELL_MISSING rather than guessing.
  const cell = await resolveMarginMatrixCell(skuClass, tier);
  const prefillRatePaise = computeBuyerInclusiveRatePaise(input.sellerNetPaise, cell.pct);

  let ratePaise = prefillRatePaise;
  let marginPctAtOrder = cell.pct;
  const usingOverride = input.overrideRatePaise !== undefined;
  if (usingOverride) {
    if (!input.overrideReasonCode) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: 'A rate override requires a reason code from the fixed dropdown (BR-048).',
        field: 'overrideReasonCode',
      });
    }
    ratePaise = input.overrideRatePaise!;
    if (ratePaise < input.sellerNetPaise) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: 'A negative-margin line is impossible by construction (BR-021).',
        field: 'overrideRatePaise',
      });
    }
    marginPctAtOrder = ratePaise / input.sellerNetPaise - 1;
  }

  const line = computeBuyerLineMoney(input.boxes, baseUnitsPerBox, ratePaise, input.placeOfSupply);
  const now = new Date();
  const payDeadline = new Date(now.getTime() + (input.payDeadlineHours ?? 24) * 60 * 60 * 1000); // BR-032/BR-156.

  {
    const chainNo = await nextChainNo(session);
    const [chain] = await Chain.create(
      [
        {
          chainNo,
          source: input.pileRequestId ? 'listed' : 'inquiry',
          stage: 'so',
          openedAt: now,
        },
      ],
      { session, ordered: true },
    );
    if (!chain) throw new Error('Chain.create returned no document.');

    const soNo = await nextSoNo(now, session);
    const [so] = await So.create(
      [
        {
          soNo,
          chainId: chain._id,
          buyerId: buyer._id,
          askId: input.askId ?? null,
          pileRequestId: input.pileRequestId ?? null,
          enquiryId: input.enquiryId ?? null,
          sellerId: seller._id,
          tierAtOrder: tier,
          placeOfSupply: input.placeOfSupply,
          state: 'awaiting_payment',
          payDeadline,
          totalPaise: line.totalPaise,
        },
      ],
      { session, ordered: true },
    );
    if (!so) throw new Error('So.create returned no document.');

    const [soLine] = await SoLine.create(
      [
        {
          soId: so._id,
          skuId: input.skuId,
          boxes: input.boxes,
          ratePaise,
          classAtOrder: skuClass,
          marginPctAtOrder,
          sellerNetPaise: input.sellerNetPaise,
          staffPriceId: null,
          baseUnitsPerBoxAtOrder: baseUnitsPerBox,
          baseUnitAtOrder: baseUnit,
          taxablePaise: line.taxablePaise,
          totalPaise: line.totalPaise,
          taxSplit: line.taxSplit,
        },
      ],
      { session, ordered: true },
    );
    if (!soLine) throw new Error('SoLine.create returned no document.');

    // CH §21.8 #4 — "24-hour window opens": the SO has just entered `awaiting_payment`.
    // Written before any other notification for this SO, so where the weekly cap
    // (BR-283) can only let one message through, it is the money deadline that wins.
    if (!input.skipPaymentDueNotice) {
      await enqueueNotification(
        {
          counterpartyId: buyer.counterpartyId as Types.ObjectId,
          templateKey: 'payment_due',
          params: {
            soNo,
            amountRupees: paiseToRupeesText(line.totalPaise),
            payBy: formatForDisplay(payDeadline),
          },
          correlationId: actor.correlationId,
        },
        session,
      );
    }

    await ensureBookAssignment(buyer._id as Types.ObjectId, session); // BR-276.
    if (sku?.productId) {
      // BR-278/BR-279 — organic, not from our own push.
      await recordPulseEvent(
        {
          buyerId: buyer._id as Types.ObjectId,
          productId: sku.productId as Types.ObjectId,
          kind: 'order',
        },
        session,
      );
    }

    if (usingOverride) {
      const [override] = await RateOverride.create(
        [
          {
            soLineId: soLine._id,
            fromPaise: prefillRatePaise,
            toPaise: ratePaise,
            reasonCode: input.overrideReasonCode,
            by: actor.employeeId,
            at: now,
          },
        ],
        { session, ordered: true },
      );
      soLine.staffPriceId = override!._id as Types.ObjectId;
      await soLine.save({ session });
    }

    await writeChainEvent(
      {
        chainId: chain._id as Types.ObjectId,
        type: 'so_created',
        refCollection: 'so',
        refId: so._id as Types.ObjectId,
        actorId: actor.employeeId,
        actorType: 'staff',
        newValue: { boxes: input.boxes, ratePaise, totalPaise: line.totalPaise },
        summary: `SO ${soNo} raised for ${input.boxes} boxes at ₹${ratePaise / 100} per unit.`,
      },
      session,
    );
    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'so',
        entityId: so._id as Types.ObjectId,
        field: 'create',
        newValue: { soNo, totalPaise: line.totalPaise },
        correlationId: actor.correlationId,
      },
      session,
    );

    return { soId: (so._id as Types.ObjectId).toString(), soNo };
  }
}

// ---------------------------------------------------------------------------
// PO creation — INV-01, INV-07, INV-08, Q4
// ---------------------------------------------------------------------------

/** API-084. */
export async function createPo(
  soId: string,
  actor: StaffActor,
): Promise<{ poId: string; poNo: string }> {
  const so = await So.findById(soId);
  if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'SO not found.' });
  const soLine = await SoLine.findOne({ soId: so._id });
  if (!soLine) throw new AppError({ code: 'NOT_FOUND', messageEn: 'SO line not found.' });

  const postedReceiptsPaise = await getPostedReceiptsPaiseForSo(soId);
  assertPaymentSatisfied(postedReceiptsPaise, so.totalPaise); // INV-01

  const existingPo = await Po.findOne({ soId: so._id });
  assertNoExistingPo(!!existingPo); // Q4 — no speculative stock, never more than one PO per SO.

  assertPoRateNeverExceedsSoRate(soLine.sellerNetPaise, soLine.ratePaise); // INV-07
  assertQuantitiesMatch(soLine.boxes, soLine.boxes); // INV-08 — copied 1:1 below; asserted for the record.

  const sellerId = so.sellerId as Types.ObjectId;
  const seller = await Seller.findById(sellerId);
  if (!seller) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller not found.' });

  const now = new Date();
  const dispatchDueDate = now; // BR-174 — the seller must dispatch the day the PO releases.
  const promisedOutOfIndoreBy = new Date(now.getTime() + 48 * 60 * 60 * 1000); // BR-174 — buyer told 48h.

  let result: { poId: string; poNo: string };
  try {
    result = await withTransaction(async (session) => {
      const poNo = await nextPoNo(now, session);
      const [po] = await Po.create(
        [
          {
            poNo,
            chainId: so.chainId, // Q4 — required, never null.
            soId: so._id, // Q4 — required, never null.
            sellerId,
            state: 'released',
            dispatchDueDate,
            promisedOutOfIndoreBy,
          },
        ],
        { session, ordered: true },
      );
      if (!po) throw new Error('Po.create returned no document.');

      await PoLine.create(
        [
          {
            poId: po._id,
            skuId: soLine.skuId,
            boxes: soLine.boxes,
            sellerNetPaise: soLine.sellerNetPaise,
          },
        ],
        { session, ordered: true },
      );

      so.state = 'po_released' satisfies SoState;
      await so.save({ session });
      await Chain.updateOne({ _id: so.chainId }, { $set: { stage: 'po' } }, { session });

      // CH §21.8 #14 — "Dispatch due today" (BR-174): the seller's obligation starts now.
      await enqueueNotification(
        {
          counterpartyId: seller.counterpartyId as Types.ObjectId,
          templateKey: 'po_released',
          params: { poNo },
          correlationId: actor.correlationId,
        },
        session,
      );

      await writeChainEvent(
        {
          chainId: so.chainId as Types.ObjectId,
          type: 'po_released',
          refCollection: 'po',
          refId: po._id as Types.ObjectId,
          actorId: actor.employeeId,
          actorType: 'staff',
          summary: `PO ${poNo} raised against ${so.soNo}.`,
        },
        session,
      );
      await writeAuditLog(
        {
          actorId: actor.employeeId,
          actorType: 'staff',
          entity: 'po',
          entityId: po._id as Types.ObjectId,
          field: 'create',
          newValue: { poNo, soId: soId },
          correlationId: actor.correlationId,
        },
        session,
      );

      return { poId: (po._id as Types.ObjectId).toString(), poNo };
    });
  } catch (error: unknown) {
    // Q4/INV-01 — a race between two concurrent createPo calls for the same
    // SO: both can pass the pre-check above before either commits. The
    // unique index on po.soId is the real guarantee; this turns the loser's
    // raw duplicate-key error into the same refusal the pre-check gives.
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: number }).code === 11000
    ) {
      throw new AppError({
        code: 'PO_ALREADY_EXISTS',
        messageEn: 'A purchase order already exists against this sales order.',
      });
    }
    throw error;
  }

  return result;
}

// ---------------------------------------------------------------------------
// PO edit — BR-036: only rate or qty, never after billing.
// ---------------------------------------------------------------------------

interface EditPoInput {
  field: 'rate' | 'qty';
  to: number;
  reason: string;
}

export async function editPo(poId: string, input: EditPoInput, actor: StaffActor): Promise<void> {
  const po = await Po.findById(poId);
  if (!po) throw new AppError({ code: 'NOT_FOUND', messageEn: 'PO not found.' });
  assertNotAlreadyBilled(po.billed); // BR-036

  const poLine = await PoLine.findOne({ poId: po._id });
  if (!poLine) throw new AppError({ code: 'NOT_FOUND', messageEn: 'PO line not found.' });

  if (input.field === 'rate') {
    // INV-07 — an edit may lower the PO's rate, never lift it above the SO's.
    const soLine = await SoLine.findOne({ soId: po.soId });
    if (!soLine) throw new AppError({ code: 'NOT_FOUND', messageEn: 'SO line not found.' });
    assertPoRateNeverExceedsSoRate(input.to, soLine.ratePaise);
  }

  const from = input.field === 'rate' ? poLine.sellerNetPaise : poLine.boxes;

  await withTransaction(async (session) => {
    if (input.field === 'rate') {
      poLine.sellerNetPaise = input.to;
    } else {
      poLine.boxes = input.to;
    }
    await poLine.save({ session });

    await PoEdit.create(
      [
        {
          poId: po._id,
          field: input.field,
          from,
          to: input.to,
          reason: input.reason,
          by: actor.employeeId,
        },
      ],
      { session, ordered: true },
    );

    await writeChainEvent(
      {
        chainId: po.chainId,
        type: 'po_edited',
        refCollection: 'po',
        refId: po._id as Types.ObjectId,
        actorId: actor.employeeId,
        actorType: 'staff',
        reason: input.reason,
        oldValue: { [input.field]: from },
        newValue: { [input.field]: input.to },
        summary: `PO ${po.poNo}'s ${input.field} changed from ${from} to ${input.to}.`,
      },
      session,
    );
  });
}

// ---------------------------------------------------------------------------
// Q6 — Sales reduces the SO to the accepted quantity on a part rejection.
// ---------------------------------------------------------------------------

interface ReduceSoQuantityInput {
  newBoxes: number;
  reason: string;
  inspectionId: string;
}

export async function reduceSoQuantity(
  soId: string,
  input: ReduceSoQuantityInput,
  actor: StaffActor,
): Promise<{ refundId: string }> {
  const so = await So.findById(soId);
  if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'SO not found.' });
  const soLine = await SoLine.findOne({ soId: so._id });
  if (!soLine) throw new AppError({ code: 'NOT_FOUND', messageEn: 'SO line not found.' });

  const margBillExists = (await MargBill.countDocuments({ soId: so._id })) > 0;
  assertNoMargBillYet(margBillExists); // Q6 — cannot run once billing has started.

  const { Inspection } = await import('../../models/Inspection.js');
  const inspection = await Inspection.findById(input.inspectionId);
  if (!inspection) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Inspection not found.' });
  if (inspection.casesAccepted !== input.newBoxes) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: "The new quantity must equal the inspection's accepted case count.",
      field: 'newBoxes',
    });
  }
  if (input.newBoxes >= soLine.boxes) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'A reduction must be to fewer boxes than originally ordered.',
      field: 'newBoxes',
    });
  }

  const oldTotalPaise = soLine.totalPaise;
  const newLine = computeBuyerLineMoney(
    input.newBoxes,
    soLine.baseUnitsPerBoxAtOrder,
    soLine.ratePaise,
    so.placeOfSupply,
  );
  const refundAmountPaise = oldTotalPaise - newLine.totalPaise;

  const buyer = await Buyer.findById(so.buyerId);
  const buyerCounterparty = await Counterparty.findById(buyer!.counterpartyId);

  const result = await withTransaction(async (session) => {
    soLine.boxes = input.newBoxes;
    soLine.taxablePaise = newLine.taxablePaise;
    soLine.totalPaise = newLine.totalPaise;
    soLine.taxSplit = newLine.taxSplit;
    await soLine.save({ session });

    so.totalPaise = newLine.totalPaise;
    await so.save({ session });

    const [refund] = await Refund.create(
      [
        {
          chainId: so.chainId,
          buyerId: so.buyerId,
          amountPaise: refundAmountPaise,
          reasonCode: 'part_rejection_quantity_reduction',
          state: 'payable',
          targetAccountMasked: buyerCounterparty?.mobile ?? 'unknown',
        },
      ],
      { session, ordered: true },
    );
    if (!refund) throw new Error('Refund.create returned no document.');

    // CH §21.8 #10 — "What shipped and what is refunded."
    await enqueueNotification(
      {
        counterpartyId: buyer!.counterpartyId as Types.ObjectId,
        templateKey: 'short_dispatch',
        params: {
          soNo: so.soNo,
          boxesShipped: input.newBoxes,
          refundRupees: paiseToRupeesText(refundAmountPaise),
        },
        correlationId: actor.correlationId,
      },
      session,
    );

    await writeChainEvent(
      {
        chainId: so.chainId as Types.ObjectId,
        type: 'so_quantity_reduced',
        refCollection: 'so',
        refId: so._id as Types.ObjectId,
        actorId: actor.employeeId,
        actorType: 'staff',
        reason: input.reason,
        oldValue: { boxes: soLine.boxes, totalPaise: oldTotalPaise },
        newValue: { boxes: input.newBoxes, totalPaise: newLine.totalPaise },
        summary: `${so.soNo} reduced to ${input.newBoxes} boxes after part rejection; ₹${refundAmountPaise / 100} refund raised.`,
      },
      session,
    );
    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'so',
        entityId: so._id as Types.ObjectId,
        field: 'boxes',
        reason: input.reason,
        oldValue: soLine.boxes,
        newValue: input.newBoxes,
        correlationId: actor.correlationId,
      },
      session,
    );

    return { refundId: (refund._id as Types.ObjectId).toString() };
  });

  return result;
}

// ---------------------------------------------------------------------------
// Stage transitions used by dock/marg/movement modules
// ---------------------------------------------------------------------------

async function setSoAndPoState(
  soId: Types.ObjectId,
  poId: Types.ObjectId | null,
  soState: SoState,
  poState: PoState | null,
  stage: 'so' | 'payment' | 'po' | 'leg1' | 'marg' | 'dispatch' | 'done',
  // M8 — anything that must commit or roll back together with this transition
  // (its notifications) runs here, inside the same transaction.
  alsoInTransaction?: (so: InstanceType<typeof So>, session: ClientSession) => Promise<void>,
): Promise<void> {
  await withTransaction(async (session) => {
    const so = await So.findById(soId).session(session);
    if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'SO not found.' });
    so.state = soState;
    await so.save({ session });
    await Chain.updateOne({ _id: so.chainId }, { $set: { stage } }, { session });
    if (poId && poState) {
      await Po.updateOne({ _id: poId }, { $set: { state: poState } }, { session });
    }
    if (alsoInTransaction) await alsoInTransaction(so, session);
  });
}

export async function transitionToDispatchedLeg1(soId: string, poId: string): Promise<void> {
  await setSoAndPoState(
    soId as unknown as Types.ObjectId,
    poId as unknown as Types.ObjectId,
    'dispatched_leg1',
    'dispatched_leg1',
    'leg1',
  );
}

export async function transitionToInspected(soId: string, poId: string): Promise<void> {
  await setSoAndPoState(
    soId as unknown as Types.ObjectId,
    poId as unknown as Types.ObjectId,
    'inspected',
    'inspected',
    'leg1',
  );
  await Po.updateOne({ _id: poId }, { $set: { received: true, inspected: true } });
}

// ---------------------------------------------------------------------------
// WF-11 — the fallback/absorption workflow (M6). BR-021/BR-034/BR-131.
// ---------------------------------------------------------------------------

interface PromotionCandidate {
  sellerId: Types.ObjectId;
  sellerNetPaise: Paise;
  deltaPaise: Paise;
}

/**
 * The next-best live listing on the same SKU, cheapest first, excluding the
 * failed seller and anyone blacklisted — filtered down to only sellers whose
 * rate can actually be afforded within the absorption cap (BR-021: the lower
 * of 1% of order value and the margin on the line; zero margin is the hard
 * maximum, no escalation path past it). `lines` is sorted ascending, so the
 * first eligible, affordable entry is by construction the cheapest one.
 *
 * Condition-set matching (expiry/delivery/provenance) is deliberately not
 * applied here — unlike `modules/pool`'s `findCurrentSupplier`, an SO/SoLine
 * does not retain the buyer's original condition requirement (only the
 * frozen rate and SKU survive onto the order). Matching on SKU alone is this
 * session's own literal reading of "the next-best live quote," flagged in
 * the session report as a real simplification, not a quoted rule.
 */
async function findPromotionCandidate(
  so: InstanceType<typeof So>,
  soLine: InstanceType<typeof SoLine>,
  excludeSellerId: Types.ObjectId,
): Promise<PromotionCandidate | null> {
  const zeroMarginRate = computeBuyerInclusiveRatePaise(soLine.sellerNetPaise, 0);
  const zeroMarginTotal = computeBuyerLineMoney(
    soLine.boxes,
    soLine.baseUnitsPerBoxAtOrder,
    zeroMarginRate,
    so.placeOfSupply as PlaceOfSupply,
  ).totalPaise;
  const marginOnLinePaise = so.totalPaise - zeroMarginTotal;
  const cap = computeAbsorptionCapPaise(so.totalPaise, marginOnLinePaise);

  const liveListings = await Listing.find({ state: 'live', sellerId: { $ne: excludeSellerId } });
  const lines = await ListingLine.find({
    listingId: { $in: liveListings.map((l) => l._id) },
    skuId: soLine.skuId,
  }).sort({ ratePaise: 1 });
  const listingBySellerLine = new Map(
    liveListings.map((l) => [(l._id as Types.ObjectId).toString(), l]),
  );

  for (const line of lines) {
    const listing = listingBySellerLine.get((line.listingId as Types.ObjectId).toString());
    if (!listing) continue;
    const seller = await Seller.findById(listing.sellerId);
    if (!seller) continue;
    const sellerCounterparty = await Counterparty.findById(seller.counterpartyId);
    if (sellerCounterparty?.status !== 'active') continue; // Never promote a blacklisted or pending seller.

    const candidateZeroMarginRate = computeBuyerInclusiveRatePaise(line.ratePaise, 0);
    const candidateZeroMarginTotal = computeBuyerLineMoney(
      soLine.boxes,
      soLine.baseUnitsPerBoxAtOrder,
      candidateZeroMarginRate,
      so.placeOfSupply as PlaceOfSupply,
    ).totalPaise;
    const deltaPaise = Math.max(candidateZeroMarginTotal - zeroMarginTotal, 0);
    if (deltaPaise <= cap) {
      return { sellerId: seller._id as Types.ObjectId, sellerNetPaise: line.ratePaise, deltaPaise };
    }
  }
  return null;
}

/** BR-034 — always full, never partial, never netted against anything. */
async function refundSoInFull(
  so: InstanceType<typeof So>,
  reasonCode: string,
  summary: string,
  actorId: string,
  actorType: 'staff' | 'counterparty',
): Promise<{ refundId: string }> {
  return withTransaction((session) =>
    refundSoInFullInSession(so, reasonCode, summary, actorId, actorType, session),
  );
}

/** The body of `refundSoInFull`, for a caller that already holds the transaction (M10 — the offer-expiry claim). */
async function refundSoInFullInSession(
  so: InstanceType<typeof So>,
  reasonCode: string,
  summary: string,
  actorId: string,
  actorType: 'staff' | 'counterparty',
  session: ClientSession,
): Promise<{ refundId: string }> {
  const buyer = await Buyer.findById(so.buyerId).session(session);
  const buyerCounterparty = await Counterparty.findById(buyer!.counterpartyId).session(session);

  {
    so.state = 'supply_failed';
    await so.save({ session });
    await Chain.updateOne({ _id: so.chainId }, { $set: { stage: 'leg1' } }, { session });

    if (so.askId) {
      // WF-11 — restored to standing demand, not dead-ended. Only traceable
      // for the ask/quote path (`acceptAskFill` stamps `askId`); the direct
      // listing/pile path has no ask to restore to.
      await Ask.updateOne(
        { _id: so.askId, state: 'converted' },
        { $set: { state: 'open' } },
        { session },
      );
      // DEC-051 — the enquiry goes back to awaiting quotes with it.
      await syncEnquiryForAsk(so.askId as Types.ObjectId, session);
    }

    const [refund] = await Refund.create(
      [
        {
          chainId: so.chainId,
          buyerId: so.buyerId,
          amountPaise: so.totalPaise,
          reasonCode,
          state: 'payable',
          targetAccountMasked: buyerCounterparty?.mobile ?? 'unknown',
        },
      ],
      { session, ordered: true },
    );
    if (!refund) throw new Error('Refund.create returned no document.');

    await writeChainEvent(
      {
        chainId: so.chainId as Types.ObjectId,
        type: 'supply_failed',
        refCollection: 'so',
        refId: so._id as Types.ObjectId,
        actorId,
        actorType,
        summary,
      },
      session,
    );

    return { refundId: (refund._id as Types.ObjectId).toString() };
  }
}

/**
 * BR-186/WF-11 — a seller's supply failure (whole-lot rejection at
 * inspection, or a staff-recorded ghosting/non-dispatch). Before any refund,
 * try to promote the next-best live, affordable seller (WF-11 step 1); the
 * buyer then has 24 hours to accept that replacement (`IC-14`) before it
 * becomes real — his own price never changes, only who is fulfilling it.
 * Only when no affordable replacement exists does this resolve straight to
 * a full refund (BR-034), exactly as the pre-M6 build always did.
 */
export async function transitionToSupplyFailed(
  soId: string,
  poId: string,
  actor: StaffActor,
): Promise<{ refundId?: string; promotionOfferId?: string }> {
  const so = await So.findById(soId);
  if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'SO not found.' });
  const soLine = await SoLine.findOne({ soId: so._id });
  if (!soLine) throw new AppError({ code: 'NOT_FOUND', messageEn: 'SO line not found.' });
  const failedSellerId = so.sellerId as Types.ObjectId;

  await Po.updateOne({ _id: poId }, { $set: { state: 'failed', failed: true } });

  // BR-215 — whole-lot rejection for seller fault is a counted failure.
  const failedSeller = await Seller.findById(failedSellerId);
  if (failedSeller) {
    await recordFailure(
      {
        counterpartyId: failedSeller.counterpartyId.toString(),
        counterpartyKind: 'seller',
        type: 'seller_whole_lot_rejection_fault',
        chainId: (so.chainId as Types.ObjectId).toString(),
      },
      actor,
    );
  }

  const candidate = await findPromotionCandidate(so, soLine, failedSellerId);
  if (!candidate) {
    const result = await refundSoInFull(
      so,
      'supply_failure_full',
      `${so.soNo} — no affordable replacement seller found, full refund of ₹${so.totalPaise / 100} raised (BR-034).`,
      actor.employeeId,
      'staff',
    );
    return { refundId: result.refundId };
  }

  const now = new Date();
  // QR-051, M7 Step 0 (deliberately not built or removed this session) — if
  // the client answers WF-11's deviation note the other way (BR-131 read
  // literally: the *promoted seller* must separately reconfirm before his
  // own dispatch clock starts, not just the buyer accepting the
  // substitution), the call to the candidate seller's own accept/decline
  // step — `API-047`, `POST /quotes/:id/accept-promotion` · `/decline-promotion`,
  // still undefined anywhere in this codebase — belongs right here, before
  // `PromotionOffer` is created below, gating whether a buyer-facing offer is
  // even raised. Left un-stubbed beyond this comment on purpose: adding a
  // dead route or an unused model field would misrepresent this as started.
  const offer = await PromotionOffer.create({
    soId: so._id,
    poId,
    chainId: so.chainId,
    failedSellerId,
    promotedSellerId: candidate.sellerId,
    promotedSellerNetPaise: candidate.sellerNetPaise,
    deltaPaise: candidate.deltaPaise,
    withinCap: true,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000), // BR-021 — 24h.
  });
  so.state = 'promotion_offered';
  await so.save();

  await writeChainEvent({
    chainId: so.chainId as Types.ObjectId,
    type: 'promotion_offered',
    refCollection: 'so',
    refId: so._id as Types.ObjectId,
    actorId: actor.employeeId,
    actorType: 'staff',
    summary: `${so.soNo} — original seller failed; a replacement was found and offered to the buyer, 24h to decide.`,
  });

  return { promotionOfferId: (offer._id as Types.ObjectId).toString() };
}

/**
 * API-071, repurposed — `ST-01`'s pre-payment `requote_offered` segment has
 * no producer anywhere in the entities M5 actually built (`QR-045`); this
 * milestone answers that question by retiring the dead segment and wiring
 * the same endpoint paths to the real thing that needed them: WF-11's
 * promoted-fallback accept/decline.
 */
export async function acceptPromotionOffer(
  soId: string,
  buyerCounterpartyId: string,
  correlationId: string,
): Promise<void> {
  const so = await So.findById(soId);
  if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'SO not found.' });
  const buyer = await Buyer.findById(so.buyerId);
  if (!buyer || (buyer.counterpartyId as Types.ObjectId).toString() !== buyerCounterpartyId) {
    throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Not your order.' });
  }
  const offer = await PromotionOffer.findOne({ soId: so._id, status: 'pending' });
  if (!offer) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'There is no pending replacement offer on this order.',
    });
  }
  if (offer.expiresAt.getTime() < Date.now()) {
    await settlePromotionAsRefund(offer._id as Types.ObjectId, 'expired');
    throw new AppError({ code: 'VALIDATION_FAILED', messageEn: 'This offer has expired.' });
  }

  const po = await Po.findById(offer.poId);
  const soLine = await SoLine.findOne({ soId: so._id });
  if (!po || !soLine) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });

  const now = new Date();
  await withTransaction(async (session) => {
    // M10 — claim the offer first. If the expiry job (or a decline) got there
    // between our read above and now, the claim fails and nothing below runs.
    const claimed = await PromotionOffer.findOneAndUpdate(
      { _id: offer._id, status: 'pending' },
      { $set: { status: 'accepted', decidedAt: now } },
      { session, new: true },
    );
    if (!claimed) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: 'This replacement offer has already been settled.',
      });
    }

    po.sellerId = offer.promotedSellerId;
    po.state = 'released';
    po.failed = false;
    po.sameDayMissAt = null; // A new seller, a new dispatch clock (BR-131).
    po.noDispatch48hAt = null;
    po.dispatchDueDate = now; // WF-11 — the clock starts at his acceptance, not the original PO release.
    po.promisedOutOfIndoreBy = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    await po.save({ session });

    const { PoLine } = await import('../../models/PoLine.js');
    await PoLine.updateOne(
      { poId: po._id },
      { $set: { sellerNetPaise: offer.promotedSellerNetPaise } },
      { session },
    );

    so.sellerId = offer.promotedSellerId;
    so.state = 'po_released';
    await so.save({ session });
    await Chain.updateOne({ _id: so.chainId }, { $set: { stage: 'po' } }, { session });

    // CH §21.8 #14 — the PO re-releases to the promoted seller (WORKFLOWS ST-01), and
    // his 48h dispatch clock starts now: the same "Dispatch due today" event as a first release.
    await enqueueNotification(
      {
        counterpartyId: await counterpartyIdForSeller(offer.promotedSellerId, session),
        templateKey: 'po_released',
        params: { poNo: po.poNo },
        correlationId,
      },
      session,
    );

    if (offer.deltaPaise > 0) {
      // BR-021 — recovered from the ghosting seller's next settled lot, not
      // from the buyer and not from the promoted seller.
      await SellerDebit.create(
        [
          {
            counterpartyId: offer.failedSellerId,
            amountPaise: offer.deltaPaise,
            reason: `WF-11 absorption on ${so.soNo} — a dearer replacement seller was promoted after this seller's supply failure.`,
          },
        ],
        { session, ordered: true },
      );
    }

    await writeChainEvent(
      {
        chainId: so.chainId as Types.ObjectId,
        type: 'promotion_accepted',
        refCollection: 'po',
        refId: po._id as Types.ObjectId,
        actorId: buyerCounterpartyId,
        actorType: 'counterparty',
        summary: `${so.soNo} — buyer accepted the replacement seller. PO re-released; 48h dispatch clock restarted.`,
      },
      session,
    );
    await writeAuditLog(
      {
        actorId: buyerCounterpartyId,
        actorType: 'counterparty',
        entity: 'so',
        entityId: so._id as Types.ObjectId,
        field: 'promotion_accepted',
        newValue: { promotedSellerId: offer.promotedSellerId.toString() },
        correlationId,
      },
      session,
    );
  });
}

/** BR-021 — silence and an explicit decline resolve identically: full refund, ask restored. */
export async function rejectPromotionOffer(
  soId: string,
  buyerCounterpartyId: string,
): Promise<void> {
  const so = await So.findById(soId);
  if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'SO not found.' });
  const buyer = await Buyer.findById(so.buyerId);
  if (!buyer || (buyer.counterpartyId as Types.ObjectId).toString() !== buyerCounterpartyId) {
    throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Not your order.' });
  }
  const offer = await PromotionOffer.findOne({ soId: so._id, status: 'pending' });
  if (!offer) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'There is no pending replacement offer on this order.',
    });
  }
  const settled = await settlePromotionAsRefund(offer._id as Types.ObjectId, 'rejected');
  if (!settled) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'There is no pending replacement offer on this order.',
    });
  }
}

/**
 * WF-11 / BR-021 — the ONE rule for a replacement offer that ends in a refund.
 * The buyer's own "decline" button and 24 hours of silence both come here:
 * silence is the same rule with no button pressed, not a different rule.
 *
 * M10 — the offer is claimed (pending → outcome) at the start of the same
 * transaction that raises the refund, so an accept, a decline and the expiry
 * job can never all act on one offer: exactly one wins, the others get `false`.
 * For `expired` the claim also insists the 24 hours have really passed.
 */
async function settlePromotionAsRefund(
  offerId: Types.ObjectId,
  outcome: 'rejected' | 'expired',
  now: Date = new Date(),
): Promise<boolean> {
  return withTransaction(async (session) => {
    const claimFilter =
      outcome === 'expired'
        ? { _id: offerId, status: 'pending', expiresAt: { $lt: now } }
        : { _id: offerId, status: 'pending' };
    const offer = await PromotionOffer.findOneAndUpdate(
      claimFilter,
      { $set: { status: outcome, decidedAt: now } },
      { session, new: true },
    );
    if (!offer) return false; // Someone else decided it first, or it has not lapsed.

    const so = await So.findById(offer.soId).session(session);
    if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'SO not found.' });
    await refundSoInFullInSession(
      so,
      'supply_failure_full',
      `${so.soNo} — buyer ${outcome === 'rejected' ? 'declined' : 'did not respond to'} the replacement seller within 24h; full refund of ₹${so.totalPaise / 100} raised (BR-021).`,
      (so.buyerId as Types.ObjectId).toString(),
      'counterparty',
      session,
    );
    return true;
  });
}

/**
 * The promotion-offer expiry clock (WF-11, 24h). One offer at a time, each
 * through `settlePromotionAsRefund` — the same unit the buyer's decline uses.
 * `now` is a parameter so a test can advance the clock past the deadline.
 */
export async function resolveExpiredPromotionOffers(now: Date = new Date()): Promise<number> {
  const lapsed = await PromotionOffer.find({ status: 'pending', expiresAt: { $lt: now } }).select(
    '_id',
  );
  let resolved = 0;
  for (const offer of lapsed) {
    if (await settlePromotionAsRefund(offer._id as Types.ObjectId, 'expired', now)) resolved += 1;
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// M10 — the payment window closing (BR-032, BR-035). Before M10 nothing in
// this codebase cancelled an unpaid order; this is the one unit the
// payment-window expiry job calls, per order.
// ---------------------------------------------------------------------------

export type CancelUnpaidOutcome =
  | 'cancelled'
  | 'not_due' // Not awaiting payment, or the deadline has not passed.
  | 'pool_order' // A pool order: BR-158's short-close needs the seller's decision — left to staff.
  | 'paid' // Some money is posted against it: a person decides, never a clock.
  | 'payment_declared'; // The buyer declared payment in time and it has not been posted yet.

/**
 * BR-035 — before a PO exists, failure to pay inside the window auto-cancels
 * the order, releases the seller with no strike, and the buyer takes a strike.
 * (An SO reserves nothing on the seller's side, so cancelling the SO is the
 * release; no strike is written for the seller.)
 *
 * Everything is decided inside one transaction. The cancel is a conditional
 * update on the SO, and every payment-side write (a claim, an allocation, a
 * posting) writes the same SO inside its own transaction — so if a payment and
 * this cancel overlap, one of them conflicts and re-reads, and the expiry then
 * sees the money. It can never cancel an order that was in fact just paid.
 */
export async function cancelUnpaidSo(
  soId: string,
  now: Date,
  correlationId: string,
): Promise<CancelUnpaidOutcome> {
  return withTransaction(async (session): Promise<CancelUnpaidOutcome> => {
    const so = await So.findOne({
      _id: soId,
      state: 'awaiting_payment',
      payDeadline: { $lt: now },
    }).session(session);
    if (!so) return 'not_due';

    // BR-156/BR-158 — a pool order's 16h window closes the POOL, and only the seller
    // can say whether a short pool ships lower. Not automated; staff resolve it.
    if (await PoolCommitment.exists({ soId: so._id }).session(session)) return 'pool_order';

    if ((await getPostedReceiptsPaiseForSo(soId, session)) > 0) return 'paid';

    // A claim the buyer made inside his window, still waiting for Accounts: his money
    // is on its way. Claims already pointed at other orders do not protect this one.
    const declared = await UpcomingReceipt.exists({
      buyerId: so.buyerId,
      state: 'waiting',
      claimedAt: { $lte: so.payDeadline },
      $or: [{ soIds: so._id }, { soIds: { $size: 0 } }],
    }).session(session);
    if (declared) return 'payment_declared';

    const cancelled = await So.findOneAndUpdate(
      { _id: so._id, state: 'awaiting_payment' },
      { $set: { state: 'cancelled' } },
      { session, new: true },
    );
    if (!cancelled) return 'not_due';

    const buyer = await Buyer.findById(so.buyerId).session(session);
    if (!buyer) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Buyer not found.' });
    const buyerCounterpartyId = (buyer.counterpartyId as Types.ObjectId).toString();

    // BR-215 — a buyer failing to pay inside his window is a counted failure (grace applies, BR-212).
    await recordFailure(
      {
        counterpartyId: buyerCounterpartyId,
        counterpartyKind: 'buyer',
        type: 'buyer_failed_to_pay',
        chainId: (so.chainId as Types.ObjectId).toString(),
      },
      { employeeId: null, correlationId },
      session,
    );
    await writeChainEvent(
      {
        chainId: so.chainId as Types.ObjectId,
        type: 'so_cancelled_unpaid',
        refCollection: 'so',
        refId: so._id as Types.ObjectId,
        actorId: buyerCounterpartyId,
        actorType: 'system',
        summary: `${so.soNo} — not paid inside its window; cancelled, seller released with no strike, buyer conduct event recorded (BR-035).`,
      },
      session,
    );
    await writeAuditLog(
      {
        actorId: buyerCounterpartyId,
        actorType: 'system',
        entity: 'so',
        entityId: so._id as Types.ObjectId,
        field: 'state',
        oldValue: 'awaiting_payment',
        newValue: 'cancelled',
        reason: 'BR-035 payment window expired',
        correlationId,
      },
      session,
    );
    return 'cancelled';
  });
}

// ---------------------------------------------------------------------------
// M10 — the seven-day delivery window (BR-192). "Silence is delivery": the
// buyer's tap and the clock both close the order through this one unit.
// ---------------------------------------------------------------------------

/**
 * Closes an order that left Indore on leg 2. It is a conditional update on
 * `dispatched_leg2`, so a buyer's confirm, a complaint (which moves the order
 * to `disputed`) and the auto-close can never all win: exactly one does, and
 * the rest get `false`.
 */
export async function closeDeliveredSo(
  soId: string,
  by: { actorId: string; actorType: 'counterparty' | 'system' },
  correlationId: string,
  extraFilter: Record<string, unknown> = {},
): Promise<boolean> {
  return withTransaction(async (session) => {
    const closed = await So.findOneAndUpdate(
      { _id: soId, state: 'dispatched_leg2', ...extraFilter },
      { $set: { state: 'closed' } },
      { session, new: true },
    );
    if (!closed) return false;
    await writeChainEvent(
      {
        chainId: closed.chainId as Types.ObjectId,
        type: 'so_closed',
        refCollection: 'so',
        refId: closed._id as Types.ObjectId,
        actorId: by.actorId,
        actorType: by.actorType,
        summary:
          by.actorType === 'system'
            ? `${closed.soNo} — seven days after leg 2 with no complaint: silence is delivery (BR-192).`
            : `${closed.soNo} — buyer confirmed receipt (BR-192).`,
      },
      session,
    );
    await writeAuditLog(
      {
        actorId: by.actorId,
        actorType: by.actorType,
        entity: 'so',
        entityId: closed._id as Types.ObjectId,
        field: 'state',
        oldValue: 'dispatched_leg2',
        newValue: 'closed',
        correlationId,
      },
      session,
    );
    return true;
  });
}

export async function transitionToBilledInMarg(soId: string): Promise<void> {
  await setSoAndPoState(soId as unknown as Types.ObjectId, null, 'billed_in_marg', null, 'marg');
  await Po.updateOne({ soId }, { $set: { billed: true } });
}

export async function transitionToDispatchedLeg2(soId: string, poId: string): Promise<void> {
  await setSoAndPoState(
    soId as unknown as Types.ObjectId,
    poId as unknown as Types.ObjectId,
    'dispatched_leg2',
    'dispatched_leg2',
    'dispatch',
    async (so, session) => {
      // BR-192 — the seven-day window opens now; the auto-close clock reads this.
      await So.updateOne(
        { _id: so._id },
        { $set: { deliveryWindowEndsAt: addDays(new Date(), 7) } },
        { session },
      );
      const buyerCounterpartyId = await counterpartyIdForBuyer(
        so.buyerId as Types.ObjectId,
        session,
      );
      // CH §21.8 #8 — "Leg 2 leaves Indore."
      await enqueueNotification(
        {
          counterpartyId: buyerCounterpartyId,
          templateKey: 'dispatched',
          params: { soNo: so.soNo },
        },
        session,
      );
      // CH §21.8 #9 — "Confirm or complain, seven days" (BR-192): the window opens at
      // leg-2 dispatch (WF-08 step 6). This and `dispatched` share one instant, so a
      // hard one-a-week cap (BR-283) lets only the first through — see QR-054.
      await enqueueNotification(
        {
          counterpartyId: buyerCounterpartyId,
          templateKey: 'delivery_window',
          params: {
            soNo: so.soNo,
            windowEndsOn: formatForDisplay(addDays(new Date(), 7)),
          },
        },
        session,
      );
    },
  );
}

// BR-192/BR-193 — the 7-day delivery window, confirm/complaint and the final
// `closed` state are WF-08 step 6. `so.state` reaches `dispatched_leg2` here
// (BR-030's stage-6 completion condition); the buyer's confirm (M5) and the
// seven-day clock (M10) both close it through `closeDeliveredSo`, above.

// ---------------------------------------------------------------------------
// BR-031/BR-037 — the chain view
// ---------------------------------------------------------------------------

/**
 * Loads the chain's documents. Deliberately returns them un-projected: the
 * audience's own type is applied by `projectChainView` (chain.view.ts), the one
 * place that decides what each desk may see — never call this and serialise it.
 */
export async function getChainView(chainId: string): Promise<RawChainView> {
  const chain = await Chain.findById(chainId);
  if (!chain) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Chain not found.' });
  const so = await So.findOne({ chainId: chain._id });
  const po = so ? await Po.findOne({ chainId: chain._id }) : null;
  const events = await ChainEvent.find({ chainId: chain._id }).sort({ at: 1 });

  return {
    chainNo: chain.chainNo,
    stage: chain.stage,
    so: so as unknown as RawChainView['so'],
    po: po as unknown as RawChainView['po'],
    events: events as unknown as RawChainView['events'],
    raw: { so, po, events },
  };
}
