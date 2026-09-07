import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

/**
 * ARCHITECTURE.md §M1 validation scope — every request body validated at the
 * boundary, unknown fields rejected, not ignored. Schemas passed in must use
 * `z.object({...}).strict()` so an unexpected field fails validation instead
 * of being silently dropped.
 *
 * Thrown ZodErrors are caught by errorHandler.ts and turned into a
 * VALIDATION_FAILED response.
 */
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.body = schema.parse(req.body);
    next();
  };
}

// Express 5 makes `req.query` a getter-only property, so the parsed value is
// attached here instead of reassigning it — reassigning throws
// "Cannot set property query... which has only a getter" at request time.
declare module 'express-serve-static-core' {
  interface Request {
    validatedQuery?: unknown;
  }
}

export function validateQuery<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.validatedQuery = schema.parse(req.query);
    next();
  };
}
