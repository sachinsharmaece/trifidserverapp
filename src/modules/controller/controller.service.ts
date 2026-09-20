import type { Types } from 'mongoose';
import {
  Complaint,
  type ComplaintCategory,
  type ComplaintDisposition,
} from '../../models/Complaint.js';
import { So } from '../../models/So.js';
import { Po } from '../../models/Po.js';
import { SellerBill } from '../../models/SellerBill.js';
import { DebitNote } from '../../models/DebitNote.js';
import { Counterparty } from '../../models/Counterparty.js';
import { Seller } from '../../models/Seller.js';
import { ClockWaiver } from '../../models/ClockWaiver.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { getReturnNoteAgeing } from '../desk/purchase/purchase.service.js';
import { withTransaction } from '../../db/transaction.js';
import {
  enqueueNotification,
  counterpartyIdForSeller,
} from '../notification/notification.outbox.js';

export interface StaffActor {
  employeeId: string;
  correlationId: string;
}

// ---------------------------------------------------------------------------
// Dispute resolution — BR-206. "Controller decides disputes. Sales owns the
// conversation with the buyer, Purchase owns any recovery from the seller,
// neither sees the other's number." This queue and decision is the single
// place fault gets decided; `desk/sales`'s complaint queue (buyer
// conversation) and `desk/purchase`'s seller-recovery queue both only *read*
// what is decided here, never decide independently.
//
// `transit_damage` is excluded on purpose (`QR-050`) — BR-180's strike-on-
// refusal clause is explicitly out of scope this session, so that category
// is never offered a decision here. It still shows up, unresolved, in
// `getExceptionView` below, so it stays visible rather than silently dropped.
// ---------------------------------------------------------------------------

export interface DisputeQueueItem {
  complaintId: string;
  soId: string;
  category: ComplaintCategory;
  note: string | null;
  createdAt: string;
}

export async function getDisputeQueue(): Promise<DisputeQueueItem[]> {
  const complaints = await Complaint.find({
    state: 'open',
    category: { $ne: 'transit_damage' },
  }).sort({ createdAt: 1 });
  return complaints.map((c) => ({
    complaintId: (c._id as Types.ObjectId).toString(),
    soId: c.soId.toString(),
    category: c.category as ComplaintCategory,
    note: c.note ?? null,
    createdAt: (c as unknown as { createdAt: Date }).createdAt.toISOString(),
  }));
}

interface DecideDisputeInput {
  disposition: ComplaintDisposition;
  note: string;
  debitValuePaise?: number; // required only when disposition === 'seller_fault'
}

/**
 * BR-183 raises the seller debit note here rather than at inspection — this
 * claim surfaces after acceptance and payment, so there is no `Inspection`
 * behind it (`DebitNote.inspectionId` is optional precisely for this case).
 * BR-204/BR-205 — a dock-fault decision raises no seller consequence at all;
 * BR-203's own credit-note/re-supply mechanism is **not built here** — it is
 * a distinct document type this session did not model, left as a manual
 * Marg step for now (flagged in CHANGELOG.md, not guessed at).
 */
