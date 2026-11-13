import { Schema, model } from 'mongoose';
import { RATE_OVERRIDE_REASON_CODES } from './RateOverride.js';
/**
 * 4 Nov — Sales asks to confirm a held rate at other boxes and/or another rate than the one the
 * buyer was shown (Rate given → Change). It needs the requester's Sales Leader (or Admin) to approve
 * it (BR-050); only then can Confirm raise the order at the approved figures.
 *
 * It is aimed at either an ask's live **quote** (`quoteId` + `askId`) or a **pile deal** the seller
 * confirmed for him (`pileRequestId`, BR-378) — exactly one of the two.
 *
 * - `pending`   — waiting for the approver.
 * - `approved`  — approved; Confirm may use it once.
 * - `rejected`  — refused; the note says why. A new request may follow.
 * - `withdrawn` — taken back by the requester (or Admin) before it was used.
 * - `lapsed`    — what it was about stopped being held (hold ran out, buyer confirmed or walked away).
 * - `used`      — Confirm raised the order from it (`soId`).
 *
 * The quote or the pile deal itself is never edited: it is the seller's own offer.
 */
export const RATE_CHANGE_STATUSES = [
    'pending',
    'approved',
    'rejected',
    'withdrawn',
    'lapsed',
    'used',
];
/** A request that still stands in front of its quote or deal — at most one per quote or deal. */
export const OPEN_RATE_CHANGE_STATUSES = ['pending', 'approved'];
const rateChangeRequestSchema = new Schema({
    quoteId: { type: Schema.Types.ObjectId, ref: 'Quote', default: null },
    askId: { type: Schema.Types.ObjectId, ref: 'Ask', default: null },
    // 4 Nov — the deal given when a seller confirmed the pile he is on (BR-378).
    pileRequestId: { type: Schema.Types.ObjectId, ref: 'PileRequest', default: null },
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    // His rate when it was asked — the figure the change is measured against.
    shownRatePaise: { type: Number, required: true },
    boxes: { type: Number, required: true, min: 1 },
    ratePaise: { type: Number, required: true, min: 1 },
    // Present only when the rate differs from the one shown (BR-048's fixed dropdown).
    reasonCode: { type: String, enum: RATE_OVERRIDE_REASON_CODES, default: null },
    callNote: { type: String, required: true },
    status: { type: String, enum: RATE_CHANGE_STATUSES, required: true, default: 'pending' },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: '' },
    // The order Confirm raised from this request.
    soId: { type: Schema.Types.ObjectId, ref: 'So', default: null },
}, { timestamps: true });
rateChangeRequestSchema.index({ quoteId: 1, status: 1 });
rateChangeRequestSchema.index({ pileRequestId: 1, status: 1 });
rateChangeRequestSchema.index({ requestedBy: 1, status: 1 });
export const RateChangeRequest = model('RateChangeRequest', rateChangeRequestSchema, 'rate_change_request');
