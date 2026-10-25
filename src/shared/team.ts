import type { Types } from 'mongoose';
import { Employee } from '../models/Employee.js';
import { Role } from '../models/Role.js';
import { PERMISSIONS } from '../config/permissions.js';
import { AppError } from './errors.js';

/**
 * Phase 3–4 — who is in whose team, and who may assign a lead to whom
 * (DEC-059, DEC-062), on both sides: buyers (Sales) and sellers (Purchase).
 * Read from the database, never the access token, so a team change applies
 * at once. Phase 5's visibility rules build on the same helpers.
 *
 * A leader's team is everyone whose reports-to for that side is him, plus
 * himself. Every Sales Leader is also his own team's Purchase Executive, so
 * he appears on the Purchase side through his PURCHASE_EXEC position.
 */
export interface StaffCaller {
  employeeId: string;
  permissions: string[];
}

export type Side = 'sales' | 'purchase';

const SIDE = {
  sales: {
    leader: 'SALES_LEADER',
    exec: 'SALES_EXEC',
    reportsTo: 'reportsToSalesLeaderId',
    role: 'sales',
    admin: PERMISSIONS.BUYER_ADMIN,
    label: 'Sales',
    lead: 'buyer',
  },
  purchase: {
    leader: 'PURCHASE_LEADER',
    exec: 'PURCHASE_EXEC',
    reportsTo: 'reportsToPurchaseLeaderId',
    role: 'purchase',
    admin: PERMISSIONS.SELLER_ADMIN,
    label: 'Purchase',
    lead: 'seller',
  },
} as const;

const id = (value: unknown): string => String(value);

export async function teamOf(side: Side, leaderId: string): Promise<string[]> {
  // DEC-066 — a Sales Leader reports to Admin, so no Purchase Leader's team
  // takes him in, even from an older record that still names one; his
  // sellers and the pushes he receives are decided by Admin.
  const members = await Employee.find(
    {
      [SIDE[side].reportsTo]: leaderId,
      active: true,
      ...(side === 'purchase' ? { positions: { $ne: 'SALES_LEADER' } } : {}),
    },
    { _id: 1 },
  );
  return [...new Set([leaderId, ...members.map((m) => id(m._id))])];
}

export async function isLeaderOf(side: Side, employeeId: string): Promise<boolean> {
  return Boolean(
    await Employee.exists({ _id: employeeId, active: true, positions: SIDE[side].leader }),
  );
}

/** The leader of the team this person sits in on that side (himself, for a leader). */
export async function leaderOf(side: Side, employeeId: string): Promise<string | null> {
  const employee = await Employee.findById(employeeId, {
    positions: 1,
    reportsToSalesLeaderId: 1,
    reportsToPurchaseLeaderId: 1,
  });
  if (!employee) return null;
  if (employee.positions.includes(SIDE[side].leader)) return employeeId;
  const reportsTo = employee[SIDE[side].reportsTo];
  return reportsTo ? id(reportsTo) : null;
}

async function sideFilter(side: Side) {
  const role = await Role.findOne({ key: SIDE[side].role }, { _id: 1 });
  return {
    active: true,
    $or: [
      { positions: { $in: [SIDE[side].exec, SIDE[side].leader] } },
      ...(role ? [{ roleIds: role._id }] : []),
    ],
  };
}

/**
 * Someone a lead can be assigned to: active and on that side — an executive
 * or leader by position, or (for staff created before positions existed)
 * anyone holding the side's role.
 */
async function assertAssignable(side: Side, employeeId: string, field: string) {
  const employee = await Employee.findOne({ _id: employeeId, ...(await sideFilter(side)) });
  if (!employee) {
    const exists = await Employee.findById(employeeId, { person: 1, active: 1 });
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn:
        exists && exists.active
          ? `${exists.person} is not on the ${SIDE[side].label} side — pick a ${SIDE[side].label} person.`
          : `Pick an active ${SIDE[side].label} person from the list.`,
      field,
    });
  }
  return employee;
}

/**
 * The assign rule (prompt Phase 3, DEC-062): an executive may assign only to
 * himself (or leave the lead in the Queue); a leader to anyone in his team;
 * Admin to anyone active on that side. `null` means the Queue.
 */
