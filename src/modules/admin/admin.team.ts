import bcrypt from 'bcryptjs';
import { generateSecret, generateURI } from 'otplib';
import type { ClientSession, HydratedDocument, Types } from 'mongoose';
import { env } from '../../config/env.js';
import { MFA_REQUIRED_ROLE_KEYS } from '../../config/permissions.js';
import {
  POSITION_ROLE,
  withImpliedPositions,
  type EducationLevel,
  type Position,
} from '../../config/positions.js';
import { withTransaction } from '../../db/transaction.js';
import { Employee, type EmployeeDocument } from '../../models/Employee.js';
import { Role } from '../../models/Role.js';
import { Lane } from '../../models/Lane.js';
import { LaneAllocation } from '../../models/LaneAllocation.js';
import { AuthSession } from '../../models/AuthSession.js';
import { BookAssignment } from '../../models/BookAssignment.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { assertValidObjectId } from '../../shared/objectId.js';
import { decryptPii, encryptPii, maskAadhaar, maskPan } from '../../shared/encryption.js';
import { forgetStaffActive } from '../../shared/staffActive.js';
import { assertPasswordMeetsPolicy, type AdminActor } from './admin.service.js';

/**
 * Phase 2 — the Team page's server side (DEC-059, DEC-061, DEC-063):
 * employee create / edit / detail / list, positions and reporting lines,
 * the HR block with PAN and Aadhaar encrypted, Admin-only reveal, and
 * switching an employee off with everything he holds handed over in one
 * transaction. Every write is audited (DEC-065); PII never enters an audit
 * row or a response except through `revealEmployeePii`.
 */

const id = (value: unknown): string => String(value);
const LEADER_FOR: Record<'sales' | 'purchase', Position> = {
  sales: 'SALES_LEADER',
  purchase: 'PURCHASE_LEADER',
};
const ACCOUNTS_LIKE_ROLES = new Set(['accounts', 'transport_logistics']);

type ReportsTo = string | 'self' | null | undefined;

export interface HrInput {
  dob: string;
  pan?: string;
  aadhaar?: string;
  fatherName: string;
  fatherMobile?: string | null;
  husbandName?: string | null;
  husbandMobile?: string | null;
  emergencyContact: { name: string; relation: string; mobile: string };
  permanentAddress: string;
  currentSameAsPermanent: boolean;
  currentAddress?: string;
  education?: { level: EducationLevel | null; other?: string | null };
}

export interface TeamInput {
  person: string;
  email: string;
  mobile: string;
  desk?: string;
  roleKeys: string[];
  positions: Position[];
  reportsToSalesLeaderId?: ReportsTo;
  reportsToPurchaseLeaderId?: ReportsTo;
  worksForTeamLeaderIds?: string[];
  worksForAllTeams?: boolean;
  hr: HrInput;
}

function fieldError(field: string, messageEn: string): AppError {
  return new AppError({ code: 'VALIDATION_FAILED', messageEn, field });
}

// ---------------------------------------------------------------------------
// Team rules
// ---------------------------------------------------------------------------

interface ResolvedTeam {
  positions: Position[];
  roleIds: Types.ObjectId[];
  roleKeys: string[];
  reportsToSalesLeaderId: Types.ObjectId | 'self' | null;
  reportsToPurchaseLeaderId: Types.ObjectId | 'self' | null;
  worksForTeamLeaderIds: Types.ObjectId[];
  worksForAllTeams: boolean;
}

async function resolveLeader(
  side: 'sales' | 'purchase',
  value: ReportsTo,
  positions: Position[],
  selfId: string | null,
): Promise<Types.ObjectId | 'self'> {
  const field = side === 'sales' ? 'reportsToSalesLeaderId' : 'reportsToPurchaseLeaderId';
  const leaderPosition = LEADER_FOR[side];
  const label = side === 'sales' ? 'Sales Leader' : 'Purchase Leader';
  if (!value) throw fieldError(field, `Pick the ${label} this person reports to.`);
  if (value === 'self' || value === selfId) {
    if (!positions.includes(leaderPosition)) {
      throw fieldError(field, `Only a ${label} can report to himself.`);
    }
    return 'self';
  }
  assertValidObjectId(value, field);
  const leader = await Employee.findById(value);
  if (!leader || !leader.active || !leader.positions.includes(leaderPosition)) {
    throw fieldError(field, `Pick an active ${label} from the list.`);
  }
  return leader._id as Types.ObjectId;
}

