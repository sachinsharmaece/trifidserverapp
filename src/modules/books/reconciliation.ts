import type { ClientSession, Types } from 'mongoose';
import { BankReconciliationModel, LedgerModel, VoucherModel } from '../../models/index.js';
import { conflict } from '../../shared/errors.js';

/**
 * Bank reconciliation helpers (SRS-PAY-05, assumption A-13). The books' balance of a bank ledger on a day, and the
 * lock that keeps reconciled days closed. The screens and routes are in modules/books/bankReconciliation.routes.ts.
 */

/**
 * What the books say a bank ledger holds at the end of `date`: Σ(debits − credits) of its lines in vouchers dated
 * on or before that day. Signed paise: positive = money in the bank.
 */
export async function ledgerClosingPaise(
  bankLedgerId: Types.ObjectId | string,
  date: string,
  session?: ClientSession,
) {
  const vouchers = await VoucherModel.find(
    { 'lines.ledgerId': bankLedgerId, date: { $lte: date } },
    { lines: 1 },
  )
    .session(session ?? null)
    .lean();
  let closing = 0;
  for (const voucher of vouchers) {
    for (const line of voucher.lines) {
      if (String(line.ledgerId) === String(bankLedgerId)) closing += line.drPaise - line.crPaise;
    }
  }
  return closing;
}

/**
 * The lock on reconciled days: no voucher may touch a bank ledger on or before a day already reconciled for it
 * (409 DAY_RECONCILED). A correction goes in as a new entry dated after that day. Called by `postVoucher` and,
 * earlier, by the forms that pick a bank date, so the person hears about it before anyone else has to act.
 */
export async function assertBankDayOpen(
  ledgers: { ledgerId: Types.ObjectId | string; ledgerName: string }[],
  date: string,
  session?: ClientSession,
) {
  const ids = [...new Set(ledgers.map((ledger) => String(ledger.ledgerId)))];
  if (ids.length === 0) return;
  const locked = await BankReconciliationModel.findOne({
    bankLedgerId: { $in: ids },
    status: 'RECONCILED',
    date: { $gte: date },
  })
    .sort({ date: -1 })
    .session(session ?? null);
  if (!locked) return;
  const name = ledgers.find((ledger) => String(ledger.ledgerId) === String(locked.bankLedgerId));
  throw conflict(
    `${name?.ledgerName ?? 'This bank account'} was reconciled up to ${locked.date}. ` +
      `An entry for ${date} can no longer be made: date it after ${locked.date}.`,
    'DAY_RECONCILED',
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The reconciliation screen's data

/** The latest day reconciled for a bank ledger, or null if it never was. */
export async function lastReconciledOn(bankLedgerId: Types.ObjectId | string) {
  const last = await BankReconciliationModel.findOne({ bankLedgerId, status: 'RECONCILED' }).sort({
    date: -1,
  });
  return last?.date ?? null;
}

/**
 * Our active bank accounts that have entries in the books after the last reconciled day (or any entry, if never
 * reconciled): the ones still to reconcile. Used for the Accounts dashboard tile and the screen's list.
 */
export async function banksToReconcile() {
  const banks = await LedgerModel.find({ bank: { $exists: true }, active: true }).sort({
    nameKey: 1,
  });
  const rows = [];
  for (const bank of banks) {
    const last = await lastReconciledOn(bank._id);
    const waiting = await VoucherModel.countDocuments({
      'lines.ledgerId': bank._id,
      ...(last ? { date: { $gt: last } } : {}),
    });
    rows.push({
      bankLedgerId: bank.id,
      name: bank.name,
      lastReconciledOn: last,
      entriesSince: waiting,
      /** What the books say the bank holds now (signed: positive = money in the bank). */
      booksPaise: await ledgerClosingPaise(bank._id, '9999-12-31'),
    });
  }
  return rows;
}
