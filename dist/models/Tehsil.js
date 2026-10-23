import { Schema, model } from 'mongoose';
/**
 * ENT-10 `tehsil`. BR-080 — tehsil is the resolver's unit. District is a
 * heading only; nothing in the resolver reads it. **Name is not unique** —
 * thirteen names repeat in the MP master — so every picker and every seed
 * script must disambiguate by district, never by name alone.
 *
 * Phase 1 — `districtId` points at the District master (which points at the
 * State master). `district` and `state` stay as the master's names, copied
 * on every write so the existing readers keep working; the masters are the
 * source of truth. A tehsil not yet migrated (`npm run migrate:locationMasters`)
 * has `districtId: null`.
 */
const tehsilSchema = new Schema({
    name: { type: String, required: true },
    district: { type: String, required: true },
    state: { type: String, required: true },
    districtId: { type: Schema.Types.ObjectId, ref: 'District', default: null },
}, { timestamps: true });
tehsilSchema.index({ name: 1, district: 1 }, { unique: true });
tehsilSchema.index({ district: 1 });
tehsilSchema.index({ districtId: 1, name: 1 }, {
    unique: true,
    collation: { locale: 'en', strength: 2 },
    partialFilterExpression: { districtId: { $type: 'objectId' } },
});
export const Tehsil = model('Tehsil', tehsilSchema, 'tehsil');
