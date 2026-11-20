import type { NextFunction, Request, Response } from 'express';
import { forbidden } from '../../shared/errors.js';
import type { Role } from '../../shared/enums.js';

/**
 * Allows only the listed roles. Always put it AFTER requireAuth:
 *   router.use('/users', requireAuth, requireRole('FOUNDER', 'ADMIN'));
 */
export function requireRole(...allowed: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user || !allowed.includes(req.user.role)) throw forbidden();
    next();
  };
}
