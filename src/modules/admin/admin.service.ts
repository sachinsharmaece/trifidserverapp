import { generateSecret, generateURI } from 'otplib';
import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { MFA_REQUIRED_ROLE_KEYS } from '../../config/permissions.js';
import { withTransaction } from '../../db/transaction.js';
import { Config } from '../../models/Config.js';
import { Employee } from '../../models/Employee.js';
import { Role } from '../../models/Role.js';
import { Lane } from '../../models/Lane.js';
import { LaneAllocation } from '../../models/LaneAllocation.js';
import { Absence } from '../../models/Absence.js';
import { AuthSession } from '../../models/AuthSession.js';
import { Buyer } from '../../models/Buyer.js';
import { BookAssignment } from '../../models/BookAssignment.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { isAbsenceActiveNow, resolveEffectiveHolder } from '../../shared/absence.js';
import { moveLead } from '../lead/lead.service.js';

// CH §24.1 — enforced password rules. Length comes from the config env var;
// requiring one letter and one digit is a baseline technical policy, not a
// business rule.
export function assertPasswordMeetsPolicy(password: string): void {
  if (password.length < env.staffPasswordMinLength) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: `Password must be at least ${env.staffPasswordMinLength} characters.`,
      field: 'password',
    });
  }
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Password must contain at least one letter and one number.',
      field: 'password',
    });
  }
}

export interface AdminActor {
  employeeId: string;
  correlationId: string;
}

export async function listConfig(): Promise<
  Array<{ key: string; value: unknown; version: number; updatedAt: Date }>
> {
  const entries = await Config.find().sort({ key: 1 });
  return entries.map((entry) => ({
    key: entry.key,
    value: entry.value,
    version: entry.version,
    updatedAt: entry.updatedAt as Date,
  }));
}

/** API-130 PUT. */
export async function updateConfig(
  key: string,
  value: unknown,
  actor: AdminActor,
): Promise<{ key: string; value: unknown; version: number }> {
  const existing = await Config.findOne({ key });
  const nextVersion = (existing?.version ?? 0) + 1;

  const updated = await Config.findOneAndUpdate(
    { key },
    { $set: { value, version: nextVersion, updatedBy: actor.employeeId } },
    { upsert: true, new: true },
  );

  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'config',
    entityId: updated._id as Types.ObjectId,
    field: key,
    oldValue: existing?.value,
    newValue: value,
    correlationId: actor.correlationId,
  });

  return { key: updated.key, value: updated.value, version: updated.version };
}

interface IssueMfaResult {
  employeeId: string;
  mfaSecret: string;
  mfaOtpauthUrl: string;
}

/**
 * M10 — the enrolment path for CH §24.3. A Controller, Admin or Founder cannot sign in
 * without an authenticator, so an Admin issues (or re-issues, after a lost phone) one here.
 * The secret is shown ONCE, to the Admin, to hand over in person — the same model
 * `createEmployee` and the first-Admin seed script already use. Self-enrolment on a bare
 * password was deliberately not built: whoever stole a password could enrol their own phone.
 * Re-issuing replaces the old secret and signs the person out everywhere.
 */
export async function issueEmployeeMfa(
  employeeId: string,
  actor: AdminActor,
): Promise<IssueMfaResult> {
  const employee = await Employee.findById(employeeId);
  if (!employee) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Employee not found.' });
  const roles = await Role.find({ _id: { $in: employee.roleIds } });
  if (!roles.some((role) => MFA_REQUIRED_ROLE_KEYS.has(role.key))) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Only Controller, Admin and Founder accounts use an authenticator (CH §24.3).',
    });
  }

  const mfaSecret = generateSecret();
  await withTransaction(async (session) => {
    await Employee.updateOne(
      { _id: employee._id },
      { $set: { mfaSecret, mfaEnabled: true } },
      { session },
    );
    await AuthSession.updateMany(
      { employeeId: employee._id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'mfa_reissued' } },
      { session },
    );
    // The secret itself is never written to the audit log.
    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'employee',
        entityId: employee._id as Types.ObjectId,
        field: 'mfa_issued',
        reason: employee.mfaSecret ? 'MFA re-issued' : 'MFA first issued',
        correlationId: actor.correlationId,
      },
      session,
    );
  });

  return {
    employeeId,
    mfaSecret,
    mfaOtpauthUrl: generateURI({
      issuer: env.staffMfaIssuer,
      label: employee.email,
      secret: mfaSecret,
    }),
  };
}

