import { Schema } from 'mongoose';
/**
 * Field builders reused by every model, so the rules for money, basis points and references are written once.
 * Conventions (ARCH §B1): money is integer paise (`…Paise`), percentages are integer basis points (`…Bp`,
 * 1800 = 18%), instants are UTC Dates (`…At`), references are ObjectIds named `…Id`.
 */
/** A whole number between min and max (inclusive). Rejects 12.5 instead of silently rounding it. */
export function intField(min, max = Number.MAX_SAFE_INTEGER) {
    return {
        type: Number,
        min,
        max,
        validate: {
            validator: Number.isSafeInteger,
            message: (props) => `${props.path} must be a whole number (got ${String(props.value)})`,
        },
    };
}
/** Basis points: 0 to 10,000 (0% to 100%). */
export const bpField = () => intField(0, 10_000);
/** A reference to another collection's `_id`. */
export const refField = (model) => ({ type: Schema.Types.ObjectId, ref: model });
/** A trimmed, non-empty string. */
export const textField = (maxlength = 200) => ({
    type: String,
    trim: true,
    minlength: 1,
    maxlength,
});
//# sourceMappingURL=_fields.js.map