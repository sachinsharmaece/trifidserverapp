import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Every failed response has the same JSON body (the admin app parses exactly this):
 *   { "error": { "code": "NOT_FOUND", "message": "...", "details": ..., "requestId": "..." } }
 * `code` is for programs (`if (code === 'UNAUTHENTICATED')`), `message` is safe to show to a person.
 */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

/** Throw this from any route/service to return a specific status and code to the client. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Small helpers so route code reads well: `throw notFound('Order not found')`.
export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'BAD_REQUEST', message, details);
export const unauthenticated = (message = 'Please sign in.') =>
  new HttpError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to do this.') =>
  new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found.') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message: string, code = 'CONFLICT') => new HttpError(409, code, message);
/** One field is wrong for a business reason (like boxes under the minimum). Same shape as a Zod error, so the form shows it on the field. */
export const invalidField = (path: string, message: string) =>
  new HttpError(422, 'VALIDATION_FAILED', message, [{ path, message }]);

const CODE_FOR_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'VALIDATION_FAILED',
  429: 'TOO_MANY_REQUESTS',
};

/** Pulls a 4xx/5xx status off errors thrown by libraries (e.g. body-parser). */
function statusFromError(err: unknown): number {
  if (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof err.status === 'number' &&
    err.status >= 400 &&
    err.status < 600
  ) {
    return err.status;
  }
  return 500;
}

/** body-parser marks a broken JSON body with type 'entity.parse.failed'. */
function isMalformedJson(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.parse.failed'
  );
}

function send(
  res: Response,
  req: Request,
  status: number,
  error: Omit<ErrorBody['error'], 'requestId'>,
): void {
  const body: ErrorBody = { error: { ...error, requestId: req.requestId } };
  res.status(status).json(body);
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(notFound(`Route not found: ${req.method} ${req.path}`));
}

// Express 5 forwards rejected async handlers here, so route code can simply
// `throw` without try/catch boilerplate.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof z.ZodError) {
    send(res, req, 422, {
      code: 'VALIDATION_FAILED',
      message: 'Some fields are missing or invalid.',
      details: err.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
    return;
  }

  if (err instanceof HttpError) {
    if (err.status >= 500)
      logger.error({ msg: 'Request failed', requestId: req.requestId, error: err });
    send(res, req, err.status, {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
    return;
  }

  if (isMalformedJson(err)) {
    send(res, req, 400, { code: 'BAD_JSON', message: 'The request body is not valid JSON.' });
    return;
  }

  const status = statusFromError(err);
  if (status >= 500) {
    logger.error({ msg: 'Unhandled error', requestId: req.requestId, error: err });
    // Never leak internals on 5xx in production.
    const message =
      !env.isProduction && err instanceof Error ? err.message : 'Something went wrong on our side.';
    send(res, req, status, { code: 'INTERNAL', message });
    return;
  }

  send(res, req, status, {
    code: CODE_FOR_STATUS[status] ?? `HTTP_${status}`,
    message: err instanceof Error ? err.message : 'The request could not be processed.',
  });
}