// BR-264 — the cover-chain helpers live in shared/absence.ts (Phase 5 reuses them).

interface LaneBoardItem {
  laneKey: string;
  funnel: string;
  label: string;
  holderEmployeeId?: string;
  holderName?: string;
  isCovered: boolean;
  effectiveHolderEmployeeId?: string;
  effectiveHolderName?: string;
}

/** New — not in the original API_CONTRACT.md. The lane board screen. */
export async function listLaneBoard(): Promise<LaneBoardItem[]> {
  const lanes = await Lane.find().sort({ key: 1 });
  const allocations = await LaneAllocation.find().populate<{
    employeeId: { _id: Types.ObjectId; person: string };
  }>('employeeId', 'person');
  const allocationByLaneKey = new Map(
    allocations.map((allocation) => [allocation.laneKey, allocation]),
  );

  const now = new Date();
  const activeAbsences = await Absence.find().then((all) =>
    all.filter((absence) => isAbsenceActiveNow(absence, now)),
  );
  const activeAbsenceByEmployeeId = new Map(
    activeAbsences.map((absence) => [
      (absence.employeeId as Types.ObjectId).toString(),
      { coveredBy: absence.coveredBy as Types.ObjectId },
    ]),
  );

  const effectiveHolderCache = new Map<string, Types.ObjectId>();
  async function effectiveHolderNameFor(
    employeeId: Types.ObjectId,
  ): Promise<{ id: Types.ObjectId; name: string }> {
    let effectiveId = effectiveHolderCache.get(employeeId.toString());
    if (!effectiveId) {
      effectiveId = resolveEffectiveHolder(employeeId, activeAbsenceByEmployeeId);
      effectiveHolderCache.set(employeeId.toString(), effectiveId);
    }
    if (effectiveId.toString() === employeeId.toString()) {
      const self = await Employee.findById(employeeId);
      return { id: effectiveId, name: self?.person ?? 'Unknown' };
    }
    const effectiveEmployee = await Employee.findById(effectiveId);
    return { id: effectiveId, name: effectiveEmployee?.person ?? 'Unknown' };
  }

  const items: LaneBoardItem[] = [];
  for (const lane of lanes) {
    const allocation = allocationByLaneKey.get(lane.key);
    if (!allocation) {
      items.push({ laneKey: lane.key, funnel: lane.funnel, label: lane.label, isCovered: false });
      continue;
    }
    const holder = allocation.employeeId;
    const effective = await effectiveHolderNameFor(holder._id);
    items.push({
      laneKey: lane.key,
      funnel: lane.funnel,
      label: lane.label,
      holderEmployeeId: holder._id.toString(),
      holderName: holder.person,
      isCovered: true,
      effectiveHolderEmployeeId: effective.id.toString(),
      effectiveHolderName: effective.name,
    });
  }
  return items;
}

interface CreateAbsenceInput {
  employeeId: string;
  from: Date;
  returnDate: Date;
  coveredBy: string;
}

/**
 * API-133. BR-264 — cover follows the chain, guarded against a cycle.
 * BR-264 / `CH §17.12.4` — the last active person cannot go away.
 */
