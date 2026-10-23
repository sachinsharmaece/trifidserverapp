import type { Types } from 'mongoose';
import { Employee } from '../models/Employee.js';
import { Role } from '../models/Role.js';
import { PERMISSIONS } from '../config/permissions.js';
import { AppError } from './errors.js';

/**
 * Phase 3 — who is in whose team, and who may assign a buyer to whom
 * (DEC-059, DEC-062). Read from the database, never the access token, so a
 * team change applies at once. Phase 5's visibility rules build on the same
 * helpers.
 *
 * A Sales Leader's team is everyone whose `reportsToSalesLeaderId` is him,
 * plus himself.
 */
export interface StaffCaller {
  employeeId: string;
  permissions: string[];
}

const id = (value: unknown): string => String(value);

export async function salesTeamOf(leaderId: string): Promise<string[]> {
  const members = await Employee.find(
    { reportsToSalesLeaderId: leaderId, active: true },
    { _id: 1 },
  );
  return [...new Set([leaderId, ...members.map((m) => id(m._id))])];
}

export async function isSalesLeader(employeeId: string): Promise<boolean> {
  return Boolean(
    await Employee.exists({ _id: employeeId, active: true, positions: 'SALES_LEADER' }),
  );
}

/** The Sales Leader of the team this person sits in (himself, for a leader). */
export async function salesLeaderOf(employeeId: string): Promise<string | null> {
  const employee = await Employee.findById(employeeId, { positions: 1, reportsToSalesLeaderId: 1 });
  if (!employee) return null;
  if (employee.positions.includes('SALES_LEADER')) return employeeId;
  return employee.reportsToSalesLeaderId ? id(employee.reportsToSalesLeaderId) : null;
}

/**
 * Someone a buyer can be assigned to: active and on the Sales side — a
 * Sales Executive or Sales Leader by position, or (for staff created before
 * positions existed) anyone holding the Sales role.
 */
async function assertAssignableSalesPerson(employeeId: string, field: string) {
  const employee = await Employee.findById(employeeId);
  if (!employee || !employee.active) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Pick an active Sales person from the list.',
      field,
    });
  }
  const onSalesSide =
    employee.positions.includes('SALES_EXEC') || employee.positions.includes('SALES_LEADER');
  if (!onSalesSide) {
    const salesRole = await Role.findOne({ key: 'sales' }, { _id: 1 });
    const hasSalesRole = Boolean(
      salesRole && employee.roleIds.some((r) => id(r) === id(salesRole._id)),
    );
    if (!hasSalesRole) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: `${employee.person} is not on the Sales side — pick a Sales person.`,
        field,
      });
    }
  }
  return employee;
}

/**
 * The assign rule (prompt Phase 3, DEC-062): an executive may assign only to
 * himself (or leave the lead in the Queue); a leader to anyone in his team;
 * Admin to anyone active on the Sales side. `null` means the Queue.
 */
export async function assertMayAssignBuyer(
  caller: StaffCaller,
  targetEmployeeId: string | null,
  field = 'assignedToEmployeeId',
): Promise<void> {
  if (!targetEmployeeId) return;
  const target = await assertAssignableSalesPerson(targetEmployeeId, field);
  if (caller.permissions.includes(PERMISSIONS.BUYER_ADMIN)) return;
  if (targetEmployeeId === caller.employeeId) return;
  if (await isSalesLeader(caller.employeeId)) {
    const team = await salesTeamOf(caller.employeeId);
    if (team.includes(targetEmployeeId)) return;
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: `${target.person} is not in your team.`,
      field,
    });
  }
  throw new AppError({
    code: 'VALIDATION_FAILED',
    messageEn: 'You can assign a buyer only to yourself, or leave him in the Queue.',
    field,
  });
}

/** Who a new lead defaults to: the person raising it, if he is on the Sales side. */
export async function defaultAssigneeFor(employeeId: string): Promise<string | null> {
  try {
    await assertAssignableSalesPerson(employeeId, 'assignedToEmployeeId');
    return employeeId;
  } catch {
    return null;
  }
}

/**
 * Whether this caller may act on a buyer assigned to `ownerId` (null =
 * Queue) as an approver or editor: Admin anywhere; a leader for his team and
 * the Queue; anyone else only for his own.
 */
export async function callerCoversBuyer(
  caller: StaffCaller,
  ownerId: string | null,
  options: { queueAllowed: boolean },
): Promise<boolean> {
  if (caller.permissions.includes(PERMISSIONS.BUYER_ADMIN)) return true;
  if (ownerId === caller.employeeId) return true;
  if (await isSalesLeader(caller.employeeId)) {
    if (!ownerId) return options.queueAllowed;
    return (await salesTeamOf(caller.employeeId)).includes(ownerId);
  }
  return false;
}

/**
 * Phase 3 — who this caller may assign a buyer to, for the "Assigned to"
 * picker: himself as an executive; his team as a Sales Leader; every active
 * Sales person for Admin. Mirrors `assertMayAssignBuyer`.
 */
export async function listAssignableSalesPeople(
  caller: StaffCaller,
): Promise<Array<{ employeeId: string; person: string; isSelf: boolean }>> {
  const salesRole = await Role.findOne({ key: 'sales' }, { _id: 1 });
  const onSalesSide = {
    active: true,
    $or: [
      { positions: { $in: ['SALES_EXEC', 'SALES_LEADER'] } },
      ...(salesRole ? [{ roleIds: salesRole._id }] : []),
    ],
  };
  let ids: string[] | null = null;
  if (!caller.permissions.includes(PERMISSIONS.BUYER_ADMIN)) {
    ids = (await isSalesLeader(caller.employeeId))
      ? await salesTeamOf(caller.employeeId)
      : [caller.employeeId];
  }
  const people = await Employee.find(
    { ...onSalesSide, ...(ids ? { _id: { $in: ids } } : {}) },
    { person: 1 },
  ).sort({ person: 1 });
  return people.map((p) => ({
    employeeId: id(p._id),
    person: p.person,
    isSelf: id(p._id) === caller.employeeId,
  }));
}

export type ObjectIdLike = Types.ObjectId | string;
