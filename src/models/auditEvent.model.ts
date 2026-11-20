import { Schema, model, type InferSchemaType } from 'mongoose';
import { ROLES } from '../shared/enums.js';
import { refField } from './_fields.js';

/**
 * Who changed what, and when (ARCH §B3.1). APPEND-ONLY: the app may insert and read, never update or delete.
 * The hooks below stop it in code; in production the app's database user also has insert/find rights only.
 */
const auditEventSchema = new Schema(
  {
    at: { type: Date, required: true, default: () => new Date(), immutable: true },
    /** The user who acted; empty for system jobs (actorRole 'SYSTEM'). */
    actorId: { ...refField('User'), immutable: true },
    actorRole: { type: String, enum: [...ROLES, 'SYSTEM'], required: true, immutable: true },
    /** Model name of the changed record, e.g. 'Product'. */
    entityType: { type: String, required: true, maxlength: 60, immutable: true },
    entityId: { type: String, required: true, maxlength: 60, immutable: true },
    /** The number people see (SO-26-0001), when the record has one. */
    humanNumber: { type: String, maxlength: 40, immutable: true },
    /** What happened, e.g. 'product.update', 'user.deactivate'. */
    action: { type: String, required: true, maxlength: 80, immutable: true },
    /** Changed paths only, before and after. */
    before: { type: Schema.Types.Mixed, immutable: true },
    after: { type: Schema.Types.Mixed, immutable: true },
    reason: { type: String, maxlength: 500, immutable: true },
    requestId: { type: String, maxlength: 64, immutable: true },
    ip: { type: String, maxlength: 64, immutable: true },
  },
  { collection: 'audit_events', versionKey: false },
);

auditEventSchema.index({ entityType: 1, entityId: 1, at: 1 });
auditEventSchema.index({ actorId: 1, at: 1 });
auditEventSchema.index({ at: 1 });

const appendOnly = () => {
  throw new Error('audit_events is append-only: updates and deletes are not allowed.');
};
auditEventSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  appendOnly,
);
// Saving an existing document again would be an update.
auditEventSchema.pre('save', function () {
  if (!this.isNew) appendOnly();
});

export type AuditEvent = InferSchemaType<typeof auditEventSchema>;
export const AuditEventModel = model('AuditEvent', auditEventSchema);