export async function decideDispute(
  complaintId: string,
  input: DecideDisputeInput,
  actor: StaffActor,
): Promise<{ debitNoteId?: string; soClosed: boolean }> {
  const complaint = await Complaint.findById(complaintId);
  if (!complaint) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Complaint not found.' });
  if (complaint.category === 'transit_damage') {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Transit-damage complaints are not decided this session (QR-050).',
    });
  }
  if (complaint.state !== 'open') {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This complaint is already resolved.',
    });
  }

  const so = await So.findById(complaint.soId);
  if (!so) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });

  let debitNoteId: string | undefined;
  if (input.disposition === 'seller_fault') {
    if (!input.debitValuePaise || input.debitValuePaise <= 0) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: 'A seller-fault decision requires the recoverable value (debitValuePaise).',
        field: 'debitValuePaise',
      });
    }
    const po = await Po.findOne({ soId: so._id });
    if (!po) throw new AppError({ code: 'NOT_FOUND', messageEn: 'PO not found for this order.' });
    const sellerBill = await SellerBill.findOne({ poId: po._id });
    if (!sellerBill) {
      throw new AppError({
        code: 'NOT_FOUND',
        messageEn: 'No seller bill exists yet for this PO — nothing to recover against.',
      });
    }
    if (input.debitValuePaise > sellerBill.acceptedValuePaise) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: 'The recoverable value cannot exceed what the seller was ever paid on this PO.',
        field: 'debitValuePaise',
      });
    }
    const [debitNote] = await DebitNote.create([
      {
        poId: po._id,
        sellerBillId: sellerBill._id,
        complaintId: complaint._id,
        rejectedValuePaise: input.debitValuePaise,
        raisedBy: actor.employeeId,
      },
    ]);
    debitNoteId = (debitNote!._id as Types.ObjectId).toString();
    complaint.debitNoteId = debitNote!._id as Types.ObjectId;
  }

  complaint.state = 'resolved';
  complaint.disposition = input.disposition;
  complaint.decidedByEmployeeId = actor.employeeId as unknown as Types.ObjectId;
  complaint.decidedAt = new Date();
  complaint.resolutionNote = input.note;
  await complaint.save();

  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'complaint',
    entityId: complaint._id as Types.ObjectId,
    field: 'disposition',
    newValue: { disposition: input.disposition, debitNoteId },
    reason: input.note,
    correlationId: actor.correlationId,
  });

  // ST-01 — "disputed (clock stops) ── closed | refunded". BR-207 (buyer-
  // fault returns do not exist) rules out a refund exit for any of these
  // four categories, so a decision here always exits to `closed`, once every
  // open complaint on the SO has one.
  const stillOpen = await Complaint.countDocuments({ soId: so._id, state: 'open' });
  let soClosed = false;
  if (stillOpen === 0 && so.state === 'disputed') {
    so.state = 'closed';
    await so.save();
    soClosed = true;
  }

  return { debitNoteId, soClosed };
}

// ---------------------------------------------------------------------------
// Cross-desk exception view — MASTER_PLAN.md M7 DoD: "Controller can see
// every exception in one place." Read-only aggregation over desks that
// already exist; nothing here decides anything by itself.
// ---------------------------------------------------------------------------

export interface ExceptionView {
  openDisputes: number;
  unhandledTransitDamage: number; // QR-050 — visible, not actionable, this session.
  overdueReturnNotes: number;
  blacklistedWithPendingPayables: Array<{ counterpartyId: string; poId: string }>;
}

export async function getExceptionView(): Promise<ExceptionView> {
  const [openDisputes, unhandledTransitDamage, ageing, blacklistedPayables] = await Promise.all([
    Complaint.countDocuments({ state: 'open', category: { $ne: 'transit_damage' } }),
    Complaint.countDocuments({ state: 'open', category: 'transit_damage' }),
    getReturnNoteAgeing(),
    getBlacklistedWithPendingPayables(),
  ]);
  return {
    openDisputes,
    unhandledTransitDamage,
    overdueReturnNotes: ageing.filter((r) => r.overdue).length,
    blacklistedWithPendingPayables: blacklistedPayables,
  };
}

/**
 * QR-015/BR-213's own test, surfaced for Controller: blacklisting a seller
 * blocks new activity only — it must never silently block a payable already
 * in flight (`payment.service.ts`'s `isPoPayable` has no blacklist check at
 * all, by design). This just lists the intersection so Controller can watch
 * it; it changes no payable's own eligibility.
 */
async function getBlacklistedWithPendingPayables(): Promise<
  Array<{ counterpartyId: string; poId: string }>
> {
  const blacklisted = await Counterparty.find({ status: 'blacklisted' });
  if (blacklisted.length === 0) return [];
  const sellers = await Seller.find({
    counterpartyId: { $in: blacklisted.map((c) => c._id) },
  });
  if (sellers.length === 0) return [];
  const sellerIdToCounterpartyId = new Map(
    sellers.map((s) => [(s._id as Types.ObjectId).toString(), s.counterpartyId.toString()]),
  );
  const pos = await Po.find({
    sellerId: { $in: sellers.map((s) => s._id) },
    failed: false,
    paid: false,
    hold: false,
  });
  const billed = await SellerBill.find({ poId: { $in: pos.map((p) => p._id) }, booked: true });
  const billedPoIds = new Set(billed.map((b) => b.poId.toString()));
  return pos
    .filter((po) => billedPoIds.has((po._id as Types.ObjectId).toString()))
    .map((po) => ({
      counterpartyId: sellerIdToCounterpartyId.get(po.sellerId.toString()) ?? '',
      poId: (po._id as Types.ObjectId).toString(),
    }));
}

