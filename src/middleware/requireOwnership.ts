import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../shared/errors.js';

interface Owner {
  counterpartyId?: string | null;
  employeeId?: string | null;
}

type OwnerLookup = (req: Request) => Promise<Owner | null>;

/**
 * CH §17.4 / ARCHITECTURE.md §6.2 layer 2 — does this record belong to this
 * counterparty? An ID from the client (here, a route param such as a file
 * id) is never trusted by itself: `lookup` reads the record's real owner
 * from the database and only that value is compared against the token's own
 * identity.
 *
 * A staff caller with the matching read permission is expected to have
 * already passed `requirePermission` on the same route and is let through
 * here — ownership only restricts counterparty callers to their own record.
 *
 * `NOT_VISIBLE` is used instead of a distinguishable 403 so a client cannot
 * tell "exists but not yours" from "does not exist" (API_CONTRACT.md §10).
 */
export function requireOwnership(lookup: OwnerLookup) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError({ code: 'NOT_VISIBLE', messageEn: 'Not found.' });
    }
    if (auth.actorType === 'staff') {
      next();
      return;
    }
    const owner = await lookup(req);
    if (!owner || owner.counterpartyId !== auth.counterpartyId) {
      throw new AppError({ code: 'NOT_VISIBLE', messageEn: 'Not found.' });
    }
    next();
  };
}
