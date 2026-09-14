import type { Types } from 'mongoose';
import { withTransaction } from '../../db/transaction.js';
import { Po } from '../../models/Po.js';
import { PoLine } from '../../models/PoLine.js';
import { So } from '../../models/So.js';
import { SoLine } from '../../models/SoLine.js';
import { Inspection, type InspectionRejectionReasonCode } from '../../models/Inspection.js';
import { SellerBill } from '../../models/SellerBill.js';
import { DebitNote } from '../../models/DebitNote.js';
import { ReturnNote } from '../../models/ReturnNote.js';
import { AppError } from '../../shared/errors.js';
import { computeSellerLineMoney, type PlaceOfSupply } from '../../shared/pricing.js';
import { assertInspectionNotYetSubmitted } from '../chain/chain.guards.js';
import { writeChainEvent } from '../chain/chain.events.js';
import { writeAuditLog } from '../../shared/audit.js';
import { transitionToInspected, transitionToSupplyFailed } from '../chain/chain.service.js';

export interface StaffActor {
  employeeId: string;
  correlationId: string;
}

interface RecordInspectionInput {
  casesAccepted: number;
  casesRejected: number;
  reasons: InspectionRejectionReasonCode[];
  photoRefs: string[];
}

/**
 * API-087. BR-182/BR-184 — outer box only, immutable once submitted, the
 * dock head signs. BR-190 — **the dock records; Purchase applies**: this
 * only records the physical finding. It does not touch the chain, create a
 * seller bill, or decide any payment consequence — `applyInspection` below
 * is the separate Purchase act BR-190 requires.
 */
export async function recordInspection(
  poId: string,
  input: RecordInspectionInput,
  actor: StaffActor,
): Promise<{ inspectionId: string }> {
  const po = await Po.findById(poId);
  if (!po) throw new AppError({ code: 'NOT_FOUND', messageEn: 'PO not found.' });

  const existing = await Inspection.findOne({ poId: po._id });
  assertInspectionNotYetSubmitted(!!existing); // BR-184

  const poLine = await PoLine.findOne({ poId: po._id });
  if (!poLine) throw new AppError({ code: 'NOT_FOUND', messageEn: 'PO line not found.' });
  if (input.casesAccepted + input.casesRejected !== poLine.boxes) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: `Accepted (${input.casesAccepted}) plus rejected (${input.casesRejected}) must equal the ordered quantity (${poLine.boxes}).`,
    });
  }

  const inspection = await Inspection.create({
    poId: po._id,
    casesAccepted: input.casesAccepted,
    casesRejected: input.casesRejected,
    reasons: input.reasons,
    photoRefs: input.photoRefs,
    signedBy: actor.employeeId,
    signedAt: new Date(),
  });

  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'inspection',
    entityId: inspection._id as Types.ObjectId,
    field: 'create',
    newValue: { casesAccepted: input.casesAccepted, casesRejected: input.casesRejected },
    correlationId: actor.correlationId,
  });

  return { inspectionId: inspection.id as string };
}

/**
 * BR-190's other half, done by Purchase (`PO_EDIT` — Purchase already holds
 * it; a dedicated permission would be one more string for the same
 * boundary). Turns the dock's physical finding into: a seller bill on the
 * accepted quantity only (Q5a), a debit note for any rejected value (Q5b),
 * a return note for any rejected cases (BR-189), and the chain's leg-1
 * completion — or, on a whole-lot rejection, routes to supply failure
 * (BR-186/WF-11) instead of any of the above.
 */
