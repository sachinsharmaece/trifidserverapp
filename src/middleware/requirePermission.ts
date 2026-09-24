import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../shared/errors.js';
import type { PermissionKey } from '../config/permissions.js';

/**
 * TD-007 — checks a permission string (`module:action`), never a role name.
 * Must run after `authenticate`.
 */
export function requirePermission(permission: PermissionKey) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth || req.auth.actorType !== 'staff') {
      throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Staff access required.' });
    }
    if (!req.auth.permissions.includes(permission)) {
      throw new AppError({
        code: 'PERMISSION_DENIED',
        messageEn: `You do not have the "${permission}" permission.`,
      });
    }
    next();
  };
}

/**
 * Route-level OR gate — the caller needs at least one of these permissions.
 * Used only where a route genuinely serves more than one desk (the enquiry
 * create/edit/drop endpoints, which a Sales or a Purchase caller may both
 * reach, each for their own side); the finer, party-specific check still
 * happens inside the service, the same way `requireActiveBuyer`/
 * `requireActiveSeller` already refuse a mismatched counterparty kind.
 */
export function requireAnyPermission(...permissions: PermissionKey[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth || req.auth.actorType !== 'staff') {
      throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Staff access required.' });
    }
    if (!permissions.some((p) => req.auth!.permissions.includes(p))) {
      throw new AppError({
        code: 'PERMISSION_DENIED',
        messageEn: `You do not have any of the required permissions.`,
      });
    }
    next();
  };
}
