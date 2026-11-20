import { conflict } from './errors.js';

/** MongoDB answers a unique-index violation (for example a second "Bayer") with error code 11000. */
function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

/**
 * Turns "that name is already taken" from the database into a friendly 409 answer:
 *   await Model.create(data).catch(failIfDuplicate('A manufacturer with this name already exists.', 'NAME_TAKEN'));
 * Any other error is passed on unchanged.
 */
export function failIfDuplicate(message: string, code: string) {
  return (error: unknown): never => {
    if (isDuplicateKeyError(error)) throw conflict(message, code);
    throw error;
  };
}

/** Makes user text safe to put inside a regular expression (so "a+b" searches for a+b). */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
