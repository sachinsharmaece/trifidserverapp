import type { Types } from 'mongoose';
import { Po } from '../../models/Po.js';
import { Movement } from '../../models/Movement.js';
import { ReturnNote } from '../../models/ReturnNote.js';
import { Transporter } from '../../models/Transporter.js';
import { Consolidation } from '../../models/Consolidation.js';
import { Sequence } from '../../models/Sequence.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { financialYearSuffix } from '../chain/chain.numbering.js';

export interface StaffActor {
  employeeId: string;
  correlationId: string;
}

const HUB_CUTOFF_HOUR = 18; // BR-177.

// ---------------------------------------------------------------------------
// Transporter master — BR-176 names a transporter by free text on
// `Movement`; this is the pick-list Logistics staff choose from. It does not
// touch `Movement.transporter`, which stays a plain string.
// ---------------------------------------------------------------------------

export interface TransporterDto {
  transporterId: string;
  name: string;
  mobile: string | null;
  vehicleType: string | null;
  active: boolean;
}

export async function createTransporter(
  input: { name: string; mobile?: string; vehicleType?: string; notes?: string },
  actor: StaffActor,
): Promise<TransporterDto> {
  const transporter = await Transporter.create({
    name: input.name,
    mobile: input.mobile ?? null,
    vehicleType: input.vehicleType ?? null,
    notes: input.notes ?? null,
  });
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'transporter',
    entityId: transporter._id as Types.ObjectId,
    field: 'create',
    newValue: { name: input.name },
    correlationId: actor.correlationId,
  });
  return toTransporterDto(transporter);
}

export async function listTransporters(activeOnly = true): Promise<TransporterDto[]> {
  const filter = activeOnly ? { active: true } : {};
  const rows = await Transporter.find(filter).sort({ name: 1 });
  return rows.map(toTransporterDto);
}

function toTransporterDto(t: InstanceType<typeof Transporter>): TransporterDto {
  return {
    transporterId: (t._id as Types.ObjectId).toString(),
    name: t.name,
    mobile: t.mobile ?? null,
    vehicleType: t.vehicleType ?? null,
    active: t.active,
  };
}

// ---------------------------------------------------------------------------
// Hub position and dwell — new this session. Nothing before M7 recorded when
// goods physically arrived at the hub, distinct from `Inspection` (BR-184's
// separate signed act). This is the anchor both dwell-time and the BR-177
// cut-off need.
// ---------------------------------------------------------------------------

export async function recordGoodsIn(
  poId: string,
  actor: StaffActor,
): Promise<{ receivedAt: string }> {
  const po = await Po.findById(poId);
  if (!po) throw new AppError({ code: 'NOT_FOUND', messageEn: 'PO not found.' });
  if (po.receivedAt) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Goods-in has already been recorded for this PO.',
    });
  }
  po.received = true;
  po.receivedAt = new Date();
  await po.save();
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'po',
    entityId: po._id as Types.ObjectId,
    field: 'receivedAt',
    newValue: { receivedAt: po.receivedAt },
    correlationId: actor.correlationId,
  });
  return { receivedAt: po.receivedAt.toISOString() };
}

export interface HubPositionItem {
  poId: string;
  receivedAt: string;
  dwellHours: number;
  inspected: boolean;
  dispatchEligibleToday: boolean;
}

/**
 * BR-177's core clause only: "arriving and clearing inspection by 18:00 goes
 * out the same day." The second clause — two same-buyer/same-location orders
 * pairing, the first held to a maximum of 16:00 — is not computed here; it
 * needs a buyer+location join this reads no further into (flagged, not
 * built — see CHANGELOG.md's M7 entry).
 */
export async function getHubPosition(): Promise<HubPositionItem[]> {
  const pos = await Po.find({
    receivedAt: { $ne: null },
    state: { $in: ['released', 'dispatched_leg1', 'inspected', 'billed'] },
    failed: false,
  }).sort({ receivedAt: 1 });

  const now = new Date();
  return pos.map((po) => {
    const receivedAt = po.receivedAt as Date;
    const dwellHours =
      Math.round(((now.getTime() - receivedAt.getTime()) / (60 * 60 * 1000)) * 10) / 10;
    return {
      poId: (po._id as Types.ObjectId).toString(),
      receivedAt: receivedAt.toISOString(),
      dwellHours,
      inspected: po.inspected,
      dispatchEligibleToday: isEligibleForSameDayDispatch(receivedAt, now),
    };
  });
}

function isEligibleForSameDayDispatch(receivedAt: Date, now: Date): boolean {
  const sameDay =
    receivedAt.getFullYear() === now.getFullYear() &&
    receivedAt.getMonth() === now.getMonth() &&
    receivedAt.getDate() === now.getDate();
  if (!sameDay) return true; // already cleared a prior cut-off; not today's decision to make
  return now.getHours() < HUB_CUTOFF_HOUR;
}