// ---------------------------------------------------------------------------
// The bulk lifeline — BR-234. "The desk may extend it, with a logged reason
// and a checker... it operates in bulk — on a festival the desk extends
// every open dispatch clock in one action under one logged reason." This
// covers the one dispatch clock this codebase actually has a field for —
// `Po.dispatchDueDate` (BR-173/BR-174) — on every PO still awaiting leg-1
// dispatch. BR-195's buyer-side collection clock is a separate, unbuilt
// clock (no field exists for it yet) and is not covered by this action.
// ---------------------------------------------------------------------------

export interface BulkLifelineResult {
  extendedPoCount: number;
  newDispatchDueDate: string;
}

export async function grantBulkLifeline(
  extensionHours: number,
  reason: string,
  actor: { employeeId: string; checkerEmployeeId: string; correlationId: string },
): Promise<BulkLifelineResult> {
  if (extensionHours <= 0) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'The extension must be a positive number of hours.',
      field: 'extensionHours',
    });
  }
  // BR-213's own maker-checker note applies unchanged here: this function
  // does not itself verify employeeId !== checkerEmployeeId — that belongs
  // to the route's maker-checker middleware, the same known boundary
  // `conduct.service.ts`'s `advanceConductStage` already documents.
  const extensionMs = extensionHours * 60 * 60 * 1000;

  // TD-004 — every clock extension, the waiver record and every affected
  // seller's `lifeline_granted` commit together (this loop was not transactional
  // before M8; a failure halfway would have left some clocks extended and no waiver).
  return withTransaction(async (session) => {
    // M9 — the open POs are read INSIDE the transaction, and the extension is added by the
    // database in one atomic step. `withTransaction` re-runs this callback when two lifelines
    // (or a lifeline and a dispatch) conflict; the earlier version read the POs outside, added the
    // hours to those in-memory copies, and so applied them again on every retry — a PO's clock
    // moved 96h for two 24h lifelines. Nothing here carries state from one attempt to the next.
    const openPos = await Po.find({ state: { $in: ['released'] }, failed: false }).session(session);
    const openPoIds = openPos.map((po) => po._id);
    await Po.collection.updateMany(
      { _id: { $in: openPoIds } },
      [{ $set: { dispatchDueDate: { $add: ['$dispatchDueDate', extensionMs] } } }],
      { session },
    );
    const extendedPoCount = openPos.length;
    const lastExtended = extendedPoCount
      ? await Po.findById(openPoIds[extendedPoCount - 1]).session(session)
      : null;
    const newDispatchDueDate = lastExtended?.dispatchDueDate ?? new Date();

    const [waiver] = await ClockWaiver.create(
      [
        {
          entityIds: openPos.map((po) => po._id),
          hoursExtended: extensionHours,
          reason,
          raisedBy: actor.employeeId,
          approvedBy: actor.checkerEmployeeId,
        },
      ],
      { session, ordered: true },
    );
    if (!waiver) throw new Error('ClockWaiver.create returned no document.');

    // CH §21.8 #12 — "A clock extended." One message per affected seller, however
    // many of their POs moved. Only the dispatch clock exists to extend (BR-234, see
    // above), so only sellers are told; the template's "Both" audience has no buyer-side
    // clock to announce yet.
    const sellerIds = new Set(openPos.map((po) => (po.sellerId as Types.ObjectId).toString()));
    for (const sellerId of sellerIds) {
      await enqueueNotification(
        {
          counterpartyId: await counterpartyIdForSeller(sellerId, session),
          templateKey: 'lifeline_granted',
          params: { extensionHours },
          correlationId: actor.correlationId,
        },
        session,
      );
    }

    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'clock_waiver',
        entityId: waiver._id as Types.ObjectId,
        field: 'dispatchDueDate',
        newValue: { extensionHours, extendedPoCount, checkerEmployeeId: actor.checkerEmployeeId },
        reason,
        correlationId: actor.correlationId,
      },
      session,
    );

    return {
      extendedPoCount,
      newDispatchDueDate: newDispatchDueDate.toISOString(),
    };
  });
}
