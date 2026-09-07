/**
 * The one error shape used everywhere in this API.
 * ARCHITECTURE.md §7.1 — never a stack trace, a raw Mongoose error, or a secret reaches a client.
 */

// Fixed list, API_CONTRACT.md §10, plus one developer addition below. Free
// text destroys every report built on top of it (CH §27.2).
//
// Developer addition — INVALID_CREDENTIALS: API_CONTRACT.md §10's fixed list
// was written with the counterparty flows in mind and has no code for "wrong
// staff email or password". This is a technical gap, not a business rule
// (ARCHITECTURE.md §8: "security requirements are technical... none of them
// creates or changes a business rule"), so it is added here rather than
// raised as a QR. Recorded in CHANGELOG.md.
export type ErrorCode =
  | 'OTP_INVALID'
  | 'OTP_EXPIRED'
  | 'LOCKED_OUT'
  | 'NEW_DEVICE'
  | 'SESSION_REPLACED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'ACCOUNT_BLACKLISTED'
  | 'PERMISSION_DENIED'
  | 'NOT_VISIBLE'
  | 'NOT_FOUND'
  | 'BELOW_MOQ'
  | 'INSURANCE_CHOICE_REQUIRED'
  | 'SHELF_LIFE_FLOOR'
  | 'PROVENANCE_DELIVERY_MISMATCH'
  | 'EXPIRY_REQUIRED'
  | 'BATCH_REQUIRED'
  | 'NO_AREA_SET'
  | 'EXCLUSION_CAP_REACHED'
  | 'DOUBLE_CONFIRM_REQUIRED'
  | 'PILE_ALREADY_DECIDED'
  | 'POOL_CLOSED'
  | 'SO_NOT_PAID_IN_FULL'
  | 'MARG_VALUE_MISMATCH'
  | 'BANK_CHANGE_PENDING'
  | 'BUILDER_CANNOT_RELEASE'
  | 'REAUTH_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RATE_LIMITED'
  | 'VALIDATION_FAILED'
  | 'INTERNAL_ERROR';

const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  OTP_INVALID: 401,
  OTP_EXPIRED: 410,
  LOCKED_OUT: 423,
  NEW_DEVICE: 428,
  SESSION_REPLACED: 401,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_NOT_ACTIVE: 403,
  ACCOUNT_BLACKLISTED: 403,
  PERMISSION_DENIED: 403,
  NOT_VISIBLE: 404,
  NOT_FOUND: 404,
  BELOW_MOQ: 422,
  INSURANCE_CHOICE_REQUIRED: 422,
  SHELF_LIFE_FLOOR: 422,
  PROVENANCE_DELIVERY_MISMATCH: 422,
  EXPIRY_REQUIRED: 422,
  BATCH_REQUIRED: 422,
  NO_AREA_SET: 403,
  EXCLUSION_CAP_REACHED: 409,
  DOUBLE_CONFIRM_REQUIRED: 409,
  PILE_ALREADY_DECIDED: 409,
  POOL_CLOSED: 409,
  SO_NOT_PAID_IN_FULL: 409,
  MARG_VALUE_MISMATCH: 409,
  BANK_CHANGE_PENDING: 409,
  BUILDER_CANNOT_RELEASE: 403,
  REAUTH_REQUIRED: 401,
  IDEMPOTENCY_CONFLICT: 409,
  RATE_LIMITED: 429,
  VALIDATION_FAILED: 400,
  INTERNAL_ERROR: 500,
};

interface AppErrorOptions {
  code: ErrorCode;
  messageEn: string;
  messageHi?: string;
  field?: string;
  retryable?: boolean;
  status?: number;
}

/**
 * Throw this from anywhere in the request path. The error handler middleware
 * turns it into the ARCHITECTURE.md §7.1 envelope and nothing else.
 */
export class AppError extends Error {
  code: ErrorCode;
  messageEn: string;
  messageHi?: string;
  field?: string;
  retryable: boolean;
  status: number;

  constructor(options: AppErrorOptions) {
    super(options.messageEn);
    this.name = 'AppError';
    this.code = options.code;
    this.messageEn = options.messageEn;
    this.messageHi = options.messageHi;
    this.field = options.field;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? HTTP_STATUS_BY_CODE[options.code];
  }
}

// Staff-facing errors are English only (ARCHITECTURE.md §7.1) — no message_hi is set.
export function staffError(
  code: ErrorCode,
  messageEn: string,
  extra?: { field?: string; retryable?: boolean },
): AppError {
  return new AppError({ code, messageEn, field: extra?.field, retryable: extra?.retryable });
}

// Counterparty-facing errors carry both languages (BR-296).
export function counterpartyError(
  code: ErrorCode,
  messageEn: string,
  messageHi: string,
  extra?: { field?: string; retryable?: boolean },
): AppError {
  return new AppError({
    code,
    messageEn,
    messageHi,
    field: extra?.field,
    retryable: extra?.retryable,
  });
}