async function resolveTeam(input: TeamInput, selfId: string | null): Promise<ResolvedTeam> {
  const positions = withImpliedPositions(input.positions ?? []);
  const roleKeys = [...new Set([...input.roleKeys, ...positions.map((p) => POSITION_ROLE[p])])];
  if (roleKeys.length === 0) {
    throw fieldError('roleKeys', 'Tick at least one role or position.');
  }
  const roles = await Role.find({ key: { $in: roleKeys } });
  if (roles.length !== roleKeys.length) {
    throw fieldError('roleKeys', 'One or more roles do not exist.');
  }

  const reportsToSalesLeaderId = positions.includes('SALES_EXEC')
    ? await resolveLeader('sales', input.reportsToSalesLeaderId, positions, selfId)
    : null;
  const reportsToPurchaseLeaderId = positions.includes('PURCHASE_EXEC')
    ? await resolveLeader('purchase', input.reportsToPurchaseLeaderId, positions, selfId)
    : null;

  // "Works for team(s)" only means something on the Accounts and Logistics
  // desks; a team is named by its Sales Leader.
  const accountsLike = roleKeys.some((key) => ACCOUNTS_LIKE_ROLES.has(key));
  const worksForAllTeams = accountsLike && Boolean(input.worksForAllTeams);
  let worksForTeamLeaderIds: Types.ObjectId[] = [];
  if (accountsLike && !worksForAllTeams && input.worksForTeamLeaderIds?.length) {
    const leaders = await Employee.find({
      _id: { $in: input.worksForTeamLeaderIds },
      active: true,
      positions: 'SALES_LEADER',
    });
    if (leaders.length !== new Set(input.worksForTeamLeaderIds).size) {
      throw fieldError(
        'worksForTeamLeaderIds',
        'Pick each team from the list of active Sales Leaders.',
      );
    }
    worksForTeamLeaderIds = leaders.map((l) => l._id as Types.ObjectId);
  }

  return {
    positions,
    roleIds: roles.map((r) => r._id as Types.ObjectId),
    roleKeys,
    reportsToSalesLeaderId,
    reportsToPurchaseLeaderId,
    worksForTeamLeaderIds,
    worksForAllTeams,
  };
}

async function assertEmailAndMobileFree(
  email: string,
  mobile: string,
  exceptId: string | null,
): Promise<void> {
  const notSelf = exceptId ? { _id: { $ne: exceptId } } : {};
  const byEmail = await Employee.findOne({ email: email.toLowerCase(), ...notSelf });
  if (byEmail) throw fieldError('email', `That email already belongs to ${byEmail.person}.`);
  const byMobile = await Employee.findOne({ mobile, ...notSelf });
  if (byMobile) throw fieldError('mobile', `That mobile already belongs to ${byMobile.person}.`);
}

/** A leader cannot drop his leader position while anyone else still reports to him. */
async function assertNoOrphans(employeeId: string, nextPositions: Position[]): Promise<void> {
  for (const side of ['sales', 'purchase'] as const) {
    if (nextPositions.includes(LEADER_FOR[side])) continue;
    const field = side === 'sales' ? 'reportsToSalesLeaderId' : 'reportsToPurchaseLeaderId';
    const reports = await Employee.find(
      { [field]: employeeId, _id: { $ne: employeeId } },
      { person: 1 },
    );
    if (reports.length > 0) {
      const names = reports.map((r) => r.person).join(', ');
      throw fieldError(
        'positions',
        `${reports.length} ${reports.length === 1 ? 'person reports' : 'people report'} to this ${
          side === 'sales' ? 'Sales' : 'Purchase'
        } Leader (${names}). Move them to another leader first.`,
      );
    }
  }
}

