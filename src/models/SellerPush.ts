import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-67 `seller_push` — Phase 6, "Push to Purchase": a buyer who can also
 * supply. Its own pending record, not a second registration — one GSTIN is
 * one firm record (`BR-240`), so on approval a seller profile is added to the
 * buyer's own counterparty (`kind: 'both'`) and the two are linked both ways.
 *
 *   pending   → with the receiving purchase executive for the first call
 *   submitted → he completed the seller fields; waiting on a Purchase Leader
 *   approved  → `sellerId` is the new seller profile
 *   rejected  → `rejectionReason` says why
 *
 * Purchase reads only the firm's identity, "Pushed by" and the note from
 * here — never the buyer's orders, rates, asks or calls (the wall).
 */
const draftSchema = new Schema(
  {
    // Only when the buyer had no GSTIN (PAN only) — a seller needs one.
    gstin: { type: String, default: null },
    licenceNo: { type: String, default: null },
    location: {
      address: { type: String },
      pincode: { type: String, default: null },
      stateId: { type: Schema.Types.ObjectId },
      districtId: { type: Schema.Types.ObjectId },
      tehsilId: { type: Schema.Types.ObjectId },
    },
    references: [
      {
        _id: false,
        firm: { type: String, required: true },
        phone: { type: String, required: true },
        relationship: { type: String, required: true },
        whatTheySaid: { type: String, required: true },
      },
    ],
    dealershipIds: { type: [Schema.Types.ObjectId], default: [] },
    // Held encrypted, as on bank_detail; only when the firm has none yet.
    bankDetail: {
      type: new Schema(
        {
          accountEncrypted: { type: String, required: true },
          ifsc: { type: String, required: true },
          accountName: { type: String, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    margPartyCode: { type: String, default: null },
    callNote: { type: String },
  },
  { _id: false },
);

const sellerPushSchema = new Schema(
  {
    counterpartyId: { type: Schema.Types.ObjectId, ref: 'Counterparty', required: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    // DEC-064 — the executive who pushed; never changes (also copied to the
    // seller profile's `sourcedByEmployeeId` on approval).
    pushedByEmployeeId: {
      type: Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
      immutable: true,
    },
    pushedAt: { type: Date, required: true },
    note: { type: String, required: true },
    // The team's Sales Leader acting as its purchase executive, or whoever Admin chose.
    receiverEmployeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    status: {
      type: String,
      enum: ['pending', 'submitted', 'approved', 'rejected'],
      required: true,
      default: 'pending',
    },
    // True while pending or submitted — the one-open-push-per-firm index keys on it.
    open: { type: Boolean, required: true, default: true },
    draft: { type: draftSchema, default: null },
    submittedAt: { type: Date, default: null },
    submittedBy: { type: Schema.Types.ObjectId, default: null },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: Schema.Types.ObjectId, default: null },
    rejectionReason: { type: String, default: null },
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', default: null },
  },
  { timestamps: true },
);

sellerPushSchema.index(
  { counterpartyId: 1 },
  { unique: true, name: 'one_open_push_per_firm', partialFilterExpression: { open: true } },
);
sellerPushSchema.index({ receiverEmployeeId: 1, status: 1 });
sellerPushSchema.index({ pushedByEmployeeId: 1, pushedAt: -1 });

export type SellerPushDocument = InferSchemaType<typeof sellerPushSchema>;
export const SellerPush = model<SellerPushDocument>('SellerPush', sellerPushSchema, 'seller_push');
