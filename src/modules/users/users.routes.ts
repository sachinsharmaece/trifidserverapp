import { Router, type Request } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { AuditEventModel, SessionModel, UserModel } from '../../models/index.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { ROLES, type Role } from '../../shared/enums.js';
import { generateTemporaryPassword, hashPassword } from '../auth/password.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';

export const usersRouter: Router = Router();

// Staff accounts are managed by Founder and Admin only.
usersRouter.use('/users', requireAuth, requireRole('FOUNDER', 'ADMIN'));

const createBody = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(100),
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address.')),
  role: z.enum(ROLES),
});

const updateBody = z
  .object({
    name: z.string().trim().min(1, 'Enter a name.').max(100),
    role: z.enum(ROLES),
    active: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to change.');

/** What the admin app may see about a staff member. Never the password hash. */
function toStaffMember(user: {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    active: user.active,
    mustChangePassword: user.mustChangePassword,
  };
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

/** The email column has a unique index; MongoDB answers with error code 11000 when it is taken. */
function failIfEmailTaken(error: unknown): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
    throw conflict('A staff member with this email already exists.', 'EMAIL_TAKEN');
  }
  throw error;
}

/** Keeps only the fields whose value differs, for the audit log. */
function onlyChanged(before: Record<string, unknown>, after: Record<string, unknown>) {
  const changed = Object.keys(after).filter((key) => before[key] !== after[key]);
  return {
    before: Object.fromEntries(changed.map((key) => [key, before[key]])),
    after: Object.fromEntries(changed.map((key) => [key, after[key]])),
  };
}

/** Writes one line to the append-only audit log: who did what to which account. */
async function audit(
  req: Request,
  action: string,
  targetId: string,
  changes?: { before: Record<string, unknown>; after: Record<string, unknown> },
): Promise<void> {
  const actor = currentUserOf(req);
  await AuditEventModel.create({
    actorId: actor.id,
    actorRole: actor.role,
    entityType: 'User',
    entityId: targetId,
    action,
    ...changes,
    requestId: req.requestId,
    ip: req.ip ?? '',
  });
}

/** GET /users  ->  { users }. A company has a handful of staff, so there is no paging. */
usersRouter.get('/users', async (_req, res) => {
  const users = await UserModel.find().sort({ name: 1 });
  res.json({ users: users.map(toStaffMember) });
});

/**
 * POST /users  { name, email, role }  ->  201 { user, temporaryPassword }.
 * The server makes up the temporary password and shows it ONCE here; it is stored only as a hash.
 * The new person must replace it at their first sign-in.
 */
usersRouter.post('/users', async (req, res) => {
  const actor = currentUserOf(req);
  const body = createBody.parse(req.body);
  assertMayManage(actor.role, body.role);

  const temporaryPassword = generateTemporaryPassword();
  const user = await UserModel.create({
    name: body.name,
    email: body.email,
    role: body.role,
    passwordHash: await hashPassword(temporaryPassword),
    mustChangePassword: true,
    createdBy: actor.id,
  }).catch(failIfEmailTaken);

  await audit(req, 'user.create', user.id, {
    before: {},
    after: { email: user.email, role: user.role },
  });
  res.status(201).json({ user: toStaffMember(user), temporaryPassword });
});

/**
 * PATCH /users/:id  { name?, role?, active? }  ->  { user }.
 * Changing the role or turning the account off ends that person's sessions at once (SRS-AUTH-06).
 */
usersRouter.patch('/users/:id', async (req, res) => {
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
    res.json({ user: toStaffMember(user) });
    return;
  }

  const updated = await UserModel.findByIdAndUpdate(user._id, after, { new: true });
  if (!updated) throw notFound('Staff member not found.');

  if (after.role !== undefined || after.active === false) {
    await SessionModel.deleteMany({ userId: user._id });
  }
  await audit(req, 'user.update', user.id, { before, after });
  res.json({ user: toStaffMember(updated) });
});

/**
 * POST /users/:id/reset-password  ->  { temporaryPassword }.
 * For someone who forgot their password. Also unlocks the account and signs them out everywhere.
 */
usersRouter.post('/users/:id/reset-password', async (req, res) => {
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

  await audit(req, 'user.reset_password', user.id);
  res.json({ temporaryPassword });
});
