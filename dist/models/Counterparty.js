import { Schema, model } from 'mongoose';
/**
 * ENT-01 `counterparty`. The firm. One GSTIN is one firm is one account
 * (`BR-240`). A firm may be both a buyer and a seller (`BR-092`).
 *
 * `licenceExpiry` is deliberately **not** on this schema — `DATA_MODEL.md`
 * ENT-01 marks it pending `QR-019`, and M3's interim position is to capture
 * only what is already confirmed (licence *number*, not an expiry date).
 */
const counterpartySchema = new Schema({
    gstin: { type: String, unique: true, sparse: true },
    // Phase 3 (DEC-054) — the holder's PAN. With a GSTIN it is GSTIN
    // characters 3–12; a buyer without a GSTIN is identified by it (unique
    // among GSTIN-less buyers, checked in the service — a partial index
    // cannot say "no GSTIN").
    pan: { type: String, default: null },
    firm: { type: String },
    // The proprietor (UI label "Proprietor name"; the field keeps its name).
    ownerName: { type: String },
    // The OTP login key. Phase 3 (DEC-055): unique, but may be empty — a
    // second firm on a number another firm already logs in with gets no
    // login of its own, only `contactMobile`.
    mobile: { type: String, default: null },
    // Phase 3 (DEC-055) — the number to call; may repeat across firms (one
    // proprietor, several firms).
    contactMobile: { type: String, default: null },
    licenceNo: { type: String },
    kind: { type: String, enum: ['buyer', 'seller', 'both'], required: true },
    status: {
        type: String,
        enum: ['pending', 'active', 'rejected', 'blacklisted'],
        required: true,
        default: 'pending',
    },
    // BR-296 — the language a notification is sent in. Nothing sets it yet (the
    // header toggle is not persisted server-side); every counterparty defaults
    // to `en` until it is — see QR-053.
    preferredLanguage: { type: String, enum: ['en', 'hi'], required: true, default: 'en' },
    // BR-283 — the one-WhatsApp-message-per-week cap. Claimed atomically inside
    // the same transaction as the outbox write (notification.outbox.ts), so the
    // cap is enforced in code, not only documented.
    lastWhatsAppQueuedAt: { type: Date, default: null },
    termsVersion: { type: String },
    termsAcceptedAt: { type: Date },
    // Referral code only, immutable, decays at 45 days (BR-330) — decay is
    // read-time (compare acquiredAt against now), not a background job.
    acquiredBy: { type: String, default: null },
    acquiredAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    // Staff-assisted enquiries — set only when a desk raised this
    // registration on a phone call, not by the counterparty themselves.
    // The mandatory call note lives here, on the record the action
    // creates. `staffAssistedOtpVerifiedAt` gates approval (API-014):
    // approval refuses while this is null on a staff-assisted registration.
    staffAssisted: { type: Boolean, default: false },
    staffAssistedByEmployeeId: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    staffAssistedCallNote: { type: String, default: null },
    staffAssistedOtpVerifiedAt: { type: Date, default: null },
    // Phase 3 (DEC-056) — with no OTP on a staff registration, the staff
    // member's tick that the proprietor agreed to register this number.
    proprietorAgreedAt: { type: Date, default: null },
}, { timestamps: true });
// Unique login mobile — partial, so firms with no login of their own (a
// shared number) do not collide on null. Replaces the old non-partial
// `mobile_1`; `npm run migrate:buyerIdentity` swaps it on an existing DB.
counterpartySchema.index({ mobile: 1 }, {
    unique: true,
    name: 'mobile_login_unique',
    partialFilterExpression: { mobile: { $type: 'string' } },
});
counterpartySchema.index({ pan: 1 });
counterpartySchema.index({ contactMobile: 1 });
counterpartySchema.index({ status: 1 });
counterpartySchema.index({ kind: 1, status: 1 });
export const Counterparty = model('Counterparty', counterpartySchema, 'counterparty');
