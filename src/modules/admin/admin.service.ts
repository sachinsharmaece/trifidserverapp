import bcrypt from 'bcryptjs';
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
import { Buyer } from '../../models/Buyer.js';
import { BookAssignment } from '../../models/BookAssignment.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';

// CH §24.1 — enforced password rules. Length comes from the config env var;
// requiring one letter and one digit is a baseline technical policy, not a
// business rule.
function assertPasswordMeetsPolicy(password: string): void {
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

interface CreateEmployeeInput {
  person: string;
  email: string;
  password: string;
  desk?: string;
  roleKeys: string[];
  laneKeys?: string[];
}

interface CreateEmployeeResult {
  employeeId: string;
  email: string;
  roleKeys: string[];
  laneKeys: string[];
  mfaEnabled: boolean;
  mfaSecret?: string;
  mfaOtpauthUrl?: string;
}

/**
 * API-132. QR-028 interim — this is the only way to create staff besides the
 * one-time seed script; the caller must already be an authenticated Admin
 * (enforced by requirePermission(EMPLOYEE_WRITE) on the route).
 *
 * BR-262 — "the create-employee form will not save until every lane on the
 * board has exactly one holder." Read literally: this checks *global* lane
 * coverage, not just the lanes this hire takes — creating a Sales employee
 * still fails if a Purchase lane is unheld elsewhere. In practice this means
 * building out a team is a sequence of saves where only the one that
 * completes the board succeeds; `CH §17.12.5` describes a dedicated "Team
 * screen" for this, which is a fair reading of why the rule is phrased this
 * way rather than "the lanes this hire takes are fully assigned."
 */
export async function createEmployee(
  input: CreateEmployeeInput,
  actor: AdminActor,
): Promise<CreateEmployeeResult> {
  assertPasswordMeetsPolicy(input.password);

  const existing = await Employee.findOne({ email: input.email.toLowerCase() });
  if (existing) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'An employee with this email already exists.',
      field: 'email',
    });
  }

  const roles = await Role.find({ key: { $in: input.roleKeys } });
  if (roles.length !== input.roleKeys.length) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'One or more roles do not exist.',
      field: 'roleKeys',
    });
  }

  const laneKeys = input.laneKeys ?? [];
  if (laneKeys.length > 0) {
    const lanes = await Lane.find({ key: { $in: laneKeys } });
    if (lanes.length !== laneKeys.length) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: 'One or more lanes do not exist.',
        field: 'laneKeys',
      });
    }
    const alreadyHeld = await LaneAllocation.find({ laneKey: { $in: laneKeys } });
    if (alreadyHeld.length > 0) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: `These lanes already have a holder: ${alreadyHeld.map((a) => a.laneKey).join(', ')}.`,
        field: 'laneKeys',
      });
    }
  }

  const needsMfa = roles.some((role) => MFA_REQUIRED_ROLE_KEYS.has(role.key));
  const mfaSecret = needsMfa ? generateSecret() : null;
  const passwordHash = await bcrypt.hash(input.password, 10);

  const employee = await withTransaction(async (session) => {
    const [created] = await Employee.create(
      [
        {
          person: input.person,
          email: input.email.toLowerCase(),
          passwordHash,
          desk: input.desk,
          roleIds: roles.map((role) => role._id),
          mfaSecret,
          mfaEnabled: needsMfa,
          active: true,
          createdBy: actor.employeeId,
        },
      ],
      { session },
    );
    if (!created) throw new Error('Employee.create returned no document.');

    if (laneKeys.length > 0) {
      await LaneAllocation.create(
        laneKeys.map((laneKey) => ({ laneKey, employeeId: created._id })),
        { session, ordered: true },
      );
    }

    // BR-262 — the save fails unless every lane on the board now has a
    // holder, whether or not this hire holds any of them.
    const totalLanes = await Lane.countDocuments({}, { session });
    const heldLanes = await LaneAllocation.countDocuments({}, { session });
    if (heldLanes < totalLanes) {
      const allLanes = await Lane.find({}, {}, { session });
      const allocations = await LaneAllocation.find({}, {}, { session });
      const heldKeys = new Set(allocations.map((allocation) => allocation.laneKey));
      const unheld = allLanes.filter((lane) => !heldKeys.has(lane.key)).map((lane) => lane.key);
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: `This employee cannot be saved: the lane board still has unheld lanes: ${unheld.join(', ')}.`,
        field: 'laneKeys',
      });
    }

    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'employee',
        entityId: created._id as Types.ObjectId,
        field: 'create',
        newValue: { email: created.email, roleKeys: input.roleKeys, laneKeys },
        correlationId: actor.correlationId,
      },
      session,
    );

    return created;
  });

  const result: CreateEmployeeResult = {
    employeeId: (employee._id as Types.ObjectId).toString(),
    email: employee.email,
    roleKeys: input.roleKeys,
    laneKeys,
    mfaEnabled: needsMfa,
  };
  if (mfaSecret) {
    result.mfaSecret = mfaSecret;
    result.mfaOtpauthUrl = generateURI({
      issuer: env.staffMfaIssuer,
      label: employee.email,
      secret: mfaSecret,
    });
  }
  return result;
}