export async function createAbsence(
  input: CreateAbsenceInput,
  actor: AdminActor,
): Promise<{ absenceId: string }> {
  const [employee, coveredBy] = await Promise.all([
    Employee.findById(input.employeeId),
    Employee.findById(input.coveredBy),
  ]);
  if (!employee) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Employee not found.',
      field: 'employeeId',
    });
  }
  if (!coveredBy) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Coverer not found.',
      field: 'coveredBy',
    });
  }
  if (input.returnDate.getTime() <= input.from.getTime()) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Return date must be after the start date.',
      field: 'returnDate',
    });
  }

  const now = new Date();
  const allActive = await Employee.find({ active: true });
  const allAbsences = await Absence.find();
  const currentlyAbsentIds = new Set(
    allAbsences
      .filter((absence) => isAbsenceActiveNow(absence, now))
      .map((absence) => (absence.employeeId as Types.ObjectId).toString()),
  );
  const currentlyActiveCount = allActive.filter(
    (e) => !currentlyAbsentIds.has((e._id as Types.ObjectId).toString()),
  ).length;
  if (currentlyActiveCount <= 1) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'The last active person cannot be marked absent.',
      field: 'employeeId',
    });
  }
  // Phase 2 — an inactive employee is hidden from every pick list, and
  // cannot be left covering anyone.
  if (!coveredBy.active) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Pick an active employee to cover.',
      field: 'coveredBy',
    });
  }

  // Cycle guard: walk coveredBy's own chain and make sure it never leads
  // back to employeeId.
  const activeAbsenceByEmployeeId = new Map(
    allAbsences
      .filter((absence) => isAbsenceActiveNow(absence, now))
      .map((absence) => [
        (absence.employeeId as Types.ObjectId).toString(),
        { coveredBy: absence.coveredBy as Types.ObjectId },
      ]),
  );
  let walker = coveredBy._id as Types.ObjectId;
  const visited = new Set([(employee._id as Types.ObjectId).toString()]);
  for (let hops = 0; hops < 50; hops += 1) {
    if (visited.has(walker.toString())) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: 'This cover chain would loop back on itself.',
        field: 'coveredBy',
      });
    }
    visited.add(walker.toString());
    const nextAbsence = activeAbsenceByEmployeeId.get(walker.toString());
    if (!nextAbsence) break;
    walker = nextAbsence.coveredBy;
  }

  const absence = await Absence.create({
    employeeId: employee._id,
    from: input.from,
    returnDate: input.returnDate,
    coveredBy: coveredBy._id,
  });

  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'absence',
    entityId: absence._id as Types.ObjectId,
    field: 'create',
    newValue: {
      employeeId: input.employeeId,
      coveredBy: input.coveredBy,
      returnDate: input.returnDate,
    },
    correlationId: actor.correlationId,
  });

  return { absenceId: (absence._id as Types.ObjectId).toString() };
}

interface AssignBookInput {
  buyerId: string;
  ownerEmployeeId: string;
  reason?: string;
}

/**
 * New — not in the original API_CONTRACT.md. BR-261/BR-276 — "lanes own
 * queues, people own customers." The automatic queue-to-book trigger on a
 * buyer's first order belongs in `modules/chain` (M4, where orders start
 * existing); this is the manual admin/Sales-head action M3 can actually
 * build against a real `Buyer` collection.
 *
 * Phase 5 — under the same assign rule as Change owner (DEC-062): anyone
 * may take an unowned buyer for whom he may assign to; moving one already
 * owned needs his leader or Admin.
 */
export async function assignBook(
  input: AssignBookInput,
  actor: AdminActor & { permissions: string[] },
): Promise<{ bookAssignmentId: string }> {
  const buyer = await Buyer.findById(input.buyerId);
  if (!buyer) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Buyer not found.',
      field: 'buyerId',
    });
  }
  const owner = await Employee.findById(input.ownerEmployeeId);
  if (!owner || !owner.active) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Employee not found or not active.',
      field: 'ownerEmployeeId',
    });
  }

  await moveLead('sales', input.buyerId, String(owner._id), actor, {
    reason: input.reason,
    leadersOnly: false,
  });
  const assignment = await BookAssignment.findOne({ buyerId: buyer._id }, { _id: 1 });
  return { bookAssignmentId: (assignment!._id as Types.ObjectId).toString() };
}
