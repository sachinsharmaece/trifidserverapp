import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-01 `counterparty`. The firm. One GSTIN is one firm is one account
 * (`BR-240`). A firm may be both a buyer and a seller (`BR-092`).
 *
 * `licenceExpiry` is deliberately **not** on this schema — `DATA_MODEL.md`
 * ENT-01 marks it pending `QR-019`, and M3's interim position is to capture
 * only what is already confirmed (licence *number*, not an expiry date).
 */
const counterpartySchema = new Schema(
  {
    gstin: { type: String, unique: true, sparse: true },
    firm: { type: String },
    ownerName: { type: String },
    mobile: { type: String, required: true, unique: true },
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
  },
  { timestamps: true },
);

counterpartySchema.index({ status: 1 });
counterpartySchema.index({ kind: 1, status: 1 });

export type CounterpartyDocument = InferSchemaType<typeof counterpartySchema>;
export const Counterparty = model<CounterpartyDocument>(
  'Counterparty',
  counterpartySchema,
  'counterparty',
);
