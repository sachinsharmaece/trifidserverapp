import { SessionModel } from '../../models/index.js';
import { HttpError, unauthenticated } from '../../shared/errors.js';
import { findSession } from './session.js';
/**
 * Sensitive actions (like changing the margin matrix) need the person to type their password again.
 * After they do, the session may do such actions for this many minutes (SRS-AUTH-05).
 */
export const STEP_UP_MINUTES = 5;
/**
 * Put this in front of a sensitive route, after requireAuth and the role check:
 *   router.post('/margin-cells', canEditMasters, requireStepUp, handler);
 * Without a recent password check the answer is 428 STEP_UP_REQUIRED. The person confirms with POST /auth/step-up.
 */
export async function requireStepUp(req, _res, next) {
    const session = await findSession(req);
    const confirmedAt = session?.stepUpAt?.getTime() ?? 0;
    if (Date.now() - confirmedAt > STEP_UP_MINUTES * 60_000) {
        throw new HttpError(428, 'STEP_UP_REQUIRED', 'Please confirm your password to continue.');
    }
    next();
}
/** Remembers on this session that the password was just confirmed. */
export async function recordStepUp(req) {
    const session = await findSession(req);
    if (!session)
        throw unauthenticated();
    await SessionModel.updateOne({ _id: session._id }, { stepUpAt: new Date() });
}
//# sourceMappingURL=stepUp.js.map