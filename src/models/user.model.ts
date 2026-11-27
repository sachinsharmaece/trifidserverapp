import { Schema, model, type InferSchemaType } from 'mongoose';
import { ROLES, STAFF_POSITIONS } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';

/**
 * Staff accounts. The password hash is never returned by queries (`select: false`) and never sent to the
 * browser (`toJSON` below). Users are never deleted: set `active: false` instead.
 * Staff positions (LOCK-37, reference-copy branch): Sales, Purchase, Accounts and Logistics staff have a position
 * on their department's ladder and may report to a more senior person of the same department. Controller, Admin and
 * Founder have no position. MFA will be added when that feature is built.
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
    /** Department ladder position; null for Controller, Admin and Founder. */
    position: { type: String, enum: STAFF_POSITIONS },
    /** The senior person of the same department this person reports to. */
    reportsToId: refField('User'),
    /** The tehsil this person works in (optional). */
    workingAreaId: refField('Tehsil'),
    /** Sales only (LOCK-34): off stops new buyers being assigned to this caller. */
    receivingLeads: { type: Boolean, required: true, default: true },
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
