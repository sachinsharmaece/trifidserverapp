import { Schema, model, type InferSchemaType } from 'mongoose';
import { PARTY_TYPES } from '../shared/enums.js';
import { refField } from './_fields.js';

/**
 * A signed-in portal session (buyer or seller), kept apart from staff sessions: its own collection and its own
 * cookie, so a portal login can never reach a staff route. `_id` is a hash of the cookie's random token. Lives
 * 7 days (reference); MongoDB deletes it when it expires.
 */
const partySessionSchema = new Schema(
  {
    _id: { type: String, required: true },
    partyAccountId: { ...refField('PartyAccount'), required: true },
    partyType: { type: String, enum: PARTY_TYPES, required: true },
    buyerId: refField('Buyer'),
    sellerId: refField('Seller'),
    createdAt: { type: Date, required: true, default: () => new Date() },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'party_sessions', versionKey: false },
);

partySessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
partySessionSchema.index({ partyAccountId: 1 });

export type PartySession = InferSchemaType<typeof partySessionSchema>;
export const PartySessionModel = model('PartySession', partySessionSchema);
