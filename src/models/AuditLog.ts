import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * ENT-53 `audit_log`. CH §17.6 — append-only; nothing is edited or deleted; a
 * correction is a new entry on top of the old one. DATA_MODEL.md §2.2 lists
 * audit_log among the collections that are never mutated in place.
 *
 * The block below is not a convention comment — it makes every mutating query
 * throw, so a future developer cannot accidentally add an update/delete call
 * that would pass code review by looking harmless.
 */
const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, required: true },
    actorType: { type: String, enum: ['counterparty', 'staff', 'system'], required: true },
    entity: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    field: { type: String },
    oldValue: { type: Schema.Types.Mixed },
    newValue: { type: Schema.Types.Mixed },
    reason: { type: String },
    correlationId: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ entity: 1, entityId: 1, createdAt: -1 });

// Mongoose's pre() overloads are keyed to each literal hook name, so this is
// written out long rather than looped over an array of names (a loop needs a
// type-unsafe cast to satisfy the overloads either way — this reads as
// plainly as the rule it enforces).
function forbidMutation(name: string): () => never {
  return () => {
    throw new Error(
      `audit_log is append-only (CH §17.6) — "${name}" is not permitted. Write a new entry instead.`,
    );
  };
}

auditLogSchema.pre('updateOne', forbidMutation('updateOne'));
auditLogSchema.pre('updateMany', forbidMutation('updateMany'));
auditLogSchema.pre('findOneAndUpdate', forbidMutation('findOneAndUpdate'));
auditLogSchema.pre('findOneAndReplace', forbidMutation('findOneAndReplace'));
auditLogSchema.pre('replaceOne', forbidMutation('replaceOne'));
auditLogSchema.pre('deleteOne', forbidMutation('deleteOne'));
auditLogSchema.pre('deleteMany', forbidMutation('deleteMany'));
auditLogSchema.pre('findOneAndDelete', forbidMutation('findOneAndDelete'));

export type AuditLogDocument = InferSchemaType<typeof auditLogSchema>;
export const AuditLog = model<AuditLogDocument>('AuditLog', auditLogSchema, 'audit_log');
