/**
 * Structured JSON logging. ARCHITECTURE.md §M1 backend scope — redacts mobile
 * numbers, bank account numbers and UTRs before they reach a log line.
 *
 * pino's `redact` option only masks known key paths, but mobiles/UTRs also turn
 * up inside free-text fields (narrations, raw payment text), so we additionally
 * scrub matching patterns out of every log line's serialized string fields.
 */
import pino from 'pino';
import { env } from '../config/env.js';

const MOBILE_PATTERN = /\b\d{10}\b/g;
const UTR_PATTERN = /\b[A-Z0-9]{12,22}\b/g;
const ACCOUNT_NUMBER_PATTERN = /\b\d{9,18}\b/g;

function redactText(value: string): string {
  return value
    .replace(MOBILE_PATTERN, '[REDACTED_MOBILE]')
    .replace(UTR_PATTERN, '[REDACTED_UTR]')
    .replace(ACCOUNT_NUMBER_PATTERN, '[REDACTED_ACCOUNT]');
}

function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactDeep(item, depth + 1);
    }
    return result;
  }
  return value;
}

export const logger = pino({
  level: env.logLevel,
  // Error/message/stack are non-enumerable own properties on a plain Error,
  // so JSON.stringify(new Error('x')) is famously '{}' — pino's standard err
  // serializer reads them explicitly instead of relying on enumeration.
  serializers: { err: pino.stdSerializers.err },
  redact: {
    paths: [
      'mobile',
      'req.body.mobile',
      'accountEncrypted',
      'accountNumber',
      'utr',
      'password',
      'codeHash',
      'passwordHash',
      'refreshTokenHash',
      'mfaSecret',
    ],
    censor: '[REDACTED]',
  },
  formatters: {
    log(object) {
      // `err` has already gone through pino's own error serializer above,
      // which returns type/message/stack as non-enumerable properties for
      // pino's internal fast-path serialization — rebuilding it through
      // Object.entries() here would silently turn it into `{}`. It carries
      // no counterparty PII (mobile/account/UTR), so it is left untouched.
      const { err, ...rest } = object as Record<string, unknown>;
      const redacted = redactDeep(rest) as Record<string, unknown>;
      return err === undefined ? redacted : { ...redacted, err };
    },
  },
});