function buildHr(
  hr: HrInput,
  existing: EmployeeDocument['hr'] | null | undefined,
): NonNullable<EmployeeDocument['hr']> {
  const pan = hr.pan?.trim().toUpperCase();
  const aadhaar = hr.aadhaar?.replace(/\s/g, '');
  if (!pan && !existing?.panEncrypted) throw fieldError('hr.pan', 'Enter the PAN.');
  if (!aadhaar && !existing?.aadhaarEncrypted)
    throw fieldError('hr.aadhaar', 'Enter the Aadhaar number.');
  const permanent = hr.permanentAddress.trim();
  return {
    dob: new Date(`${hr.dob}T00:00:00.000Z`),
    panEncrypted: pan ? encryptPii(pan) : existing!.panEncrypted,
    panLast4: pan ? pan.slice(-4) : existing!.panLast4,
    aadhaarEncrypted: aadhaar ? encryptPii(aadhaar) : existing!.aadhaarEncrypted,
    aadhaarLast4: aadhaar ? aadhaar.slice(-4) : existing!.aadhaarLast4,
    fatherName: hr.fatherName.trim(),
    fatherMobile: hr.fatherMobile ?? null,
    husbandName: hr.husbandName ?? null,
    husbandMobile: hr.husbandMobile ?? null,
    emergencyContact: {
      name: hr.emergencyContact.name.trim(),
      relation: hr.emergencyContact.relation.trim(),
      mobile: hr.emergencyContact.mobile,
    },
    permanentAddress: { line: permanent },
    currentAddress: {
      line: hr.currentSameAsPermanent ? permanent : (hr.currentAddress ?? '').trim(),
    },
    currentSameAsPermanent: hr.currentSameAsPermanent,
    education: {
      level: hr.education?.level ?? null,
      other: hr.education?.level === 'other' ? (hr.education.other ?? null) : null,
    },
  } as NonNullable<EmployeeDocument['hr']>;
}

function leaderIdOrSelf(value: Types.ObjectId | 'self' | null, selfId: Types.ObjectId) {
  return value === 'self' ? selfId : value;
}

// ---------------------------------------------------------------------------
// Read models — PII masked, never decrypted here
// ---------------------------------------------------------------------------

export interface TeamMemberDto {
  employeeId: string;
  person: string;
  email: string;
  mobile: string | null;
  desk?: string;
  roleKeys: string[];
  positions: Position[];
  reportsToSalesLeader: { employeeId: string; person: string } | null;
  reportsToPurchaseLeader: { employeeId: string; person: string } | null;
  worksForTeams: Array<{ employeeId: string; person: string }>;
  worksForAllTeams: boolean;
  laneKeys: string[];
  active: boolean;
  mfaEnabled: boolean;
  hrComplete: boolean;
}

export interface TeamMemberDetailDto extends TeamMemberDto {
  hr: {
    dob: string;
    panMasked: string;
    aadhaarMasked: string;
    fatherName: string;
    fatherMobile: string | null;
    husbandName: string | null;
    husbandMobile: string | null;
    emergencyContact: { name: string; relation: string; mobile: string };
    permanentAddress: string;
    currentAddress: string;
    currentSameAsPermanent: boolean;
    education: { level: EducationLevel | null; other: string | null };
  } | null;
}

async function toTeamDtos(
  employees: Array<HydratedDocument<EmployeeDocument>>,
): Promise<TeamMemberDto[]> {
  const roles = await Role.find({ _id: { $in: employees.flatMap((e) => e.roleIds) } }, { key: 1 });
  const roleKey = new Map(roles.map((r) => [id(r._id), r.key]));
  const relatedIds = employees.flatMap((e) => [
    e.reportsToSalesLeaderId,
    e.reportsToPurchaseLeaderId,
    ...e.worksForTeamLeaderIds,
  ]);
  const related = await Employee.find({ _id: { $in: relatedIds.filter(Boolean) } }, { person: 1 });
  const person = new Map(related.map((r) => [id(r._id), r.person]));
  const ref = (value: unknown) =>
    value ? { employeeId: id(value), person: person.get(id(value)) ?? '—' } : null;
  const lanes = await LaneAllocation.find({ employeeId: { $in: employees.map((e) => e._id) } });
  return employees.map((e) => ({
    employeeId: id(e._id),
    person: e.person,
    email: e.email,
    mobile: e.mobile ?? null,
    desk: e.desk ?? undefined,
    roleKeys: e.roleIds.map((r) => roleKey.get(id(r))).filter((k): k is string => Boolean(k)),
    positions: e.positions as Position[],
    reportsToSalesLeader: ref(e.reportsToSalesLeaderId),
    reportsToPurchaseLeader: ref(e.reportsToPurchaseLeaderId),
    worksForTeams: e.worksForTeamLeaderIds.map((t) => ref(t)!),
    worksForAllTeams: e.worksForAllTeams,
    laneKeys: lanes.filter((l) => id(l.employeeId) === id(e._id)).map((l) => l.laneKey),
    active: e.active,
    mfaEnabled: e.mfaEnabled,
    hrComplete: Boolean(e.hr && e.mobile),
  }));
}

