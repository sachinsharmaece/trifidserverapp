import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { SessionModel, UserModel } from '../../models/index.js';
import { onlyChanged, writeAudit } from '../../shared/audit.js';
import { forbidden, invalidField, notFound } from '../../shared/errors.js';
import { failIfDuplicate } from '../../shared/mongo.js';
import {
  POSITION_INFO,
  ROLES,
  STAFF_POSITIONS,
  type Role,
  type StaffPosition,
} from '../../shared/enums.js';
import { TehsilModel } from '../../models/index.js';
import { generateTemporaryPassword, hashPassword } from '../auth/password.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';

export const usersRouter: Router = Router();

// Reference-copy branch (the reference's Staff screen): everyone signed in may read the staff list (it is used for the
// "Reports to" picker); Admin, Controller and Founder add staff and set positions. Names, roles, turning an account
// off and resetting a password stay with Founder and Admin.
usersRouter.use('/users', requireAuth);
const canAddStaff = requireRole('ADMIN', 'CONTROLLER', 'FOUNDER');
const canManageAccounts = requireRole('FOUNDER', 'ADMIN');
const ROLES_WITH_POSITION: readonly Role[] = ['SALES', 'PURCHASE', 'ACCOUNTS', 'LOGISTICS'];

const createBody = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(100),
    email: z.string().trim().toLowerCase().pipe(z.email('A valid email is required')),
    role: z.enum(ROLES),
    position: z.enum(STAFF_POSITIONS).optional(),
    reportsToId: z.string().optional(),
    workingAreaId: z.string().optional(),
    /** The initial password typed by the person adding the account; left out = the server makes one up. */
    password: z.string().min(8, 'Password must be at least 8 characters').max(200).optional(),
  })
  .refine((body) => !ROLES_WITH_POSITION.includes(body.role) || Boolean(body.position), {
    message: 'Position is required for this role',
    path: ['position'],
  })
  .refine((body) => !body.position || POSITION_INFO[body.position].department === body.role, {
    message: 'This position belongs to another department',
    path: ['position'],
  });

const positionBody = z
  .object({
    position: z.enum(STAFF_POSITIONS).nullable(),
    reportsToId: z.string().nullable(),
    workingAreaId: z.string().nullable(),
  })
  .partial();

/** A manager must exist, have a position, and be in the same department (LOCK-37 §5). */
async function checkManager(
  reportsToId: string | null | undefined,
  position: StaffPosition | null | undefined,
) {
  if (!reportsToId) return;
  const manager = isValidObjectId(reportsToId) ? await UserModel.findById(reportsToId) : null;
  if (!manager?.position) throw invalidField('reportsToId', 'Select a valid manager');
  if (
    !position ||
    POSITION_INFO[manager.position].department !== POSITION_INFO[position].department
  ) {
    throw invalidField('reportsToId', 'A manager must be in the same department');
  }
}

async function checkWorkingArea(workingAreaId: string | null | undefined) {
  if (!workingAreaId) return;
  const tehsil = isValidObjectId(workingAreaId) ? await TehsilModel.findById(workingAreaId) : null;
  if (!tehsil) throw invalidField('workingAreaId', 'Select a valid working area');
}

