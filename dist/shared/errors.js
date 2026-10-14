/**
 * The one error shape used everywhere in this API.
 * ARCHITECTURE.md §7.1 — never a stack trace, a raw Mongoose error, or a secret reaches a client.
 */
const HTTP_STATUS_BY_CODE = {
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
    MARGIN_CELL_MISSING: 422,
    CHAIN_STAGE_GUARD_FAILED: 409,
    PO_ALREADY_EXISTS: 409,
    DOCUMENT_ALREADY_BILLED: 409,
    INSPECTION_IMMUTABLE: 409,
    REFUND_DESTINATION_MISMATCH: 409,
    DAY_CLOSE_OUT_OF_BALANCE: 409,
    ORDER_NOT_DISPATCHABLE: 409,
    ORDER_NOT_YET_DELIVERABLE: 409,
    COMPLAINT_WINDOW_CLOSED: 409,
    MFA_ENROLMENT_REQUIRED: 403,
    OTP_CONFIRMATION_REQUIRED: 409,
    ENQUIRY_NOT_OPEN: 409,
    DUPLICATE_LISTING: 409,
    INTERNAL_ERROR: 500,
};
/**
 * Throw this from anywhere in the request path. The error handler middleware
 * turns it into the ARCHITECTURE.md §7.1 envelope and nothing else.
 */
export class AppError extends Error {
    code;
    messageEn;
    messageHi;
    field;
    retryable;
    status;
    meta;
    constructor(options) {
        super(options.messageEn);
        this.name = 'AppError';
        this.code = options.code;
        this.messageEn = options.messageEn;
        this.messageHi = options.messageHi;
        this.field = options.field;
        this.retryable = options.retryable ?? false;
        this.status = options.status ?? HTTP_STATUS_BY_CODE[options.code];
        this.meta = options.meta;
    }
}
// Staff-facing errors are English only (ARCHITECTURE.md §7.1) — no message_hi is set.
export function staffError(code, messageEn, extra) {
    return new AppError({ code, messageEn, field: extra?.field, retryable: extra?.retryable });
}
// Counterparty-facing errors carry both languages (BR-296).
export function counterpartyError(code, messageEn, messageHi, extra) {
    return new AppError({
        code,
        messageEn,
        messageHi,
        field: extra?.field,
        retryable: extra?.retryable,
    });
}