export async function applyInspection(
  poId: string,
  actor: StaffActor,
): Promise<{ soState: string; sellerBillId?: string; debitNoteId?: string; refundId?: string }> {
  const po = await Po.findById(poId);
  if (!po) throw new AppError({ code: 'NOT_FOUND', messageEn: 'PO not found.' });
  const inspection = await Inspection.findOne({ poId: po._id });
  if (!inspection) {
    throw new AppError({
      code: 'NOT_FOUND',
      messageEn: 'No inspection recorded against this PO yet.',
    });
  }
  const so = await So.findById(po.soId);
  if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'SO not found.' });
  const soLine = await SoLine.findOne({ soId: so._id });
  const poLine = await PoLine.findOne({ poId: po._id });
  if (!soLine || !poLine)
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order line not found.' });

  if (inspection.casesAccepted === 0) {
    // BR-186/WF-11 — whole-lot rejection is a supply failure, not a part rejection.
    const { refundId } = await transitionToSupplyFailed(
      (so._id as Types.ObjectId).toString(),
      (po._id as Types.ObjectId).toString(),
      actor,
    );
    await createReturnNoteIfNeeded(po, inspection, actor);
    return { soState: 'supply_failed', refundId };
  }

  const placeOfSupply = so.placeOfSupply as PlaceOfSupply;
  const billedFull = computeSellerLineMoney(
    poLine.boxes,
    soLine.baseUnitsPerBoxAtOrder,
    poLine.sellerNetPaise,
    placeOfSupply,
  );
  const accepted = computeSellerLineMoney(
    inspection.casesAccepted,
    soLine.baseUnitsPerBoxAtOrder,
    poLine.sellerNetPaise,
    placeOfSupply,
  );

  const result = await withTransaction(async (session) => {
    const [sellerBill] = await SellerBill.create(
      [
        {
          billNo: `SB-${po.poNo}`,
          poId: po._id,
          sellerId: po.sellerId,
          date: new Date(),
          taxablePaise: billedFull.taxablePaise,
          taxSplit: billedFull.taxSplit,
          totalPaise: billedFull.totalPaise,
          acceptedValuePaise: accepted.totalPaise, // Q5a — TriFid pays this, not totalPaise.
          booked: true, // WF-07 step 6 — "the seller's bill lands and is booked".
        },
      ],
      { session, ordered: true },
    );
    if (!sellerBill) throw new Error('SellerBill.create returned no document.');

    let debitNoteId: string | undefined;
    if (inspection.casesRejected > 0) {
      const rejectedValuePaise = billedFull.totalPaise - accepted.totalPaise;
      const [debitNote] = await DebitNote.create(
        [
          {
            poId: po._id,
            sellerBillId: sellerBill._id,
            inspectionId: inspection._id,
            rejectedValuePaise,
            raisedBy: actor.employeeId,
          },
        ],
        { session, ordered: true },
      );
      sellerBill.adjustmentDocRef = debitNote!._id as Types.ObjectId;
      await sellerBill.save({ session });
      debitNoteId = (debitNote!._id as Types.ObjectId).toString();
    }

    await writeChainEvent(
      {
        chainId: so.chainId as Types.ObjectId,
        type: 'inspection_applied',
        refCollection: 'inspection',
        refId: inspection._id as Types.ObjectId,
        actorId: actor.employeeId,
        actorType: 'staff',
        summary:
          inspection.casesRejected > 0
            ? `Part rejection: ${inspection.casesAccepted} of ${poLine.boxes} boxes accepted. Seller payable ₹${accepted.totalPaise / 100}; debit note raised for the rest.`
            : `Inspection applied — all ${inspection.casesAccepted} boxes accepted. Seller payable ₹${accepted.totalPaise / 100}.`,
      },
      session,
    );

    return { sellerBillId: (sellerBill._id as Types.ObjectId).toString(), debitNoteId };
  });

  await createReturnNoteIfNeeded(po, inspection, actor);
  await transitionToInspected(
    (so._id as Types.ObjectId).toString(),
    (po._id as Types.ObjectId).toString(),
  );

  return { soState: 'inspected', ...result };
}

async function createReturnNoteIfNeeded(
  po: { _id: unknown; sellerId: unknown },
  inspection: { _id: unknown; casesRejected: number; reasons: string[]; photoRefs: string[] },
  actor: StaffActor,
): Promise<void> {
  if (inspection.casesRejected === 0) return;
  const dueBy = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // BR-189 — 30 days.
  await ReturnNote.create({
    poId: po._id,
    sellerId: po.sellerId,
    cases: inspection.casesRejected,
    reason: inspection.reasons.join(', '),
    photoRefs: inspection.photoRefs,
    dueBy,
    freightDebited: false,
  });
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'return_note',
    entityId: inspection._id as Types.ObjectId,
    field: 'create',
    newValue: { cases: inspection.casesRejected, dueBy },
    correlationId: actor.correlationId,
  });
}
