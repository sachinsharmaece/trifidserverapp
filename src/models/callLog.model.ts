import { Schema, model, type InferSchemaType } from 'mongoose';
import { ASK_REASONS, CALL_OUTCOMES } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';

/**
 * One phone call Sales logged on the Call screen (reference-copy branch; reference CallLog). "Asked for a rate"
 * also records an ask (a NOT_LISTED trade, kept in `tradeId`); "He wants it" needs the pack.
 */
const callLogSchema = new Schema(
  {
    buyerId: { ...refField('Buyer'), required: true },
    productId: refField('Product'),
    skuId: refField('Sku'),
    outcome: { type: String, enum: CALL_OUTCOMES, required: true },
    note: textField(500),
    quantity: intField(1, 1_000_000),
    reasonCode: { type: String, enum: ASK_REASONS },
    tradeId: refField('Trade'),
    by: { ...refField('User'), required: true },
  },
  { collection: 'call_logs', timestamps: true, versionKey: false },
);

callLogSchema.index({ createdAt: -1 });
callLogSchema.index({ buyerId: 1, createdAt: -1 });

export type CallLog = InferSchemaType<typeof callLogSchema>;
export const CallLogModel = model('CallLog', callLogSchema);
