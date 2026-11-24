import { Schema, model } from 'mongoose';
import { intField } from './_fields.js';
/**
 * One document per prefix and financial year, e.g. `{ _id: 'SO-26', seq: 41 }` (use `nextDocumentNumber()`),
 * or one per party prefix, e.g. `{ _id: 'SEL', seq: 7 }` (use `nextPartyNumber()`).
 */
const counterSchema = new Schema({
    _id: { type: String, required: true, match: /^[A-Z]+(-\d{2})?$/ },
    seq: { ...intField(0), required: true, default: 0 },
}, { collection: 'counters', versionKey: false });
export const CounterModel = model('Counter', counterSchema);
//# sourceMappingURL=counter.model.js.map