/** API-134 — the Team list. `status` filters Active / Inactive / All. */
export async function listTeam(filter: {
  status?: 'active' | 'inactive' | 'all';
  cursor?: string;
  limit: number;
}): Promise<{ items: TeamMemberDto[]; nextCursor?: string }> {
  const query: Record<string, unknown> = {};
  if (filter.status === 'active') query.active = true;
  if (filter.status === 'inactive') query.active = false;
  if (filter.cursor) query._id = { $gt: filter.cursor };
  const employees = await Employee.find(query)
    .sort({ _id: 1 })
    .limit(filter.limit + 1);
  const hasMore = employees.length > filter.limit;
  const page = hasMore ? employees.slice(0, filter.limit) : employees;
  return {
    items: await toTeamDtos(page),
    nextCursor: hasMore ? id(page[page.length - 1]!._id) : undefined,
  };
}

export async function getTeamMember(employeeId: string): Promise<TeamMemberDetailDto> {
  assertValidObjectId(employeeId, 'employeeId');
  const employee = await Employee.findById(employeeId);
  if (!employee) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Employee not found.' });
  const [base] = await toTeamDtos([employee]);
  const hr = employee.hr;
  return {
    ...base!,
    hr: hr
      ? {
          dob: hr.dob.toISOString().slice(0, 10),
          panMasked: maskPan(hr.panLast4),
          aadhaarMasked: maskAadhaar(hr.aadhaarLast4),
          fatherName: hr.fatherName,
          fatherMobile: hr.fatherMobile ?? null,
          husbandName: hr.husbandName ?? null,
          husbandMobile: hr.husbandMobile ?? null,
          emergencyContact: {
            name: hr.emergencyContact!.name,
            relation: hr.emergencyContact!.relation,
            mobile: hr.emergencyContact!.mobile,
          },
          permanentAddress: hr.permanentAddress!.line,
          currentAddress: hr.currentAddress!.line,
          currentSameAsPermanent: hr.currentSameAsPermanent,
          education: {
            level: (hr.education?.level as EducationLevel | null) ?? null,
            other: hr.education?.other ?? null,
          },
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

export interface CreateEmployeeResult {
  employeeId: string;
  email: string;
  roleKeys: string[];
  laneKeys: string[];
  mfaEnabled: boolean;
  mfaSecret?: string;
  mfaOtpauthUrl?: string;
}

function mfaFor(roleKeys: string[], email: string, existingSecret: string | null) {
  const needsMfa = roleKeys.some((key) => MFA_REQUIRED_ROLE_KEYS.has(key));
  if (!needsMfa || existingSecret) return { needsMfa, secret: existingSecret, issued: null };
  const secret = generateSecret();
  return {
    needsMfa,
    secret,
    issued: {
      mfaSecret: secret,
      mfaOtpauthUrl: generateURI({ issuer: env.staffMfaIssuer, label: email, secret }),
    },
  };
}

/**
 * API-132. QR-028 interim — the only way to create staff besides the
 * one-time seed script; the caller must already be an authenticated Admin
 * (enforced by requirePermission(EMPLOYEE_WRITE) on the route).
 *
 * BR-262 — "the create-employee form will not save until every lane on the
 * board has exactly one holder." Read literally: this checks *global* lane
 * coverage, not just the lanes this hire takes — creating a Sales employee
 * still fails if a Purchase lane is unheld elsewhere.
 */
export async function createEmployee(
  input: TeamInput & { password: string; laneKeys?: string[] },
  actor: AdminActor,
): Promise<CreateEmployeeResult> {
  assertPasswordMeetsPolicy(input.password);
  await assertEmailAndMobileFree(input.email, input.mobile, null);
  const team = await resolveTeam(input, null);
  const hr = buildHr(input.hr, null);

  const laneKeys = input.laneKeys ?? [];
  if (laneKeys.length > 0) {
    const lanes = await Lane.find({ key: { $in: laneKeys } });
    if (lanes.length !== laneKeys.length) {
      throw fieldError('laneKeys', 'One or more lanes do not exist.');
    }
    const alreadyHeld = await LaneAllocation.find({ laneKey: { $in: laneKeys } });
    if (alreadyHeld.length > 0) {
      throw fieldError(
        'laneKeys',
        `These lanes already have a holder: ${alreadyHeld.map((a) => a.laneKey).join(', ')}.`,
      );
    }
  }

  const email = input.email.toLowerCase();
  const mfa = mfaFor(team.roleKeys, email, null);
  const passwordHash = await bcrypt.hash(input.password, 10);

  const employee = await withTransaction(async (session) => {
    const [created] = await Employee.create(
      [
        {
          person: input.person.trim(),
          email,
          passwordHash,
          desk: input.desk,
          roleIds: team.roleIds,
          mfaSecret: mfa.secret,
          mfaEnabled: mfa.needsMfa,
          active: true,
          createdBy: actor.employeeId,
          mobile: input.mobile,
          positions: team.positions,
          worksForTeamLeaderIds: team.worksForTeamLeaderIds,
          worksForAllTeams: team.worksForAllTeams,
          hr,
        },
      ],
      { session },
    );
    if (!created) throw new Error('Employee.create returned no document.');
    // A leader who reports to himself can only be pointed at once he exists.
    const selfId = created._id as Types.ObjectId;
    created.reportsToSalesLeaderId = leaderIdOrSelf(team.reportsToSalesLeaderId, selfId);
    created.reportsToPurchaseLeaderId = leaderIdOrSelf(team.reportsToPurchaseLeaderId, selfId);
    await created.save({ session });

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
      throw fieldError(
        'laneKeys',
        `This employee cannot be saved: the lane board still has unheld lanes: ${unheld.join(', ')}.`,
      );
    }

    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'employee',
        entityId: selfId,
        field: 'create',
        newValue: {
          email,
          roleKeys: team.roleKeys,
          positions: team.positions,
          laneKeys,
        },
        correlationId: actor.correlationId,
      },
      session,
    );
    return created;
  });

  return {
    employeeId: id(employee._id),
    email: employee.email,
    roleKeys: team.roleKeys,
    laneKeys,
    mfaEnabled: mfa.needsMfa,
    ...(mfa.issued ?? {}),
  };
}

