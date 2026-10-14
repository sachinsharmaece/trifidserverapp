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
export function validateBody(schema) {
    return (req, _res, next) => {
        if (!isProduction && env.disableInputValidation) {
            next();
            return;
        }
        req.body = schema.parse(req.body);
        next();
    };
}
export function validateQuery(schema) {
    return (req, _res, next) => {
        if (!isProduction && env.disableInputValidation) {
            req.validatedQuery = req.query;
            next();
            return;
        }
        req.validatedQuery = schema.parse(req.query);
        next();
    };
}
