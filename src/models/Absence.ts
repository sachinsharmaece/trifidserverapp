import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-15 `absence`. BR-263 — the sole exception to fixed lane allocation.
 * Carries a return date and names a coverer; renders as *covering* rather
 * than ownership. BR-264 — cover resolves through a chain of absences,
 * computed at read time in `admin.service.ts` (`resolveCoverChain`), not
 * stored here — storing a resolved holder would go stale the moment a
 * second absence starts.
 *
 * An absence is "active" while `returnDate` has not yet passed — there is
 * no separate ended/cancelled flag, matching the DATA_MODEL.md ENT-15
 * field list exactly. M3 does not build an early-return action.
 */
const absenceSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    from: { type: Date, required: true },
    returnDate: { type: Date, required: true },
    coveredBy: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  },
  { timestamps: true },
);

absenceSchema.index({ employeeId: 1, returnDate: 1 });

export type AbsenceDocument = InferSchemaType<typeof absenceSchema>;
export const Absence = model<AbsenceDocument>('Absence', absenceSchema, 'absence');
