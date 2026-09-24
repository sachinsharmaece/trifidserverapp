import type { ClientSession } from 'mongoose';
import { Sequence } from '../../models/Sequence.js';

/**
 * QR-032 — document numbering is provisional, adopted from the prototypes:
 * `SO-26-0417`, `PO-26-0184`, chain `C-01`. `26` is the financial year
 * 2026-27 (April to March). Sequential per document type per financial
 * year, gapless within a type — generated inside the same transaction as
 * the document so a crash cannot produce a gap or a duplicate.
 */
export function financialYearSuffix(date: Date): string {
  const year = date.getUTCMonth() >= 3 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  return String(year).slice(-2);
}

export async function nextSequence(key: string, session: ClientSession): Promise<number> {
  const updated = await Sequence.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session },
  );
  return updated!.seq;
}

export async function nextChainNo(session: ClientSession): Promise<string> {
  const seq = await nextSequence('chain', session);
  return `C-${String(seq).padStart(2, '0')}`;
}

export async function nextSoNo(date: Date, session: ClientSession): Promise<string> {
  const fy = financialYearSuffix(date);
  const seq = await nextSequence(`so-${fy}`, session);
  return `SO-${fy}-${String(seq).padStart(4, '0')}`;
}

/**
 * Enquiry journey — `ENQ-26-00001`, same scheme as the SO/PO numbers above.
 * Five digits, not four: every enquiry gets one, including the many that
 * never become an order. Dated by when the enquiry was raised, so a backfilled
 * enquiry lands in the financial year it actually belongs to.
 */
export async function nextEnquiryNo(raisedAt: Date, session: ClientSession): Promise<string> {
  const fy = financialYearSuffix(raisedAt);
  const seq = await nextSequence(`enquiry-${fy}`, session);
  return `ENQ-${fy}-${String(seq).padStart(5, '0')}`;
}

export async function nextPoNo(date: Date, session: ClientSession): Promise<string> {
  const fy = financialYearSuffix(date);
  const seq = await nextSequence(`po-${fy}`, session);
  return `PO-${fy}-${String(seq).padStart(4, '0')}`;
}