interface EmployeeListItem {
  employeeId: string;
  person: string;
  email: string;
  desk?: string;
  roleKeys: string[];
  active: boolean;
  mfaEnabled: boolean;
}

export async function listEmployees(
  cursor: string | undefined,
  limit: number,
): Promise<{ items: EmployeeListItem[]; nextCursor?: string }> {
  const query = cursor ? { _id: { $gt: cursor } } : {};
  const employees = await Employee.find(query)
    .sort({ _id: 1 })
    .limit(limit + 1)
    .populate('roleIds', 'key');

  const hasMore = employees.length > limit;
  const page = hasMore ? employees.slice(0, limit) : employees;

  const items: EmployeeListItem[] = page.map((employee) => {
    const roleDocs = employee.roleIds as unknown as Array<{ key: string }>;
    return {
      employeeId: (employee._id as Types.ObjectId).toString(),
      person: employee.person,
      email: employee.email,
      desk: employee.desk ?? undefined,
      roleKeys: roleDocs.map((role) => role.key),
      active: employee.active,
      mfaEnabled: employee.mfaEnabled,
    };
  });

  const nextCursor = hasMore
    ? (page[page.length - 1]!._id as Types.ObjectId).toString()
    : undefined;
  return { items, nextCursor };
}

// The window during which an absence is "in effect" — used both to resolve
// cover chains and to decide who currently counts as active.
function isAbsenceActiveNow(absence: { from: Date; returnDate: Date }, now: Date): boolean {
  return absence.from.getTime() <= now.getTime() && absence.returnDate.getTime() >= now.getTime();
}

/**
 * BR-264 — cover follows the chain. Where A is covered by B, and B is then
 * also covered by C, A resolves to C, not to an empty chair. `activeById`
 * is the currently-active-absence lookup, built once per call site so a
 * lane-board listing does not re-query per lane.
 */
function resolveEffectiveHolder(
  employeeId: Types.ObjectId,
  activeAbsenceByEmployeeId: Map<string, { coveredBy: Types.ObjectId }>,
): Types.ObjectId {
  let current = employeeId;
  const visited = new Set([current.toString()]);
  for (let hops = 0; hops < 50; hops += 1) {
    const absence = activeAbsenceByEmployeeId.get(current.toString());
    if (!absence) return current;
    const next = absence.coveredBy;
    if (visited.has(next.toString())) return current; // guarded at creation time — should not happen
    visited.add(next.toString());
    current = next;
  }
  return current;
}

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
 */
export async function assignBook(
  input: AssignBookInput,
  actor: AdminActor,
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

  const assignment = await BookAssignment.findOneAndUpdate(
    { buyerId: buyer._id },
    {
      $set: {
        ownerEmployeeId: owner._id,
        assignedAt: new Date(),
        assignedBy: actor.employeeId,
        reason: input.reason,
      },
    },
    { upsert: true, new: true },
  );

  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'book_assignment',
    entityId: assignment._id as Types.ObjectId,
    field: 'owner',
    newValue: { buyerId: input.buyerId, ownerEmployeeId: input.ownerEmployeeId },
    reason: input.reason,
    correlationId: actor.correlationId,
  });

  return { bookAssignmentId: (assignment._id as Types.ObjectId).toString() };
}
