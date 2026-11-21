import type { ClientSession } from 'mongoose';
import { CounterModel } from '../models/counter.model.js';
import type { CounterPrefix, PartyPrefix } from '../shared/enums.js';

/** Indian financial year (April–March, IST) as two digits: 18 Nov 2026 → "26", 10 Feb 2027 → "26". */
export function financialYear(at: Date): string {
  const ist = new Date(at.getTime() + 5.5 * 60 * 60 * 1000);
  const year = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return String(year % 100).padStart(2, '0');
}

/**
 * Next human-readable number, e.g. "SO-26-0001". Atomic ($inc + upsert), so two requests never get the same
 * number. Pass the transaction `session` when the number is used by a document created in that transaction,
 * so a rolled-back transaction also rolls back the counter.
 */
export async function nextDocumentNumber(
  prefix: CounterPrefix,
  options: { session?: ClientSession; at?: Date } = {},
): Promise<string> {
  const fy = financialYear(options.at ?? new Date());
  const counter = await CounterModel.findOneAndUpdate(
    { _id: `${prefix}-${fy}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session: options.session ?? null },
  ).orFail();
  return `${prefix}-${fy}-${String(counter.seq).padStart(4, '0')}`;
}

/**
 * Next seller or buyer number, e.g. "SEL-0007". No year: a party keeps its number for life.
 * Create the party in the same transaction and pass its `session`, so a failed save does not leave a gap.
 */
export async function nextPartyNumber(
  prefix: PartyPrefix,
  options: { session?: ClientSession } = {},
): Promise<string> {
  const counter = await CounterModel.findOneAndUpdate(
    { _id: prefix },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session: options.session ?? null },
  ).orFail();
  return `${prefix}-${String(counter.seq).padStart(4, '0')}`;
}
