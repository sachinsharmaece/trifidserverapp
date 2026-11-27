import type { Request } from 'express';
import type { ClientSession, Types } from 'mongoose';
import { nextDocumentNumber } from '../../db/documentNumbers.js';
import {
  type Buyer,
  LedgerGroupModel,
  LedgerModel,
  type Seller,
  VoucherModel,
} from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import type { LedgerGroupName, LedgerSystemKey, VoucherType } from '../../shared/enums.js';
import type { GstSplit } from '../../shared/money.js';

/**
 * The books (double entry, LOCK-41, SRS-ACC-01..03). This file is the ONLY code that writes ledgers for
 * parties and vouchers. Every voucher's debits equal its credits; a posted voucher is never changed.
 *
 *   ledgerGroupId('Sundry Debtors')       the group's id (made the first time it is needed)
 *   buyerLedger(buyer, ...)               the buyer's ledger (made the first time money moves for him)
 *   sellerLedger(seller, ...)             the seller's ledger (made the first time goods are accepted from him)
 *   systemLedger('PURCHASE', ...)         a ledger automatic postings use (Purchase, Input CGST, …)
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

/** The seller's ledger under Sundry Creditors, made the first time goods are accepted from him (SRS-ACC-02). */
export async function sellerLedger(
  seller: Pick<Seller, 'number' | 'firmName' | 'gstin'> & { _id: Types.ObjectId },
  userId: Types.ObjectId,
  session: ClientSession,
) {
  const found = await LedgerModel.findOne({
    'party.side': 'SELLER',
    'party.sellerId': seller._id,
  }).session(session);
  if (found) return found;
  const name = `${seller.firmName} (${seller.number})`;
  const [ledger] = await LedgerModel.create(
    [
      {
        name,
        nameKey: name.toLowerCase(),
        groupId: await ledgerGroupId('Sundry Creditors', session),
        party: { side: 'SELLER', sellerId: seller._id },
        gstin: seller.gstin,
        stateCode: seller.gstin.slice(0, 2),
        createdBy: userId,
      },
    ],
    { session },
  );
  if (!ledger) throw new Error('The seller ledger was not created');
  return ledger;
}

/** The ledgers automatic postings use: their name and group. */
const SYSTEM_LEDGERS: Record<LedgerSystemKey, { name: string; group: LedgerGroupName }> = {
  SALES: { name: 'Sales', group: 'Sales' },
  PURCHASE: { name: 'Purchase', group: 'Purchase' },
  OUTPUT_CGST: { name: 'Output CGST', group: 'Duties & Taxes' },
  OUTPUT_SGST: { name: 'Output SGST', group: 'Duties & Taxes' },
  OUTPUT_IGST: { name: 'Output IGST', group: 'Duties & Taxes' },
  INPUT_CGST: { name: 'Input CGST', group: 'Duties & Taxes' },
  INPUT_SGST: { name: 'Input SGST', group: 'Duties & Taxes' },
  INPUT_IGST: { name: 'Input IGST', group: 'Duties & Taxes' },
  FREIGHT: { name: 'Freight', group: 'Direct Expenses' },
  ROUND_OFF: { name: 'Round off', group: 'Indirect Expenses' },
};

/** A system ledger by its key (made the first time it is needed). */
export async function systemLedger(
  key: LedgerSystemKey,
  userId: Types.ObjectId,
  session: ClientSession,
) {
  const found = await LedgerModel.findOne({ system: key }).session(session);
  if (found) return found;
  const { name, group } = SYSTEM_LEDGERS[key];
  const [ledger] = await LedgerModel.create(
    [
      {
        name,
        nameKey: name.toLowerCase(),
        groupId: await ledgerGroupId(group, session),
        system: key,
        createdBy: userId,
      },
    ],
    { session },
  );
  if (!ledger) throw new Error('The system ledger was not created');
  return ledger;
}

export interface VoucherLineInput {
  ledger: { _id: Types.ObjectId; name: string };
  drPaise?: number;
  crPaise?: number;
}

/** The number series for each voucher type (SRS-ACC-01). RECEIPT, PURCHASE, SALES and PAYMENT are posted so far. */
const SERIES = {
  RECEIPT: 'RV',
  PURCHASE: 'PV',
  SALES: 'SV',
  PAYMENT: 'PY',
} as const satisfies Partial<Record<VoucherType, 'RV' | 'PV' | 'SV' | 'PY'>>;

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
    source: {
      type: 'RECEIPT' | 'INSPECTION' | 'MARG_BILL' | 'PAYOUT_LINE';
      id: Types.ObjectId;
      number: string;
    };
    lines: VoucherLineInput[];
    /** PURCHASE and SALES vouchers: the tax inside the total. */
    gst?: GstSplit & { taxBp: number };
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
        ...(input.gst ? { gst: input.gst } : {}),
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
