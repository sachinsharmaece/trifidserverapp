import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

// ARCHITECTURE.md §7.1 — one error shape everywhere. Never leaks a stack
// trace, a raw Mongoose error, or a secret to the client.
export const errorHandler: ErrorRequestHandler = (error, request, response, next) => {
  void next;
  const correlationId: string = request.correlationId ?? 'unknown';

  if (error instanceof AppError) {
    if (error.status >= 500) {
      logger.error({ msg: error.message, code: error.code, correlationId, stack: error.stack });
    }
    response.status(error.status).json({
      error: {
        code: error.code,
        message_en: error.messageEn,
        message_hi: error.messageHi,
        field: error.field,
        retryable: error.retryable,
        correlationId,
      },
    });
    return;
  }

  if (error instanceof ZodError) {
    const firstIssue = error.issues[0];
    response.status(400).json({
      error: {
        code: 'VALIDATION_FAILED',
        message_en: firstIssue?.message ?? 'The request could not be validated.',
        field: firstIssue?.path.join('.'),
        retryable: false,
        correlationId,
      },
    });
    return;
  }

  logger.error({ msg: 'Unhandled error', correlationId, err: error });
  response.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message_en: 'Something went wrong on our end. Please try again.',
      retryable: true,
      correlationId,
    },
  });
};