const updateBody = z
  .object({
    name: z.string().trim().min(1, 'Enter a name.').max(100),
    role: z.enum(ROLES),
    active: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to change.');

/** What the admin app may see about a staff member. Never the password hash. */
type StaffDoc = InstanceType<typeof UserModel>;

function toStaffMember(
  user: StaffDoc,
  names: Map<string, { name: string }> = new Map(),
  areas: Map<string, { name: string; district: string; state: string }> = new Map(),
) {
  const managerId = user.reportsToId ? String(user.reportsToId) : null;
  const areaId = user.workingAreaId ? String(user.workingAreaId) : null;
  const area = areaId ? areas.get(areaId) : undefined;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    active: user.active,
    mustChangePassword: user.mustChangePassword,
    position: user.position ?? null,
    reportsToId: managerId,
    reportsTo:
      managerId && names.has(managerId)
        ? { id: managerId, name: names.get(managerId)!.name }
        : null,
    workingAreaId: areaId,
    workingArea: area && areaId ? { id: areaId, ...area } : null,
    receivingLeads: user.receivingLeads,
  };
}

/** Staff rows with their manager's name and working area filled in. */
async function staffRows(users: StaffDoc[]) {
  const all = await UserModel.find({}, { name: 1 });
  const names = new Map(all.map((user) => [user.id, { name: user.name }]));
  const tehsils = await TehsilModel.find({
    _id: { $in: users.flatMap((user) => (user.workingAreaId ? [user.workingAreaId] : [])) },
  });
  const areas = new Map(
    tehsils.map((tehsil) => [
      tehsil.id,
      { name: tehsil.name, district: tehsil.district, state: tehsil.state },
    ]),
  );
  return users.map((user) => toStaffMember(user, names, areas));
}

/** Loads the staff member from the URL, or answers 404. */
async function findStaffMember(id: string) {
  if (!isValidObjectId(id)) throw notFound('Staff member not found.');
  const user = await UserModel.findById(id);
  if (!user) throw notFound('Staff member not found.');
  return user;
}

/** Only a Founder may create, edit or reset a Founder account; otherwise an Admin could make themselves one. */
function assertMayManage(actorRole: Role, targetRole: Role): void {
  if (targetRole === 'FOUNDER' && actorRole !== 'FOUNDER') {
    throw forbidden('Only a Founder can manage Founder accounts.');
  }
}

const EMAIL_TAKEN = 'A staff member with this email already exists.';

/** GET /users  ->  { users }. A company has a handful of staff, so there is no paging. */
usersRouter.get('/users', async (_req, res) => {
  const users = await UserModel.find().sort({ name: 1 });
  res.json({ users: await staffRows(users) });
});

/**
 * POST /users  { name, email, role }  ->  201 { user, temporaryPassword }.
 * The server makes up the temporary password and shows it ONCE here; it is stored only as a hash.
 * The new person must replace it at their first sign-in.
 */
usersRouter.post('/users', canAddStaff, async (req, res) => {
  const actor = currentUserOf(req);
  const body = createBody.parse(req.body);
  assertMayManage(actor.role, body.role);
  await checkManager(body.reportsToId, body.position);
  await checkWorkingArea(body.workingAreaId);

  const temporaryPassword = body.password ?? generateTemporaryPassword();
  const user = await UserModel.create({
    name: body.name,
    email: body.email,
    role: body.role,
    ...(body.position ? { position: body.position } : {}),
    ...(body.reportsToId ? { reportsToId: body.reportsToId } : {}),
    ...(body.workingAreaId ? { workingAreaId: body.workingAreaId } : {}),
    passwordHash: await hashPassword(temporaryPassword),
    mustChangePassword: true,
    createdBy: actor.id,
  }).catch(failIfDuplicate(EMAIL_TAKEN, 'EMAIL_TAKEN'));

  await writeAudit(req, {
    action: 'user.create',
    entityType: 'User',
    entityId: user.id,
    before: {},
    after: { email: user.email, role: user.role, position: user.position ?? null },
  });
  const [row] = await staffRows([user]);
  // The password is shown back only when the server made it up; a typed one is never sent back.
  res.status(201).json({ user: row, ...(body.password ? {} : { temporaryPassword }) });
});

/**
 * PATCH /users/:id  { name?, role?, active? }  ->  { user }.
 * Changing the role or turning the account off ends that person's sessions at once (SRS-AUTH-06).
 */
usersRouter.patch('/users/:id', canManageAccounts, async (req, res) => {
  const actor = currentUserOf(req);
  const changes = updateBody.parse(req.body);
  const user = await findStaffMember(req.params.id);

  assertMayManage(actor.role, user.role);
  if (changes.role) assertMayManage(actor.role, changes.role);
  if (user.id === actor.id && (changes.role !== undefined || changes.active !== undefined)) {
    throw forbidden('You cannot change your own role or turn off your own account.');
  }

  const { before, after } = onlyChanged(
    { name: user.name, role: user.role, active: user.active },
    {
      name: changes.name ?? user.name,
      role: changes.role ?? user.role,
      active: changes.active ?? user.active,
    },
  );
  if (Object.keys(after).length === 0) {
    res.json({ user: (await staffRows([user]))[0] });
    return;
  }

  // A new role means a new department: the old position and manager no longer apply.
  const update =
    after.role !== undefined
      ? { $set: after, $unset: { position: '', reportsToId: '' } }
      : { $set: after };
  const updated = await UserModel.findByIdAndUpdate(user._id, update, { returnDocument: 'after' });
  if (!updated) throw notFound('Staff member not found.');

  if (after.role !== undefined || after.active === false) {
    await SessionModel.deleteMany({ userId: user._id });
  }
  await writeAudit(req, {
    action: 'user.update',
    entityType: 'User',
    entityId: user.id,
    before,
    after,
  });
  res.json({ user: (await staffRows([updated]))[0] });
});

/**
 * PATCH /users/:id/position  { position?, reportsToId?, workingAreaId? }  ->  { user }.
 * LOCK-37 §9: Admin, Controller and Founder set a person's position, manager and working area.
 */
usersRouter.patch('/users/:id/position', canAddStaff, async (req, res) => {
  const changes = positionBody.parse(req.body);
  const user = await findStaffMember(req.params.id);
  const nextPosition = changes.position === undefined ? (user.position ?? null) : changes.position;
  if (nextPosition && POSITION_INFO[nextPosition].department !== user.role) {
    throw invalidField('position', 'This position belongs to another department');
  }
  await checkManager(changes.reportsToId, nextPosition);
  await checkWorkingArea(changes.workingAreaId);
  const before = {
    position: user.position ?? null,
    reportsToId: user.reportsToId ? String(user.reportsToId) : null,
    workingAreaId: user.workingAreaId ? String(user.workingAreaId) : null,
  };
  const set: Record<string, unknown> = {};
  const unset: Record<string, ''> = {};
  for (const field of ['position', 'reportsToId', 'workingAreaId'] as const) {
    if (changes[field] === undefined) continue;
    if (changes[field] === null) unset[field] = '';
    else set[field] = changes[field];
  }
  const updated = await UserModel.findByIdAndUpdate(
    user._id,
    {
      ...(Object.keys(set).length ? { $set: set } : {}),
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw notFound('Staff member not found.');
  await writeAudit(req, {
    action: 'user.update_position',
    entityType: 'User',
    entityId: user.id,
    before,
    after: {
      position: updated.position ?? null,
      reportsToId: updated.reportsToId ? String(updated.reportsToId) : null,
      workingAreaId: updated.workingAreaId ? String(updated.workingAreaId) : null,
    },
  });
  res.json({ user: (await staffRows([updated]))[0] });
});

/**
 * PATCH /users/:id/receiving-leads  { on }  ->  { user }. LOCK-34 §4.8: the Sales Team Leader's switch per caller
 * (Admin, Controller and Founder here, as in the reference). Off stops new buyers being assigned to this person.
 */
usersRouter.patch('/users/:id/receiving-leads', canAddStaff, async (req, res) => {
  const { on } = z.object({ on: z.boolean() }).parse(req.body);
  const user = await findStaffMember(req.params.id);
  if (user.role !== 'SALES') throw invalidField('on', 'Only Sales staff receive leads');
  const updated = await UserModel.findByIdAndUpdate(
    user._id,
    { receivingLeads: on },
    { returnDocument: 'after' },
  );
  if (!updated) throw notFound('Staff member not found.');
  await writeAudit(req, {
    action: 'user.receiving_leads',
    entityType: 'User',
    entityId: user.id,
    before: { receivingLeads: user.receivingLeads },
    after: { receivingLeads: on },
  });
  res.json({ user: (await staffRows([updated]))[0] });
});

/**
 * POST /users/:id/reset-password  ->  { temporaryPassword }.
 * For someone who forgot their password. Also unlocks the account and signs them out everywhere.
 */
usersRouter.post('/users/:id/reset-password', canManageAccounts, async (req, res) => {
  const actor = currentUserOf(req);
  const user = await findStaffMember(req.params.id);

  assertMayManage(actor.role, user.role);
  if (user.id === actor.id) throw forbidden('Use "Change password" for your own account.');

  const temporaryPassword = generateTemporaryPassword();
  await UserModel.updateOne(
    { _id: user._id },
    {
      passwordHash: await hashPassword(temporaryPassword),
      mustChangePassword: true,
      failedLoginCount: 0,
      $unset: { lockedUntil: '' },
    },
  );
  await SessionModel.deleteMany({ userId: user._id });

  await writeAudit(req, {
    action: 'user.reset_password',
    entityType: 'User',
    entityId: user.id,
  });
  res.json({ temporaryPassword });
});
