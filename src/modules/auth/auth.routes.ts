import { Router } from 'express';
import { z } from 'zod';
import { UserModel } from '../../models/index.js';
import { HttpError, forbidden, unauthenticated } from '../../shared/errors.js';
import { fakePasswordCheck, isPasswordCorrect } from './password.js';
import { requireAuth } from './requireAuth.js';
import { endSession, startSession } from './session.js';

export const authRouter: Router = Router();

const MAX_WRONG_PASSWORDS = 5;
const LOCK_MINUTES = 15;

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
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    throw new HttpError(
      429,
      'ACCOUNT_LOCKED',
      `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    );
  }

  if (!(await isPasswordCorrect(user.passwordHash, password))) {
    // $inc is atomic, so two quick wrong guesses are both counted.
    const updated = await UserModel.findByIdAndUpdate(
      user._id,
      { $inc: { failedLoginCount: 1 } },
      { new: true },
    );
    if (updated && updated.failedLoginCount >= MAX_WRONG_PASSWORDS) {
      const lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
      await UserModel.updateOne({ _id: user._id }, { failedLoginCount: 0, lockedUntil });
    }
    throw wrongLogin();
  }

  // Say "turned off" only after the password was right, so it is not shown to strangers.
  if (!user.active) throw forbidden('This account is turned off. Please contact an administrator.');

  await UserModel.updateOne(
    { _id: user._id },
    { failedLoginCount: 0, $unset: { lockedUntil: '' } },
  );
  await startSession(req, res, user._id);
  res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

/** POST /auth/logout  ->  204. Works even if the session is already gone. */
authRouter.post('/auth/logout', async (req, res) => {
  await endSession(req, res);
  res.status(204).end();
});

/** GET /me  ->  { user }. The admin app calls this on start to find out who is signed in. */
authRouter.get('/me', requireAuth, (req, res) => {
  if (!req.user) throw unauthenticated(); // requireAuth always sets it; this keeps TypeScript honest
  res.json({ user: req.user });
});