/** Phase 2 — Edit. A blank password keeps the current one; PAN/Aadhaar left out keep theirs. */
export async function updateEmployee(
  employeeId: string,
  input: TeamInput & { password?: string },
  actor: AdminActor,
): Promise<{ employeeId: string; mfaSecret?: string; mfaOtpauthUrl?: string }> {
  assertValidObjectId(employeeId, 'employeeId');
  const employee = await Employee.findById(employeeId);
  if (!employee) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Employee not found.' });
  if (input.password) assertPasswordMeetsPolicy(input.password);
  await assertEmailAndMobileFree(input.email, input.mobile, employeeId);
  const team = await resolveTeam(input, employeeId);
  await assertNoOrphans(employeeId, team.positions);
  const hr = buildHr(input.hr, employee.hr);
  const email = input.email.toLowerCase();
  const mfa = mfaFor(team.roleKeys, email, employee.mfaSecret ?? null);
  const before = {
    person: employee.person,
    email: employee.email,
    mobile: employee.mobile,
    positions: [...employee.positions],
    roleIds: employee.roleIds.map(id),
    reportsToSalesLeaderId: employee.reportsToSalesLeaderId
      ? id(employee.reportsToSalesLeaderId)
      : null,
    reportsToPurchaseLeaderId: employee.reportsToPurchaseLeaderId
      ? id(employee.reportsToPurchaseLeaderId)
      : null,
  };
  const selfId = employee._id as Types.ObjectId;

  await withTransaction(async (session) => {
    employee.person = input.person.trim();
    employee.email = email;
    employee.mobile = input.mobile;
    employee.desk = input.desk ?? employee.desk;
    employee.roleIds = team.roleIds;
    employee.positions = team.positions;
    employee.reportsToSalesLeaderId = leaderIdOrSelf(team.reportsToSalesLeaderId, selfId);
    employee.reportsToPurchaseLeaderId = leaderIdOrSelf(team.reportsToPurchaseLeaderId, selfId);
    employee.worksForTeamLeaderIds = team.worksForTeamLeaderIds;
    employee.worksForAllTeams = team.worksForAllTeams;
    employee.hr = hr;
    if (mfa.issued) {
      employee.mfaSecret = mfa.secret;
      employee.mfaEnabled = true;
    }
    if (input.password) {
      employee.passwordHash = await bcrypt.hash(input.password, 10);
      // A new password signs the person out everywhere.
      await AuthSession.updateMany(
        { employeeId: selfId, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: 'password_changed' } },
        { session },
      );
    }
    await employee.save({ session });
    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'employee',
        entityId: selfId,
        field: 'edit',
        oldValue: before,
        newValue: {
          person: employee.person,
          email,
          mobile: employee.mobile,
          positions: team.positions,
          roleKeys: team.roleKeys,
          reportsToSalesLeaderId: employee.reportsToSalesLeaderId
            ? id(employee.reportsToSalesLeaderId)
            : null,
          reportsToPurchaseLeaderId: employee.reportsToPurchaseLeaderId
            ? id(employee.reportsToPurchaseLeaderId)
            : null,
          passwordChanged: Boolean(input.password),
          panChanged: Boolean(input.hr.pan),
          aadhaarChanged: Boolean(input.hr.aadhaar),
        },
        correlationId: actor.correlationId,
      },
      session,
    );
  });

  return { employeeId, ...(mfa.issued ?? {}) };
}

