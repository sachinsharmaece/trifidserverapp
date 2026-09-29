import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { env, isProduction } from '../config/env.js';

/**
 * ARCHITECTURE.md §M1 validation scope — every request body validated at the
 * boundary, unknown fields rejected, not ignored. Schemas passed in must use
 * `z.object({...}).strict()` so an unexpected field fails validation instead
 * of being silently dropped.
 *
 * Thrown ZodErrors are caught by errorHandler.ts and turned into a
 * VALIDATION_FAILED response.
 *
 * DISABLE_INPUT_VALIDATION (env.disableInputValidation) skips the parse step
 * below so a developer can send hand-crafted payloads that would otherwise be
 * rejected. It is never honoured when isProduction is true, whatever the
 * variable is set to. Skipping parse() also skips Zod's coercion and
 * `.strict()` unknown-field stripping/rejection, so req.body/validatedQuery
 * are the raw, untyped request values while this flag is on.
 */
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!isProduction && env.disableInputValidation) {
      next();
      return;
    }
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
    if (!isProduction && env.disableInputValidation) {
      req.validatedQuery = req.query;
      next();
      return;
    }
    req.validatedQuery = schema.parse(req.query);
    next();
  };
}