// ---------------------------------------------------------------------------
// Consolidation — BR-178. A physical/freight grouping only; see
// models/Consolidation.ts. Do not add an invoice-level merge here (QR-014).
// ---------------------------------------------------------------------------

export interface ConsolidationDto {
  consolidationId: string;
  consolidationNo: string;
  movementIds: string[];
}

export async function createConsolidation(
  movementIds: string[],
  actor: StaffActor,
): Promise<ConsolidationDto> {
  if (movementIds.length < 2) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'A consolidation needs at least two movements.',
      field: 'movementIds',
    });
  }
  const movements = await Movement.find({ _id: { $in: movementIds }, leg: 2 });
  if (movements.length !== movementIds.length) {
    throw new AppError({
      code: 'NOT_FOUND',
      messageEn: 'One or more movements were not found, or are not leg-2 dispatches.',
    });
  }
  const fy = financialYearSuffix(new Date());
  const seqDoc = await Sequence.findOneAndUpdate(
    { key: `consolidation-${fy}` },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  const consolidationNo = `CONS-${fy}-${String(seqDoc!.seq).padStart(4, '0')}`;
  const consolidation = await Consolidation.create({
    consolidationNo,
    movementIds,
    createdBy: actor.employeeId,
  });
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'consolidation',
    entityId: consolidation._id as Types.ObjectId,
    field: 'create',
    newValue: { movementIds },
    correlationId: actor.correlationId,
  });
  return {
    consolidationId: (consolidation._id as Types.ObjectId).toString(),
    consolidationNo,
    movementIds: movementIds,
  };
}

// ---------------------------------------------------------------------------
// Return-note collection — ST-12's missing middle state
// (`raised → collection_arranged → returned`). Does not touch the ageing
// endpoint (`desk/purchase`'s `getReturnNoteAgeing`) or QR-021's day-31 gap.
// ---------------------------------------------------------------------------

export async function arrangeReturnCollection(
  returnNoteId: string,
  actor: StaffActor,
): Promise<{ collectionArrangedAt: string }> {
  const note = await ReturnNote.findById(returnNoteId);
  if (!note) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Return note not found.' });
  if (note.returnedAt) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This return note is already closed.',
    });
  }
  if (note.collectionArrangedAt) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Collection is already arranged for this return note.',
    });
  }
  note.collectionArrangedAt = new Date();
  await note.save();
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'return_note',
    entityId: note._id as Types.ObjectId,
    field: 'collectionArrangedAt',
    newValue: { collectionArrangedAt: note.collectionArrangedAt },
    correlationId: actor.correlationId,
  });
  return { collectionArrangedAt: note.collectionArrangedAt.toISOString() };
}

export async function closeReturnNote(
  returnNoteId: string,
  actor: StaffActor,
): Promise<{ returnedAt: string }> {
  const note = await ReturnNote.findById(returnNoteId);
  if (!note) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Return note not found.' });
  if (note.returnedAt) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This return note is already closed.',
    });
  }
  note.returnedAt = new Date();
  await note.save();
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'return_note',
    entityId: note._id as Types.ObjectId,
    field: 'returnedAt',
    newValue: { returnedAt: note.returnedAt },
    correlationId: actor.correlationId,
  });
  return { returnedAt: note.returnedAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Dashboard — new this session. BR-071 — no firm name, no money, anywhere in
// this response (wallSweep.test.ts's Logistics sweep covers this shape).
// ---------------------------------------------------------------------------

export interface LogisticsDashboard {
  atHubCount: number;
  overdueDispatchCount: number; // dispatchDueDate passed, still not leg-1 dispatched
  openReturnNotes: number;
  overdueReturnNotes: number;
  hubPosition: HubPositionItem[];
}

export async function getDashboard(): Promise<LogisticsDashboard> {
  const now = new Date();
  const [atHub, overdueDispatch, openReturnNotes, allReturnNotes] = await Promise.all([
    Po.countDocuments({ receivedAt: { $ne: null }, inspected: false, failed: false }),
    Po.countDocuments({
      state: 'released',
      failed: false,
      dispatchDueDate: { $lt: now },
    }),
    ReturnNote.countDocuments({ returnedAt: null }),
    ReturnNote.find({ returnedAt: null }),
  ]);
  const overdueReturnNotes = allReturnNotes.filter((r) => r.dueBy < now).length;
  const hubPosition = await getHubPosition();
  return {
    atHubCount: atHub,
    overdueDispatchCount: overdueDispatch,
    openReturnNotes,
    overdueReturnNotes,
    hubPosition,
  };
}