// ---------------------------------------------------------------------------
// Reveal (Admin only — DEC-061)
// ---------------------------------------------------------------------------

export async function revealEmployeePii(
  employeeId: string,
  field: 'pan' | 'aadhaar',
  actor: AdminActor,
): Promise<{ field: 'pan' | 'aadhaar'; value: string }> {
  assertValidObjectId(employeeId, 'employeeId');
  const employee = await Employee.findById(employeeId, { hr: 1 });
  if (!employee?.hr)
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'No HR details on record.' });
  const value = decryptPii(
    field === 'pan' ? employee.hr.panEncrypted : employee.hr.aadhaarEncrypted,
  );
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'employee',
    entityId: employee._id as Types.ObjectId,
    field: 'pii_reveal',
    reason: `Revealed ${field === 'pan' ? 'PAN' : 'Aadhaar'}`,
    correlationId: actor.correlationId,
  });
  return { field, value };
}

// ---------------------------------------------------------------------------
// Deactivate / reactivate
// ---------------------------------------------------------------------------

export interface DeactivationImpactDto {
  employeeId: string;
  person: string;
  buyersOwned: number;
  sellersOwned: number;
  laneKeys: string[];
  directReports: Array<{ employeeId: string; person: string; side: 'sales' | 'purchase' }>;
  teamMembersServed: number;
  needsReassign: boolean;
  defaultReassignTo: { employeeId: string; person: string } | null;
}

async function impactOf(employee: HydratedDocument<EmployeeDocument>) {
  const employeeId = employee._id as Types.ObjectId;
  const [buyersOwned, lanes, salesReports, purchaseReports, servedBy] = await Promise.all([
    BookAssignment.countDocuments({ ownerEmployeeId: employeeId }),
    LaneAllocation.find({ employeeId }),
    Employee.find({ reportsToSalesLeaderId: employeeId, _id: { $ne: employeeId } }, { person: 1 }),
    Employee.find(
      { reportsToPurchaseLeaderId: employeeId, _id: { $ne: employeeId } },
      { person: 1 },
    ),
    Employee.countDocuments({ worksForTeamLeaderIds: employeeId }),
  ]);
  // Phase 4 adds seller ownership; until then nobody owns a seller.
  const sellersOwned = 0;
  const directReports = [
    ...salesReports.map((r) => ({
      employeeId: id(r._id),
      person: r.person,
      side: 'sales' as const,
    })),
    ...purchaseReports.map((r) => ({
      employeeId: id(r._id),
      person: r.person,
      side: 'purchase' as const,
    })),
  ];
  return {
    buyersOwned,
    sellersOwned,
    laneKeys: lanes.map((l) => l.laneKey),
    directReports,
    salesReports: salesReports.length,
    purchaseReports: purchaseReports.length,
    teamMembersServed: servedBy,
    needsReassign: buyersOwned + sellersOwned + lanes.length + directReports.length + servedBy > 0,
  };
}

