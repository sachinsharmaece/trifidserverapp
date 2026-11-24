import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { SessionModel, UserModel } from '../../models/index.js';
import { onlyChanged, writeAudit } from '../../shared/audit.js';
import { forbidden, notFound } from '../../shared/errors.js';
import { failIfDuplicate } from '../../shared/mongo.js';
import { ROLES } from '../../shared/enums.js';
import { generateTemporaryPassword, hashPassword } from '../auth/password.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
export const usersRouter = Router();
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
function toStaffMember(user) {
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
async function findStaffMember(id) {
    if (!isValidObjectId(id))
        throw notFound('Staff member not found.');
    const user = await UserModel.findById(id);
    if (!user)
        throw notFound('Staff member not found.');
    return user;
}
/** Only a Founder may create, edit or reset a Founder account; otherwise an Admin could make themselves one. */
function assertMayManage(actorRole, targetRole) {
    if (targetRole === 'FOUNDER' && actorRole !== 'FOUNDER') {
        throw forbidden('Only a Founder can manage Founder accounts.');
    }
}
const EMAIL_TAKEN = 'A staff member with this email already exists.';
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
    }).catch(failIfDuplicate(EMAIL_TAKEN, 'EMAIL_TAKEN'));
    await writeAudit(req, {
        action: 'user.create',
        entityType: 'User',
        entityId: user.id,
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
    if (changes.role)
        assertMayManage(actor.role, changes.role);
    if (user.id === actor.id && (changes.role !== undefined || changes.active !== undefined)) {
        throw forbidden('You cannot change your own role or turn off your own account.');
    }
    const { before, after } = onlyChanged({ name: user.name, role: user.role, active: user.active }, {
        name: changes.name ?? user.name,
        role: changes.role ?? user.role,
        active: changes.active ?? user.active,
    });
    if (Object.keys(after).length === 0) {
        res.json({ user: toStaffMember(user) });
        return;
    }
    const updated = await UserModel.findByIdAndUpdate(user._id, after, { returnDocument: 'after' });
    if (!updated)
        throw notFound('Staff member not found.');
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
    if (user.id === actor.id)
        throw forbidden('Use "Change password" for your own account.');
    const temporaryPassword = generateTemporaryPassword();
    await UserModel.updateOne({ _id: user._id }, {
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: true,
        failedLoginCount: 0,
        $unset: { lockedUntil: '' },
    });
    await SessionModel.deleteMany({ userId: user._id });
    await writeAudit(req, {
        action: 'user.reset_password',
        entityType: 'User',
        entityId: user.id,
    });
    res.json({ temporaryPassword });
});
//# sourceMappingURL=users.routes.js.map