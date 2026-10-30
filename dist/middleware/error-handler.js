import { ZodError } from 'zod';
import { AppError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
// Zod's own wording ("Too small: expected string to have >=1 characters")
// reached staff screens wherever a schema field had no message of its own
// (B-49 fixed those one field at a time). A schema's own message is kept as
// is; only Zod's built-in defaults are swapped for plain language here.
const ZOD_DEFAULT_MESSAGE = /^(Invalid input|Too small|Too big|Invalid option|Unrecognized key|Invalid string|Invalid format|Invalid element|Invalid key|Invalid union|Expected )/;
function plainIssueMessage(issue) {
    if (!ZOD_DEFAULT_MESSAGE.test(issue.message))
        return issue.message;
    const detail = issue;
    switch (issue.code) {
        case 'invalid_type':
            return detail.input === undefined || detail.input === null
                ? 'This field is required.'
                : 'This value is not in the right form.';
        case 'too_small':
            if (issue.origin === 'string') {
                return Number(detail.minimum) <= 1
                    ? 'This field is required.'
                    : `Enter at least ${String(detail.minimum)} characters.`;
            }
            if (issue.origin === 'array')
                return `Add at least ${String(detail.minimum)}.`;
            return `Must be at least ${String(detail.minimum)}.`;
        case 'too_big':
            if (issue.origin === 'string')
                return `Enter at most ${String(detail.maximum)} characters.`;
            if (issue.origin === 'array')
                return `Add at most ${String(detail.maximum)}.`;
            return `Must be at most ${String(detail.maximum)}.`;
        case 'invalid_value':
            return 'Pick one of the listed options.';
        case 'unrecognized_keys':
            return 'This form sent a field the server does not accept.';
        default:
            return 'This value is not valid.';
    }
}
// ARCHITECTURE.md §7.1 — one error shape everywhere. Never leaks a stack
// trace, a raw Mongoose error, or a secret to the client.
export const errorHandler = (error, request, response, next) => {
    void next;
    const correlationId = request.correlationId ?? 'unknown';
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
                ...(error.meta ? { meta: error.meta } : {}),
            },
        });
        return;
    }
    if (error instanceof ZodError) {
        const firstIssue = error.issues[0];
        response.status(400).json({
            error: {
                code: 'VALIDATION_FAILED',
                message_en: firstIssue
                    ? plainIssueMessage(firstIssue)
                    : 'The request could not be validated.',
                field: firstIssue?.path.join('.'),
                retryable: false,
                correlationId,
                fieldErrors: error.issues.map((issue) => ({
                    field: issue.path.join('.'),
                    message: plainIssueMessage(issue),
                })),
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
