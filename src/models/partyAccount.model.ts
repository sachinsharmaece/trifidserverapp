import { Schema, model, type InferSchemaType } from 'mongoose';
import { PARTY_TYPES } from '../shared/enums.js';
import { refField, textField } from './_fields.js';

/**
 * A buyer's or seller's portal login (reference PartyAccount). Staff turn it on from the buyer or seller page; it is
 * never created automatically. One mobile number is one login; a firm may have several logins (several mobiles).
 * The person signs in with a one-time code sent to this mobile. `active: false` = suspended.
 */
const partyAccountSchema = new Schema(
  {
    partyType: { type: String, enum: PARTY_TYPES, required: true },
    buyerId: refField('Buyer'),
    sellerId: refField('Seller'),
    mobile: {
      type: String,
      required: true,
      match: [/^\d{10}$/, 'a mobile number must be 10 digits'],
    },
    personName: textField(100),
    active: { type: Boolean, required: true, default: true },
    createdBy: { ...refField('User'), required: true },
    lastLoginAt: Date,
  },
  { collection: 'party_accounts', timestamps: true, versionKey: false },
);

partyAccountSchema.index({ mobile: 1 }, { unique: true });
partyAccountSchema.index({ buyerId: 1 });
partyAccountSchema.index({ sellerId: 1 });

export type PartyAccount = InferSchemaType<typeof partyAccountSchema>;
export const PartyAccountModel = model('PartyAccount', partyAccountSchema);
