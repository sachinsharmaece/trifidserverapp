import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { IdempotencyKey } from '../models/IdempotencyKey.js';
import { AppError } from '../shared/errors.js';

/**
 * API_CONTRACT.md §1 / MASTER_PLAN.md §M4 item 10 — required on every POST
 * that creates money or moves a chain stage. Replay with the same key and
 * the same request body returns the original response instead of repeating
 * the side effect (posting a second bank credit, raising a second PO, and
 * so on) for 24 hours (the model's TTL index). The same key with a
 * *different* body is refused outright, rather than silently ignoring the
 * difference.
 */
export function requireIdempotencyKey() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.header('idempotency-key');
    if (!key) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        messageEn: 'The Idempotency-Key header is required on this endpoint.',
        field: 'Idempotency-Key',
      });
    }
    const route = req.originalUrl.split('?')[0]!;
    const requestHash = createHash('sha256')
      .update(JSON.stringify(req.body ?? {}))
      .digest('hex');

    const existing = await IdempotencyKey.findOne({ key, route });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new AppError({
          code: 'IDEMPOTENCY_CONFLICT',
          messageEn: 'This Idempotency-Key was already used with a different request body.',
        });
      }
      res.status(existing.responseStatus).json(existing.responseBody as object);
      return;
    }

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      IdempotencyKey.create({
        key,
        route,
        requestHash,
        responseStatus: res.statusCode,
        responseBody: body,
      }).catch(() => {
        // A concurrent request with the same key raced this insert (unique
        // index on {key, route}) — the response has already been sent
        // either way, so there is nothing useful to do with the error here.
      });
      return originalJson(body);
    }) as typeof res.json;

    next();
  };
}
