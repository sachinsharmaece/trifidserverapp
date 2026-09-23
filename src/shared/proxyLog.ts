import { Schema, type Model } from 'mongoose';

/**
 * Staff-assisted enquiries — the mandatory call note lives on the record the
 * proxy action touches (CLAUDE_MASTER_PROMPT.md session brief), not only in
 * the append-only AuditLog. Every model a proxy action can reach embeds this
 * same array shape via `proxyLogField` below, so a document can carry more
 * than one staff touch over its life (raised on one call, advanced on
 * another) without overwriting the earlier note.
 */
export const proxyLogField = {
  type: [
    {
      actingStaffId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
      callNote: { type: String, required: true },
      action: { type: String, required: true },
      at: { type: Date, required: true, default: Date.now },
    },
  ],
  default: [],
};

interface ProxyLogArrayField {
  proxyLog: Array<{ actingStaffId: unknown; callNote: string; action: string; at: Date }>;
}

/**
 * Appends one entry to `proxyLog` on the record a proxy action just touched.
 * Called after the underlying service function (the exact one the
 * counterparty's own endpoint calls) has already run and succeeded — this
 * never gates or changes that function's own result, only annotates it.
 */
export async function appendProxyLog<T extends ProxyLogArrayField>(
  model: Model<T>,
  id: string,
  entry: { actingStaffId: string; callNote: string; action: string },
): Promise<void> {
  const document = await model.findById(id);
  if (!document) return;
  document.proxyLog.push({ ...entry, at: new Date() });
  await document.save();
}
