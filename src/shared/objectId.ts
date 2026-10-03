import { Types } from 'mongoose';
import { AppError } from './errors.js';

/**
 * B-56/57/58 — a malformed id (a human-readable number like "SO-26-0001", or
 * any other non-ObjectId string) passed straight to Mongoose throws an
 * uncaught CastError, which error-handler.ts's catch-all turns into a bare
 * 500 instead of a clean 400. Call this before the first `findById`/
 * `findOne({ _id })` on any id taken from a request.
 */
export function assertValidObjectId(id: string, field: string): void {
  if (!Types.ObjectId.isValid(id)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: `${field} is not a valid id.`,
      field,
    });
  }
}
