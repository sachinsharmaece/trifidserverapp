import { Router } from 'express';
import type { Types } from 'mongoose';
import { z } from 'zod';
import { SessionModel, UserModel } from '../../models/index.js';
import { HttpError, badRequest, forbidden, unauthenticated } from '../../shared/errors.js';
import { toCurrentUser } from './currentUser.js';
import {
  fakePasswordCheck,
  hashPassword,
  isPasswordCorrect,
  newPasswordSchema,
} from './password.js';
import { currentUserOf, requireAuth, requireSignedIn } from './requireAuth.js';
import { endSession, startSession } from './session.js';
import { recordStepUp } from './stepUp.js';

export const authRouter: Router = Router();

const MAX_WRONG_PASSWORDS = 5;
const LOCK_MINUTES = 15;

/** Throws 429 while the account is locked after too many wrong passwords. */
function refuseIfLocked(user: { lockedUntil?: Date | null | undefined }): void {
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    throw new HttpError(
      429,
      'ACCOUNT_LOCKED',
      `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    );
  }
}

/** Counts one wrong password; the fifth in a row locks the account. Used by sign-in and by step-up. */
async function countWrongPassword(userId: Types.ObjectId): Promise<void> {
  // $inc is atomic, so two quick wrong guesses are both counted.
  const updated = await UserModel.findByIdAndUpdate(
    userId,
    { $inc: { failedLoginCount: 1 } },
    { returnDocument: 'after' },
  );
  if (updated && updated.failedLoginCount >= MAX_WRONG_PASSWORDS) {
    const lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
    await UserModel.updateOne({ _id: userId }, { failedLoginCount: 0, lockedUntil });
  }
}

const loginBody = z.object({
  email: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(128),
});

/** POST /auth/login  { email, password }  ->  { user } and the session cookie. */
authRouter.post('/auth/login', async (req, res) => {
  const { email, password } = loginBody.parse(req.body);
  // Same message for "no such email" and "wrong password", so nobody can find out who has an account.
  const wrongLogin = () =>
    new HttpError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');

  const user = await UserModel.findOne({ email }).select('+passwordHash');
  if (!user) {
    await fakePasswordCheck(password);
    throw wrongLogin();
  }

  // Locked after too many wrong passwords: do not even check the password until the lock ends.
  refuseIfLocked(user);

  if (!(await isPasswordCorrect(user.passwordHash, password))) {
    await countWrongPassword(user._id);
    throw wrongLogin();
  }

  // Say "turned off" only after the password was right, so it is not shown to strangers.
  if (!user.active) throw forbidden('This account is turned off. Please contact an administrator.');

  await UserModel.updateOne(
    { _id: user._id },
    { failedLoginCount: 0, $unset: { lockedUntil: '' } },
  );
  await startSession(req, res, user._id);
  res.json({ user: toCurrentUser(user) });
});

/** POST /auth/logout  ->  204. Works even if the session is already gone. */
authRouter.post('/auth/logout', async (req, res) => {
  await endSession(req, res);
  res.status(204).end();
});

/** GET /me  ->  { user }. The admin app calls this on start to find out who is signed in. */
authRouter.get('/me', requireSignedIn, (req, res) => {
  res.json({ user: currentUserOf(req) });
});

const stepUpBody = z.object({ password: z.string().min(1).max(128) });

/**
 * POST /auth/step-up  { password }  ->  204.
 * The person types their password again before a sensitive action (SRS-AUTH-05). For the next 5 minutes this
 * session may do such actions (the routes behind `requireStepUp`). A wrong password counts toward the same
 * lock as sign-in, so a stolen session cannot be used to guess the password.
 */
authRouter.post('/auth/step-up', requireAuth, async (req, res) => {
  const me = currentUserOf(req);
  const { password } = stepUpBody.parse(req.body);

  const user = await UserModel.findById(me.id).select('+passwordHash');
  if (!user) throw unauthenticated();
  refuseIfLocked(user);

  if (!(await isPasswordCorrect(user.passwordHash, password))) {
    await countWrongPassword(user._id);
    // Not 401: that code means "your session ended" and would sign the person out of the app.
    throw new HttpError(400, 'WRONG_PASSWORD', 'The password is not correct.');
  }

  await UserModel.updateOne({ _id: user._id }, { failedLoginCount: 0 });
  await recordStepUp(req);
  res.status(204).end();
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: newPasswordSchema,
});

/**
 * POST /auth/password  { currentPassword, newPassword }  ->  { user } and a fresh cookie.
 * Used by people on a temporary password (forced at first sign-in) and by anyone who wants a new one.
 * Every other session of this person is ended, so a stolen old session stops working.
 */
authRouter.post('/auth/password', requireSignedIn, async (req, res) => {
  const me = currentUserOf(req);
  const { currentPassword, newPassword } = changePasswordBody.parse(req.body);

  const user = await UserModel.findById(me.id).select('+passwordHash');
  if (!user || !(await isPasswordCorrect(user.passwordHash, currentPassword))) {
    // Not 401: that code means "your session ended" and would sign the person out of the app.
    throw new HttpError(400, 'WRONG_PASSWORD', 'The current password is not correct.');
  }
  if (newPassword === currentPassword) {
    throw badRequest('Choose a password that is different from the current one.');
  }

  await UserModel.updateOne(
    { _id: user._id },
    { passwordHash: await hashPassword(newPassword), mustChangePassword: false },
  );
  await SessionModel.deleteMany({ userId: user._id });
  await startSession(req, res, user._id);
  res.json({ user: { ...toCurrentUser(user), mustChangePassword: false } });
});
