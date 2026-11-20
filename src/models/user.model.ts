import { Schema, model, type InferSchemaType } from 'mongoose';
import { ROLES } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';

/**
 * Staff accounts. The password hash is never returned by queries (`select: false`) and never sent to the
 * browser (`toJSON` below). Users are never deleted: set `active: false` instead.
 * MFA and staff-hierarchy fields will be added when those features are built.
 */
const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'email is not a valid address'],
    },
    name: { ...textField(100), required: true },
    role: { type: String, enum: ROLES, required: true },
    /** argon2id hash. To read it: `UserModel.findOne(...).select('+passwordHash')`. */
    passwordHash: { type: String, required: true, select: false },
    /** true for new or reset accounts: the user must choose a new password at first sign-in. */
    mustChangePassword: { type: Boolean, required: true, default: true },
    /** Wrong passwords in a row; the account locks until `lockedUntil` after too many. */
    failedLoginCount: { ...intField(0), required: true, default: 0 },
    lockedUntil: Date,
    active: { type: Boolean, required: true, default: true },
    createdBy: refField('User'),
  },
  {
    collection: 'users',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.passwordHash;
        return ret;
      },
    },
  },
);

userSchema.index({ email: 1 }, { unique: true });

export type User = InferSchemaType<typeof userSchema>;
export const UserModel = model('User', userSchema);
