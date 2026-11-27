import type { Request } from 'express';
import mongoose, { isValidObjectId, Types } from 'mongoose';
import { z } from 'zod';
import {
  BankReconciliationModel,
  LedgerModel,
  UserModel,
  type BankReconciliation,
} from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { isoDateField, istDate } from '../../shared/dates.js';
import { conflict, invalidField, notFound } from '../../shared/errors.js';
import { formatRupees } from '../../shared/money.js';
import { currentUserOf } from '../auth/requireAuth.js';
import { objectId } from '../parties/common.js';
import { lastReconciledOn, ledgerClosingPaise } from './reconciliation.js';

/**
 * Bank reconciliation (SRS-PAY-05, assumption A-13, Build 9). For one bank account and one day, Accounts types the
 * closing balance printed on the bank's own statement. The system works out what the books say for that day and the
 * difference. Only a difference of zero can be marked RECONCILED; after that no entry can be dated on or before that
 * day for that bank account (`assertBankDayOpen` in postVoucher), so a reconciled day stays right. A mistake found
 * later is corrected with an entry dated after it. Balances are signed paise: positive = money in the bank.
 */

export const reconcileInput = z.object({
  bankLedgerId: objectId,
  date: isoDateField('Enter the statement date.'),
  statementClosingPaise: z
    .number({ message: 'Enter the closing balance on the statement.' })
    .int('Amounts are in whole paise.')
    .min(-100_000_000_000)
    .max(100_000_000_000),
});

type ReconDoc = InstanceType<typeof BankReconciliationModel>;

/** Type (or retype) the statement balance for a day. Saved as OPEN with the difference worked out now. */
export async function saveReconciliation(req: Request, input: z.output<typeof reconcileInput>) {
  const userId = new Types.ObjectId(currentUserOf(req).id);
  const now = new Date();
  if (input.date > istDate(now)) throw invalidField('date', 'The date cannot be in the future.');
  const bank = await LedgerModel.findById(input.bankLedgerId);
  if (!bank?.bank || !bank.active) {
    throw invalidField('bankLedgerId', 'Choose one of our bank accounts.');
  }
  const last = await lastReconciledOn(bank._id);
  if (last && input.date <= last) {
    throw conflict(
      `${bank.name} is already reconciled up to ${last}. Choose a later date.`,
      'ALREADY_RECONCILED',
    );
  }
  const ledgerClosing = await ledgerClosingPaise(bank._id, input.date);
  const difference = input.statementClosingPaise - ledgerClosing;
  const saved = await BankReconciliationModel.findOneAndUpdate(
    { bankLedgerId: bank._id, date: input.date },
    {
      $set: {
        statementClosingPaise: input.statementClosingPaise,
        ledgerClosingPaise: ledgerClosing,
        differencePaise: difference,
        enteredBy: userId,
        enteredAt: now,
      },
      $setOnInsert: { status: 'OPEN', version: 0 },
    },
    { upsert: true, returnDocument: 'after' },
  ).orFail();
  await writeAudit(req, {
    action: 'bankReconciliation.save',
    entityType: 'BankReconciliation',
    entityId: saved.id,
    after: { date: saved.date, differencePaise: difference },
  });
  return saved;
}

export async function findReconciliation(id: string) {
  const found = isValidObjectId(id) ? await BankReconciliationModel.findById(id) : null;
  if (!found) throw notFound('Reconciliation not found.');
  return found;
}

/**
 * Mark the day reconciled. The difference is worked out AGAIN now (an entry may have been posted since it was
 * typed): only zero passes.
 */
export async function markReconciled(req: Request, recon: ReconDoc, version: number) {
  if (recon.version !== version) {
    throw conflict('Someone else changed this. Reload and try again.', 'STALE_RECONCILIATION');
  }
  if (recon.status === 'RECONCILED') {
    throw conflict('This day is already reconciled.', 'ALREADY_RECONCILED');
  }
  const userId = new Types.ObjectId(currentUserOf(req).id);
  const now = new Date();
  await mongoose.connection.transaction(async (session) => {
    const ledgerClosing = await ledgerClosingPaise(recon.bankLedgerId, recon.date, session);
    const difference = recon.statementClosingPaise - ledgerClosing;
    if (difference !== 0) {
      throw conflict(
        `The statement says ${formatRupees(recon.statementClosingPaise)} but the books say ${formatRupees(ledgerClosing)}. ` +
          `Find the ${formatRupees(Math.abs(difference))} difference first.`,
        'NOT_BALANCED',
      );
    }
    const result = await BankReconciliationModel.updateOne(
      { _id: recon._id, version: recon.version, status: 'OPEN' },
      {
        $set: {
          status: 'RECONCILED',
          ledgerClosingPaise: ledgerClosing,
          differencePaise: 0,
          reconciledBy: userId,
          reconciledAt: now,
        },
        $inc: { version: 1 },
      },
      { session },
    );
    if (result.matchedCount !== 1) {
      throw conflict('Someone else changed this. Reload and try again.', 'STALE_RECONCILIATION');
    }
    await writeAudit(req, {
      action: 'bankReconciliation.mark',
      entityType: 'BankReconciliation',
      entityId: recon.id,
      after: { date: recon.date, statementClosingPaise: recon.statementClosingPaise },
      session,
    });
  });
}

export async function reconciliationViews(rows: (BankReconciliation & { id: string })[]) {
  const banks = await LedgerModel.find(
    { _id: { $in: rows.map((row) => row.bankLedgerId) } },
    { name: 1 },
  );
  const users = await UserModel.find(
    {
      _id: {
        $in: rows.flatMap((row) => [
          row.enteredBy,
          ...(row.reconciledBy ? [row.reconciledBy] : []),
        ]),
      },
    },
    { name: 1 },
  );
  const name = (id?: Types.ObjectId | null) =>
    id ? (users.find((user) => user._id.equals(id))?.name ?? '') : null;
  return rows.map((row) => ({
    id: row.id,
    bankLedgerId: String(row.bankLedgerId),
    bankName: banks.find((bank) => bank._id.equals(row.bankLedgerId))?.name ?? '',
    date: row.date,
    statementClosingPaise: row.statementClosingPaise,
    ledgerClosingPaise: row.ledgerClosingPaise,
    differencePaise: row.differencePaise,
    status: row.status,
    version: row.version,
    enteredBy: name(row.enteredBy),
    reconciledBy: name(row.reconciledBy),
    reconciledAt: row.reconciledAt ?? null,
  }));
}