export async function assertMayAssign(
  side: Side,
  caller: StaffCaller,
  targetEmployeeId: string | null,
  field = 'assignedToEmployeeId',
): Promise<void> {
  if (!targetEmployeeId) return;
  const target = await assertAssignable(side, targetEmployeeId, field);
  if (caller.permissions.includes(SIDE[side].admin)) return;
  if (targetEmployeeId === caller.employeeId) return;
  if (await isLeaderOf(side, caller.employeeId)) {
    if ((await teamOf(side, caller.employeeId)).includes(targetEmployeeId)) return;
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: `${target.person} is not in your team.`,
      field,
    });
  }
  throw new AppError({
    code: 'VALIDATION_FAILED',
    messageEn: `You can assign a ${SIDE[side].lead} only to yourself, or leave him in the Queue.`,
    field,
  });
}

/** Who a new lead defaults to: the person raising it, if he is on that side. */
export async function defaultAssignee(side: Side, employeeId: string): Promise<string | null> {
  try {
    await assertAssignable(side, employeeId, 'assignedToEmployeeId');
    return employeeId;
  } catch {
    return null;
  }
}

/**
 * Whether this caller may act on a lead assigned to `ownerId` (null =
 * Queue) as an approver or editor: Admin anywhere; a leader for his team
 * (and the Queue, where allowed); anyone else only for his own.
 */
export async function callerCovers(
  side: Side,
  caller: StaffCaller,
  ownerId: string | null,
  options: { queueAllowed: boolean },
): Promise<boolean> {
  if (caller.permissions.includes(SIDE[side].admin)) return true;
  if (ownerId === caller.employeeId) return true;
  if (await isLeaderOf(side, caller.employeeId)) {
    if (!ownerId) return options.queueAllowed;
    return (await teamOf(side, caller.employeeId)).includes(ownerId);
  }
  return false;
}

/**
 * Phase 5 — the Change owner action: Admin on any lead; a leader on his
 * team's leads and the Queue. Never an executive.
 */
export async function mayChangeOwner(
  side: Side,
  caller: StaffCaller,
  ownerId: string | null,
): Promise<boolean> {
  if (caller.permissions.includes(SIDE[side].admin)) return true;
  if (!(await isLeaderOf(side, caller.employeeId))) return false;
  return callerCovers(side, caller, ownerId, { queueAllowed: true });
}

/**
 * For the "Assigned to" picker: himself as an executive; his team as a
 * leader; everyone active on that side for Admin. Mirrors `assertMayAssign`.
 */
export async function listAssignable(
  side: Side,
  caller: StaffCaller,
): Promise<Array<{ employeeId: string; person: string; isSelf: boolean }>> {
  let ids: string[] | null = null;
  if (!caller.permissions.includes(SIDE[side].admin)) {
    ids = (await isLeaderOf(side, caller.employeeId))
      ? await teamOf(side, caller.employeeId)
      : [caller.employeeId];
  }
  const people = await Employee.find(
    { ...(await sideFilter(side)), ...(ids ? { _id: { $in: ids } } : {}) },
    { person: 1 },
  ).sort({ person: 1 });
  return people.map((p) => ({
    employeeId: id(p._id),
    person: p.person,
    isSelf: id(p._id) === caller.employeeId,
  }));
}

// --- Sales-side names used since Phase 3 ------------------------------------

export const salesTeamOf = (leaderId: string) => teamOf('sales', leaderId);
export const isSalesLeader = (employeeId: string) => isLeaderOf('sales', employeeId);
export const salesLeaderOf = (employeeId: string) => leaderOf('sales', employeeId);
export const assertMayAssignBuyer = (
  caller: StaffCaller,
  target: string | null,
  field = 'assignedToEmployeeId',
) => assertMayAssign('sales', caller, target, field);
export const defaultAssigneeFor = (employeeId: string) => defaultAssignee('sales', employeeId);
export const callerCoversBuyer = (
  caller: StaffCaller,
  ownerId: string | null,
  options: { queueAllowed: boolean },
) => callerCovers('sales', caller, ownerId, options);
export const listAssignableSalesPeople = (caller: StaffCaller) => listAssignable('sales', caller);

export type ObjectIdLike = Types.ObjectId | string;
