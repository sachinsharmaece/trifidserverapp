import { withTransaction } from '../../db/transaction.js';
import { Po } from '../../models/Po.js';
import { PoLine } from '../../models/PoLine.js';
import { So } from '../../models/So.js';
import { SoLine } from '../../models/SoLine.js';
import { Inspection } from '../../models/Inspection.js';
import { SellerBill } from '../../models/SellerBill.js';
import { DebitNote } from '../../models/DebitNote.js';
import { ReturnNote } from '../../models/ReturnNote.js';
import { AppError } from '../../shared/errors.js';
import { computeSellerLineMoney } from '../../shared/pricing.js';
import { assertInspectionNotYetSubmitted } from '../chain/chain.guards.js';
import { writeChainEvent } from '../chain/chain.events.js';
import { writeAuditLog } from '../../shared/audit.js';
import { transitionToInspected, transitionToSupplyFailed } from '../chain/chain.service.js';
import { enqueueNotification, counterpartyIdForSeller, } from '../notification/notification.outbox.js';
/**
 * API-087. BR-182/BR-184 — outer box only, immutable once submitted, the
 * dock head signs. BR-190 — **the dock records; Purchase applies**: this
 * only records the physical finding. It does not touch the chain, create a
 * seller bill, or decide any payment consequence — `applyInspection` below
 * is the separate Purchase act BR-190 requires.
 */
export async function recordInspection(poId, input, actor) {
    const po = await Po.findById(poId);
    if (!po)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'PO not found.' });
    const existing = await Inspection.findOne({ poId: po._id });
    assertInspectionNotYetSubmitted(!!existing); // BR-184
    const poLine = await PoLine.findOne({ poId: po._id });
    if (!poLine)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'PO line not found.' });
    if (input.casesAccepted + input.casesRejected !== poLine.boxes) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: `Accepted (${input.casesAccepted}) plus rejected (${input.casesRejected}) must equal the ordered quantity (${poLine.boxes}).`,
        });
    }
    // TD-004 — the finding, its audit line and the seller's `inspection_outcome` commit together.
    return withTransaction(async (session) => {
        const [inspection] = await Inspection.create([
            {
                poId: po._id,
                casesAccepted: input.casesAccepted,
                casesRejected: input.casesRejected,
                reasons: input.reasons,
                photoRefs: input.photoRefs,
                signedBy: actor.employeeId,
                signedAt: new Date(),
            },
        ], { session, ordered: true });
        if (!inspection)
            throw new Error('Inspection.create returned no document.');
        await writeAuditLog({
            actorId: actor.employeeId,
            actorType: 'staff',
            entity: 'inspection',
            entityId: inspection._id,
            field: 'create',
            newValue: { casesAccepted: input.casesAccepted, casesRejected: input.casesRejected },
            correlationId: actor.correlationId,
        }, session);
        // CH §21.8 #15 — "Accepted, part rejected, whole lot rejected." The dock records the
        // physical finding (BR-190), and that finding is what the seller is told.
        await enqueueNotification({
            counterpartyId: await counterpartyIdForSeller(po.sellerId, session),
            templateKey: 'inspection_outcome',
            params: { poNo: po.poNo, outcome: describeInspectionOutcome(input) },
            correlationId: actor.correlationId,
        }, session);
        return { inspectionId: inspection.id };
    });
}
function describeInspectionOutcome(input) {
    if (input.casesAccepted === 0)
        return 'whole_lot_rejected';
    if (input.casesRejected > 0)
        return 'part_rejected';
    return 'accepted';
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
export async function applyInspection(poId, actor) {
    const po = await Po.findById(poId);
    if (!po)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'PO not found.' });
    const inspection = await Inspection.findOne({ poId: po._id });
    if (!inspection) {
        throw new AppError({
            code: 'NOT_FOUND',
            messageEn: 'No inspection recorded against this PO yet.',
        });
    }
    const so = await So.findById(po.soId);
    if (!so)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'SO not found.' });
    const soLine = await SoLine.findOne({ soId: so._id });
    const poLine = await PoLine.findOne({ poId: po._id });
    if (!soLine || !poLine)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order line not found.' });
    if (inspection.casesAccepted === 0) {
        // BR-186/WF-11 — whole-lot rejection is a supply failure, not a part
        // rejection. A refund is now only one of two outcomes: WF-11 tries a
        // replacement seller first (`promotionOfferId`) and only refunds
        // outright when no affordable one exists (`refundId`).
        const { refundId, promotionOfferId } = await transitionToSupplyFailed(so._id.toString(), po._id.toString(), actor);
        await createReturnNoteIfNeeded(po, inspection, actor);
        return {
            soState: promotionOfferId ? 'promotion_offered' : 'supply_failed',
            refundId,
            promotionOfferId,
        };
    }
    const placeOfSupply = so.placeOfSupply;
    const billedFull = computeSellerLineMoney(poLine.boxes, soLine.baseUnitsPerBoxAtOrder, poLine.sellerNetPaise, placeOfSupply);
    const accepted = computeSellerLineMoney(inspection.casesAccepted, soLine.baseUnitsPerBoxAtOrder, poLine.sellerNetPaise, placeOfSupply);
    const result = await withTransaction(async (session) => {
        const [sellerBill] = await SellerBill.create([
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
        ], { session, ordered: true });
        if (!sellerBill)
            throw new Error('SellerBill.create returned no document.');
        let debitNoteId;
        if (inspection.casesRejected > 0) {
            const rejectedValuePaise = billedFull.totalPaise - accepted.totalPaise;
            const [debitNote] = await DebitNote.create([
                {
                    poId: po._id,
                    sellerBillId: sellerBill._id,
                    inspectionId: inspection._id,
                    rejectedValuePaise,
                    raisedBy: actor.employeeId,
                },
            ], { session, ordered: true });
            sellerBill.adjustmentDocRef = debitNote._id;
            await sellerBill.save({ session });
            debitNoteId = debitNote._id.toString();
        }
        await writeChainEvent({
            chainId: so.chainId,
            type: 'inspection_applied',
            refCollection: 'inspection',
            refId: inspection._id,
            actorId: actor.employeeId,
            actorType: 'staff',
            summary: inspection.casesRejected > 0
                ? `Part rejection: ${inspection.casesAccepted} of ${poLine.boxes} boxes accepted. Seller payable ₹${accepted.totalPaise / 100}; debit note raised for the rest.`
                : `Inspection applied — all ${inspection.casesAccepted} boxes accepted. Seller payable ₹${accepted.totalPaise / 100}.`,
        }, session);
        return { sellerBillId: sellerBill._id.toString(), debitNoteId };
    });
    await createReturnNoteIfNeeded(po, inspection, actor);
    await transitionToInspected(so._id.toString(), po._id.toString());
    return { soState: 'inspected', ...result };
}
async function createReturnNoteIfNeeded(po, inspection, actor) {
    if (inspection.casesRejected === 0)
        return;
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
        entityId: inspection._id,
        field: 'create',
        newValue: { cases: inspection.casesRejected, dueBy },
        correlationId: actor.correlationId,
    });
}
