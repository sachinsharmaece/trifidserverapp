import { Schema, model } from 'mongoose';
import { ACTOR_ROLES, BUYER_STAGES, SELLER_STAGES } from '../shared/enums.js';
import { refField, textField } from './_fields.js';
/**
 * The history of one trade (append-only, never changed or deleted): one line per engine action.
 * The notes are split by the visibility wall: Sales is shown `buyerNote`, Purchase is shown `sellerNote`.
 */
const tradeEventSchema = new Schema({
    tradeId: { ...refField('Trade'), required: true },
    /** The engine action, like 'wantIt'. */
    action: { type: String, required: true },
    /** The person. Empty when the system acted (actorRole 'SYSTEM': the delivery clock). */
    actorId: {
        ...refField('User'),
        required: function () {
            return this.actorRole !== 'SYSTEM';
        },
    },
    actorRole: { type: String, enum: ACTOR_ROLES, required: true },
    buyerStageBefore: { type: String, enum: BUYER_STAGES },
    buyerStageAfter: { type: String, enum: BUYER_STAGES },
    sellerStageBefore: { type: String, enum: SELLER_STAGES },
    sellerStageAfter: { type: String, enum: SELLER_STAGES },
    /** Safe to show on the buyer side (no seller name, no seller rate). */
    buyerNote: textField(300),
    /** Safe to show on the seller side (no buyer name, no buyer rate). */
    sellerNote: textField(300),
    requestId: String,
    at: { type: Date, required: true },
}, { collection: 'trade_events', versionKey: false });
tradeEventSchema.index({ tradeId: 1, at: 1 });
// Append-only, like audit_events: the app may insert and read, never update or delete.
const appendOnly = () => {
    throw new Error('trade_events is append-only: updates and deletes are not allowed.');
};
tradeEventSchema.pre([
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
], appendOnly);
tradeEventSchema.pre('save', function () {
    if (!this.isNew)
        appendOnly();
});
export const TradeEventModel = model('TradeEvent', tradeEventSchema);
//# sourceMappingURL=tradeEvent.model.js.map