export async function getDeactivationImpact(employeeId: string): Promise<DeactivationImpactDto> {
  assertValidObjectId(employeeId, 'employeeId');
  const employee = await Employee.findById(employeeId);
  if (!employee) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Employee not found.' });
  const impact = await impactOf(employee);
  // The default heir is his own leader — never for a leader with people
  // under him (an Admin picks), and never himself.
  let defaultReassignTo: DeactivationImpactDto['defaultReassignTo'] = null;
  if (impact.directReports.length === 0) {
    for (const leaderId of [employee.reportsToSalesLeaderId, employee.reportsToPurchaseLeaderId]) {
      if (!leaderId || id(leaderId) === employeeId) continue;
      const leader = await Employee.findById(leaderId, { person: 1, active: 1 });
      if (leader?.active) {
        defaultReassignTo = { employeeId: id(leader._id), person: leader.person };
        break;
      }
    }
  }
  return {
    employeeId,
    person: employee.person,
    buyersOwned: impact.buyersOwned,
    sellersOwned: impact.sellersOwned,
    laneKeys: impact.laneKeys,
    directReports: impact.directReports,
    teamMembersServed: impact.teamMembersServed,
    needsReassign: impact.needsReassign,
    defaultReassignTo,
  };
}

async function assertNotLastAdminOrFounder(employee: HydratedDocument<EmployeeDocument>) {
  const guardRoles = await Role.find({ key: { $in: ['admin', 'founder'] } }, { _id: 1, key: 1 });
  const guardIds = guardRoles.map((r) => id(r._id));
  if (!employee.roleIds.some((r) => guardIds.includes(id(r)))) return;
  const others = await Employee.countDocuments({
    _id: { $ne: employee._id },
    active: true,
    roleIds: { $in: guardRoles.map((r) => r._id) },
  });
  if (others === 0) {
    throw fieldError(
      'employeeId',
      'This is the last active Admin or Founder — switch someone else on first.',
    );
  }
}

/**
 * Phase 2 — switch an employee off. Everything he holds goes to one person
 * in **one transaction**: his buyers (book assignments), lanes, the people
 * who report to him, and the Accounts/Logistics staff who work for his team.
 * Then his sessions are revoked, so he is out at once (the auth middleware
 * also refuses an inactive employee's live access token within 30 s).
 */
