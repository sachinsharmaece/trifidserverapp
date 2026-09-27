import type { Types } from 'mongoose';
import {
  CallLog,
  type CallOutcome,
  type CallLogKind,
  type CallLogUpdateKind,
} from '../../../models/CallLog.js';
import { AppError } from '../../../shared/errors.js';
import { writeAuditLog } from '../../../shared/audit.js';

export interface StaffActor {
  employeeId: string;
  correlationId: string;
}

export interface CreateCallLogInput {
  buyerId: string;
  direction?: 'in' | 'out' | null;
  kind: CallLogKind;
  outcome?: CallOutcome;
  note: string;
  producedAskId?: string;
  listingLineId?: string;
  updateKind?: CallLogUpdateKind;
  updateValue?: string;
  promiseDueAt?: string;
}

export interface CallLogDto {
  callLogId: string;
  buyerId: string;
  employeeId: string;
  direction: 'in' | 'out' | null;
  at: string;
  kind: CallLogKind;
  outcome: CallOutcome | null;
  note: string;
  producedAskId: string | null;
  listingLineId: string | null;
  updateKind: CallLogUpdateKind | null;
  updateValue: string | null;
  promiseDueAt: string | null;
  promiseFulfilledAt: string | null;
}

function toDto(row: InstanceType<typeof CallLog>): CallLogDto {
  return {
    callLogId: (row._id as Types.ObjectId).toString(),
    buyerId: (row.buyerId as Types.ObjectId).toString(),
    employeeId: (row.employeeId as Types.ObjectId).toString(),
    direction: (row.direction as 'in' | 'out' | null) ?? null,
    at: row.at.toISOString(),
    kind: row.kind as CallLogKind,
    outcome: (row.outcome as CallOutcome | null) ?? null,
    note: row.note,
    producedAskId: row.producedAskId ? (row.producedAskId as Types.ObjectId).toString() : null,
    listingLineId: row.listingLineId ? (row.listingLineId as Types.ObjectId).toString() : null,
    updateKind: (row.updateKind as CallLogUpdateKind | null) ?? null,
    updateValue: row.updateValue ?? null,
    promiseDueAt: row.promiseDueAt ? row.promiseDueAt.toISOString() : null,
    promiseFulfilledAt: row.promiseFulfilledAt ? row.promiseFulfilledAt.toISOString() : null,
  };
}

/**
 * A `call` names how it went and which way it ran (the zod schema already
 * enforces this on the request; re-checked here so a caller that builds the
 * input by hand — a proxy path, a script — gets the same plain-English
 * refusal). An `update_request` names which field the buyer wants changed.
 */
export async function createCallLog(
  input: CreateCallLogInput,
  actor: StaffActor,
): Promise<CallLogDto> {
  if (input.kind === 'call' && (!input.outcome || !input.direction)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'A call log requires an outcome and which way the call ran.',
    });
  }
  if (input.kind === 'update_request' && !input.updateKind) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'An update request must say which field is changing.',
    });
  }

  const created = await CallLog.create({
    buyerId: input.buyerId,
    employeeId: actor.employeeId,
    direction: input.direction ?? null,
    kind: input.kind,
    outcome: input.outcome ?? null,
    note: input.note,
    producedAskId: input.producedAskId ?? null,
    listingLineId: input.listingLineId ?? null,
    updateKind: input.updateKind ?? null,
    updateValue: input.updateValue ?? null,
    promiseDueAt: input.promiseDueAt ? new Date(input.promiseDueAt) : null,
  });

  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'call_log',
    entityId: created._id as Types.ObjectId,
    field: 'create',
    newValue: { kind: created.kind, buyerId: input.buyerId },
    correlationId: actor.correlationId,
  });

  return toDto(created);
}

export async function listCallLogsForBuyer(buyerId: string): Promise<CallLogDto[]> {
  const rows = await CallLog.find({ buyerId }).sort({ at: -1 });
  return rows.map(toDto);
}

/** The Today worklist's "Promised" bucket — a due date has arrived and nobody has closed it out. */
export async function listDuePromises(now: Date = new Date()): Promise<CallLogDto[]> {
  const rows = await CallLog.find({
    promiseDueAt: { $ne: null, $lte: now },
    promiseFulfilledAt: null,
  }).sort({ promiseDueAt: 1 });
  return rows.map(toDto);
}
