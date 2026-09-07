import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-16 `permission`. TD-007 — permissions are strings, `module:action`
 * (e.g. `payout:release`, `bank:repost`). Routes check permissions, never
 * role names.
 */
const permissionSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    label: { type: String, required: true },
  },
  { timestamps: true },
);

export type PermissionDocument = InferSchemaType<typeof permissionSchema>;
export const Permission = model<PermissionDocument>('Permission', permissionSchema, 'permission');
