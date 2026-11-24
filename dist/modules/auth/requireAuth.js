import { SessionModel, UserModel } from '../../models/index.js';
import { HttpError, unauthenticated } from '../../shared/errors.js';
import { toCurrentUser } from './currentUser.js';
import { findSession } from './session.js';
/** Finds who is signed in and puts them on `req.user`. Not signed in, or account turned off: 401. */
async function loadSignedInUser(req) {
    const session = await findSession(req);
    if (!session)
        throw unauthenticated();
    const user = await UserModel.findById(session.userId);
    if (!user?.active) {
        await SessionModel.deleteOne({ _id: session._id });
        throw unauthenticated();
    }
    req.user = toCurrentUser(user);
}
/**
 * Put this in front of any route that needs a signed-in user:
 *   router.get('/orders', requireAuth, listOrders);
 * A person who is still on a temporary password gets 403 PASSWORD_CHANGE_REQUIRED here.
 */
export async function requireAuth(req, _res, next) {
    await loadSignedInUser(req);
    if (req.user?.mustChangePassword) {
        throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must choose a new password before continuing.');
    }
    next();
}
/** Like `requireAuth`, but also lets a person on a temporary password through. Only /me and /auth/password use it. */
export async function requireSignedIn(req, _res, next) {
    await loadSignedInUser(req);
    next();
}
/** The signed-in user, inside a route that has `requireAuth` (or `requireSignedIn`) in front of it. */
export function currentUserOf(req) {
    if (!req.user)
        throw unauthenticated(); // cannot happen after requireAuth; keeps TypeScript honest
    return req.user;
}
//# sourceMappingURL=requireAuth.js.map