export async function deactivateEmployee(
  employeeId: string,
  input: { reassignToEmployeeId?: string; reason?: string },
  actor: AdminActor,
): Promise<{ deactivated: true; reassigned: Omit<DeactivationImpactDto, 'defaultReassignTo'> }> {
  assertValidObjectId(employeeId, 'employeeId');
  if (employeeId === actor.employeeId) {
    throw fieldError('employeeId', 'You cannot switch yourself off.');
  }
  const employee = await Employee.findById(employeeId);
  if (!employee) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Employee not found.' });
  if (!employee.active) throw fieldError('employeeId', `${employee.person} is already inactive.`);
  await assertNotLastAdminOrFounder(employee);

  const impact = await impactOf(employee);
  let target: HydratedDocument<EmployeeDocument> | null = null;
  if (impact.needsReassign) {
    if (!input.reassignToEmployeeId) {
      throw fieldError('reassignToEmployeeId', `Pick who takes over from ${employee.person}.`);
    }
    if (input.reassignToEmployeeId === employeeId) {
      throw fieldError('reassignToEmployeeId', 'Pick someone other than the person leaving.');
    }
    assertValidObjectId(input.reassignToEmployeeId, 'reassignToEmployeeId');
    target = await Employee.findById(input.reassignToEmployeeId);
    if (!target || !target.active) {
      throw fieldError('reassignToEmployeeId', 'Pick an active employee from the list.');
    }
    if (impact.salesReports > 0 && !target.positions.includes('SALES_LEADER')) {
      throw fieldError(
        'reassignToEmployeeId',
        'His Sales team needs another Sales Leader to report to.',
      );
    }
    if (impact.purchaseReports > 0 && !target.positions.includes('PURCHASE_LEADER')) {
      throw fieldError(
        'reassignToEmployeeId',
        'His Purchase team needs another Purchase Leader to report to.',
      );
    }
    if (impact.teamMembersServed > 0 && !target.positions.includes('SALES_LEADER')) {
      throw fieldError(
        'reassignToEmployeeId',
        'Accounts/Logistics staff work for his team — hand it to another Sales Leader.',
      );
    }
  }

  const from = employee._id as Types.ObjectId;
  const to = target ? (target._id as Types.ObjectId) : null;
  await withTransaction(async (session: ClientSession) => {
    if (to) {
      await BookAssignment.updateMany(
        { ownerEmployeeId: from },
        {
          $set: {
            ownerEmployeeId: to,
            assignedAt: new Date(),
            assignedBy: actor.employeeId,
            reason: `Reassigned from ${employee.person} on deactivation.`,
          },
        },
        { session },
      );
      await LaneAllocation.updateMany(
        { employeeId: from },
        { $set: { employeeId: to } },
        { session },
      );
      await Employee.updateMany(
        { reportsToSalesLeaderId: from, _id: { $ne: from } },
        { $set: { reportsToSalesLeaderId: to } },
        { session },
      );
      await Employee.updateMany(
        { reportsToPurchaseLeaderId: from, _id: { $ne: from } },
        { $set: { reportsToPurchaseLeaderId: to } },
        { session },
      );
      await Employee.updateMany(
        { worksForTeamLeaderIds: from },
        { $addToSet: { worksForTeamLeaderIds: to } },
        { session },
      );
      await Employee.updateMany(
        { worksForTeamLeaderIds: from },
        { $pull: { worksForTeamLeaderIds: from } },
        { session },
      );
    }
    await Employee.updateOne(
      { _id: from },
      { $set: { active: false, deactivatedAt: new Date(), deactivatedBy: actor.employeeId } },
      { session },
    );
    await AuthSession.updateMany(
      { employeeId: from, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'deactivated' } },
      { session },
    );
    await writeAuditLog(
      {
        actorId: actor.employeeId,
        actorType: 'staff',
        entity: 'employee',
        entityId: from,
        field: 'deactivate',
        oldValue: { active: true },
        newValue: {
          active: false,
          reassignedTo: to ? id(to) : null,
          buyers: impact.buyersOwned,
          lanes: impact.laneKeys,
          reports: impact.directReports.map((r) => r.employeeId),
        },
        reason: input.reason,
        correlationId: actor.correlationId,
      },
      session,
    );
  });
  forgetStaffActive(employeeId);

  return {
    deactivated: true,
    reassigned: {
      employeeId,
      person: employee.person,
      buyersOwned: impact.buyersOwned,
      sellersOwned: impact.sellersOwned,
      laneKeys: impact.laneKeys,
      directReports: impact.directReports,
      teamMembersServed: impact.teamMembersServed,
      needsReassign: impact.needsReassign,
    },
  };
}

export async function reactivateEmployee(
  employeeId: string,
  actor: AdminActor,
): Promise<{ reactivated: true }> {
  assertValidObjectId(employeeId, 'employeeId');
  const employee = await Employee.findById(employeeId);
  if (!employee) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Employee not found.' });
  if (employee.active) throw fieldError('employeeId', `${employee.person} is already active.`);
  employee.active = true;
  employee.deactivatedAt = null;
  employee.deactivatedBy = null;
  employee.failedLoginAttempts = 0;
  employee.lockedUntil = null;
  await employee.save();
  forgetStaffActive(employeeId);
  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'employee',
    entityId: employee._id as Types.ObjectId,
    field: 'reactivate',
    oldValue: { active: false },
    newValue: { active: true },
    correlationId: actor.correlationId,
  });
  return { reactivated: true };
}
