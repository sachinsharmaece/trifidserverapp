import type { Request } from 'express';
import type { ClientSession, Types } from 'mongoose';
import { nextDocumentNumber } from '../../db/documentNumbers.js';
import { type Buyer, LedgerGroupModel, LedgerModel, VoucherModel } from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import type { LedgerGroupName, VoucherType } from '../../shared/enums.js';

/**
 * The books (double entry, LOCK-41, SRS-ACC-01..03). This file is the ONLY code that writes ledgers for
 * parties and vouchers. Every voucher's debits equal its credits; a posted voucher is never changed.
 *
 *   ledgerGroupId('Sundry Debtors')       the group's id (made the first time it is needed)
 *   buyerLedger(buyer, ...)               the buyer's ledger (made the first time money moves for him)
 *   postVoucher(req, {...}, session)      write one balanced voucher, with its audit line
 */

/** The group's id. Groups are a fixed list (LEDGER_GROUPS); one is created the first time it is needed. */
export async function ledgerGroupId(name: LedgerGroupName, session?: ClientSession) {
  const group = await LedgerGroupModel.findOneAndUpdate(
    { name },
    { $setOnInsert: { name } },
    { upsert: true, returnDocument: 'after', session: session ?? null },
  ).orFail();
  return group._id;
}

/** The buyer's ledger under Sundry Debtors, made the first time money moves for him (SRS-ACC-02). */
export async function buyerLedger(
  buyer: Pick<Buyer, 'number' | 'firmName' | 'gstin' | 'stateCode'> & { _id: Types.ObjectId },
  userId: Types.ObjectId,
  session: ClientSession,
) {
  const found = await LedgerModel.findOne({
    'party.side': 'BUYER',
    'party.buyerId': buyer._id,
  }).session(session);
  if (found) return found;
  const name = `${buyer.firmName} (${buyer.number})`;
  const [ledger] = await LedgerModel.create(
    [
      {
        name,
        nameKey: name.toLowerCase(),
        groupId: await ledgerGroupId('Sundry Debtors', session),
        party: { side: 'BUYER', buyerId: buyer._id },
        ...(buyer.gstin ? { gstin: buyer.gstin } : {}),
        stateCode: buyer.stateCode,
        createdBy: userId,
      },
    ],
    { session },
  );
  if (!ledger) throw new Error('The buyer ledger was not created');
  return ledger;
}

export interface VoucherLineInput {
  ledger: { _id: Types.ObjectId; name: string };
  drPaise?: number;
  crPaise?: number;
}

/** The number series for each voucher type (SRS-ACC-01). Only RECEIPT is posted so far. */
const SERIES = { RECEIPT: 'RV' } as const satisfies Partial<Record<VoucherType, 'RV'>>;

/**
 * Write one voucher: two or more lines, each a debit or a credit, debits = credits (the model checks it too).
 * One automatic voucher per source (a receipt can never be posted twice: unique index). Inside `session`.
 */
export async function postVoucher(
  req: Request,
  input: {
    type: keyof typeof SERIES;
    date: string;
    narration: string;
    source: { type: 'RECEIPT'; id: Types.ObjectId; number: string };
    lines: VoucherLineInput[];
    userId: Types.ObjectId;
    now: Date;
  },
  session: ClientSession,
) {
  const lines = input.lines.map((line) => ({
    ledgerId: line.ledger._id,
    ledgerName: line.ledger.name,
    drPaise: line.drPaise ?? 0,
    crPaise: line.crPaise ?? 0,
  }));
  const totalPaise = lines.reduce((sum, line) => sum + line.drPaise, 0);
  const [voucher] = await VoucherModel.create(
    [
      {
        number: await nextDocumentNumber(SERIES[input.type], { session, at: input.now }),
        type: input.type,
        date: input.date,
        narration: input.narration,
        source: input.source,
        lines,
        totalPaise,
        createdBy: input.userId,
        postedAt: input.now,
      },
    ],
    { session },
  );
  if (!voucher) throw new Error('The voucher was not created');
  await writeAudit(req, {
    action: 'voucher.post',
    entityType: 'Voucher',
    entityId: voucher.id,
    after: { number: voucher.number, type: voucher.type, totalPaise },
    session,
  });
  return voucher;
}

/** Debit minus credit, as people read it: "₹500.00 Dr" or "₹500.00 Cr". */
export function balanceOf(drPaise: number, crPaise: number) {
  const net = drPaise - crPaise;
  return { paise: Math.abs(net), side: net >= 0 ? ('DR' as const) : ('CR' as const) };
}
