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
