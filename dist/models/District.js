import { Schema, model } from 'mongoose';
/**
 * ENT-64 `district`. Phase 1 location masters. Unique on (state, name),
 * case-insensitively — "ujjain" and "Ujjain" in one state are one district
 * (the B-52 lesson). Still a heading only: the resolver reads the tehsil,
 * never the district (BR-080/BR-081).
 */
const districtSchema = new Schema({
    name: { type: String, required: true },
    stateId: { type: Schema.Types.ObjectId, ref: 'State', required: true },
}, { timestamps: true });
districtSchema.index({ stateId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
export const District = model('District', districtSchema, 'district');
