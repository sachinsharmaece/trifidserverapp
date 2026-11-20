import type { NextFunction, Request, Response } from 'express';
import { SessionModel, UserModel } from '../../models/index.js';
import { unauthenticated } from '../../shared/errors.js';
import { findSession } from './session.js';

/**
 * Put this in front of any route that needs a signed-in user:
 *   router.get('/orders', requireAuth, listOrders);
 * It fills `req.user`. Not signed in, or account turned off: 401.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const session = await findSession(req);
  if (!session) throw unauthenticated();

  const user = await UserModel.findById(session.userId);
  if (!user?.active) {
    await SessionModel.deleteOne({ _id: session._id });
    throw unauthenticated();
  }

  req.user = { id: user.id, email: user.email, name: user.name, role: user.role };
  next();
}
