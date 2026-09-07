import bcrypt from 'bcryptjs';
import { generateSecret, generateURI } from 'otplib';
import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { MFA_REQUIRED_ROLE_KEYS } from '../../config/permissions.js';
import { Config } from '../../models/Config.js';
import { Employee } from '../../models/Employee.js';
import { Role } from '../../models/Role.js';
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
}

interface CreateEmployeeResult {
  employeeId: string;
  email: string;
  roleKeys: string[];
  mfaEnabled: boolean;
  mfaSecret?: string;
  mfaOtpauthUrl?: string;
}

/**
 * API-132. QR-028 interim — this is the only way to create staff besides the
 * one-time seed script; the caller must already be an authenticated Admin
 * (enforced by requirePermission(EMPLOYEE_WRITE) on the route).
 *
 * BR-262 (every lane has exactly one holder) is not enforced here: lanes
 * (ENT-15) are not part of this session's scope (see MASTER_PLAN.md §M2's
 * model list) and arrive with the desk-allocation work in a later milestone.
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

  const needsMfa = roles.some((role) => MFA_REQUIRED_ROLE_KEYS.has(role.key));
  const mfaSecret = needsMfa ? generateSecret() : null;

  const passwordHash = await bcrypt.hash(input.password, 10);
  const employee = await Employee.create({
    person: input.person,
    email: input.email.toLowerCase(),
    passwordHash,
    desk: input.desk,
    roleIds: roles.map((role) => role._id),
    mfaSecret,
    mfaEnabled: needsMfa,
    active: true,
    createdBy: actor.employeeId,
  });

  await writeAuditLog({
    actorId: actor.employeeId,
    actorType: 'staff',
    entity: 'employee',
    entityId: employee._id as Types.ObjectId,
    field: 'create',
    newValue: { email: employee.email, roleKeys: input.roleKeys },
    correlationId: actor.correlationId,
  });

  const result: CreateEmployeeResult = {
    employeeId: (employee._id as Types.ObjectId).toString(),
    email: employee.email,
    roleKeys: input.roleKeys,
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
