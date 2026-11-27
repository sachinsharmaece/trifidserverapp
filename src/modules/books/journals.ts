import type { Request } from 'express';
import mongoose, { isValidObjectId, Types, type ClientSession } from 'mongoose';
import { z } from 'zod';
import { nextDocumentNumber } from '../../db/documentNumbers.js';
import {
  BuyerModel,
  JournalModel,
  LedgerGroupModel,
  LedgerModel,
  SellerModel,
  UserModel,
  VoucherModel,
} from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { isoDateField, istDate } from '../../shared/dates.js';
import { JOURNAL_KINDS, JOURNAL_STATUSES } from '../../shared/enums.js';
import { conflict, forbidden, invalidField, notFound } from '../../shared/errors.js';
import { formatRupees } from '../../shared/money.js';
import { escapeRegex } from '../../shared/mongo.js';
import { currentUserOf } from '../auth/requireAuth.js';
import { objectId, pagingShape } from '../parties/common.js';
import { buyerLedger, postVoucher, sellerLedger } from './books.js';
import { assertBankDayOpen } from './reconciliation.js';

/**
 * Hand-typed journals and opening balances (SRS-ACC-04, SRS-ACC-05, Build 9). ONE flow for both (`kind`):
 *
 *   type     Accounts (or Founder/Admin) types it: PENDING_APPROVAL. Nothing is in the books yet.
 *   approve  A DIFFERENT person (Accounts, Founder, Admin) approves it: the JOURNAL voucher JV-26-0001 is posted
 *            and the journal is POSTED. The Controller only looks. Maker ≠ checker, whatever the role.
 *   reject   A different person says no, with a reason: REJECTED. The maker types a fresh one.
 *   cancel   The maker may withdraw it while it is pending: CANCELLED.
 *   reverse  A POSTED one is undone by a REVERSAL voucher (modules/books/reversals.ts): REVERSED.
 *
 * Rules: two or more lines, each a debit or a credit above zero, debits = credits, a narration, active ledgers.
 * A line names a ledger, or a buyer / seller who has no ledger yet (it is made now, like the engine does).
 * An OPENING batch must balance by itself, is dated on or before the first real entry in the books, and a ledger has
 * only one opening (SRS-ACC-05); these are checked again at approval.
 */

const MAX_PAISE = 100_000_000_000; // ₹100 crore, as on a voucher line

const paise = z
  .number({ message: 'Enter an amount.' })
  .int('Amounts are in whole paise.')
  .min(0)
  .max(MAX_PAISE, 'That amount is too large.');

const lineInput = z
  .object({
    ledgerId: objectId.optional(),
    party: z.object({ side: z.enum(['BUYER', 'SELLER']), id: objectId }).optional(),
    drPaise: paise.default(0),
    crPaise: paise.default(0),
  })
  .refine((line) => (line.ledgerId ? 1 : 0) + (line.party ? 1 : 0) === 1, {
    message: 'Choose a ledger.',
    path: ['ledgerId'],
  })
  .refine((line) => line.drPaise > 0 !== line.crPaise > 0, {
    message: 'Each line is a debit or a credit above zero, not both.',
    path: ['drPaise'],
  });

export const journalInput = z.object({
  kind: z.enum(JOURNAL_KINDS).default('JOURNAL'),
  date: isoDateField('Enter the date of the entry.'),
  narration: z.string().trim().min(1, 'Write what this entry is for.').max(280),
  lines: z.array(lineInput).min(2, 'A journal needs two or more lines.').max(40),
});

type JournalDoc = InstanceType<typeof JournalModel>;
type ResolvedLine = {
  ledgerId: Types.ObjectId;
  ledgerName: string;
  drPaise: number;
  crPaise: number;
};

/** Each typed line becomes a ledger line; a buyer or seller without a ledger gets one now. */
async function resolveLines(
  lines: z.output<typeof journalInput>['lines'],
  userId: Types.ObjectId,
  session: ClientSession,
) {
  const resolved: ResolvedLine[] = [];
  for (const [index, line] of lines.entries()) {
    const path = `lines.${index}.ledgerId`;
    let ledger = null;
    if (line.ledgerId) {
      ledger = await LedgerModel.findById(line.ledgerId).session(session);
    } else if (line.party?.side === 'BUYER') {
      const buyer = await BuyerModel.findById(line.party.id).session(session);
      if (buyer) ledger = await buyerLedger(buyer, userId, session);
    } else if (line.party?.side === 'SELLER') {
      const seller = await SellerModel.findById(line.party.id).session(session);
      if (seller) ledger = await sellerLedger(seller, userId, session);
    }
    if (!ledger) throw invalidField(path, 'Choose a ledger from the list.');
    if (!ledger.active) throw invalidField(path, `${ledger.name} is turned off.`);
    resolved.push({
      ledgerId: ledger._id,
      ledgerName: ledger.name,
      drPaise: line.drPaise,
      crPaise: line.crPaise,
    });
  }
  return resolved;
}

/** Debits = credits, over at least two different ledgers. */
function checkBalanced(lines: ResolvedLine[]) {
  const dr = lines.reduce((sum, line) => sum + line.drPaise, 0);
  const cr = lines.reduce((sum, line) => sum + line.crPaise, 0);
  if (dr !== cr) {
    throw invalidField(
      'lines',
      `Debits ${formatRupees(dr)} and credits ${formatRupees(cr)} must be equal.`,
    );
  }
  if (new Set(lines.map((line) => String(line.ledgerId))).size < 2) {
    throw invalidField('lines', 'Use two or more different ledgers.');
  }
  return dr;
}

/**
 * Opening balances (SRS-ACC-05): each ledger only once, and dated on or before the first real entry in the books
 * (an opening balance is where the books START). `selfId` is the journal being approved, so it does not count itself.
 */
async function checkOpening(
  lines: ResolvedLine[],
  date: string,
  selfId: Types.ObjectId | null,
  session: ClientSession,
) {
  const ids = lines.map((line) => String(line.ledgerId));
  if (new Set(ids).size !== ids.length) {
    throw invalidField('lines', 'Each ledger can be opened only once. Use one line per ledger.');
  }
  const others = await JournalModel.find({
    kind: 'OPENING',
    status: { $in: ['PENDING_APPROVAL', 'POSTED'] },
    'lines.ledgerId': { $in: ids },
    ...(selfId ? { _id: { $ne: selfId } } : {}),
  }).session(session);
  const taken = others
    .flatMap((other) => other.lines)
    .find((line) => ids.includes(String(line.ledgerId)));
  if (taken) {
    throw conflict(
      `${taken.ledgerName} already has an opening balance. Reverse that one first to change it.`,
      'OPENING_EXISTS',
    );
  }
  const openings = await JournalModel.find(
    { kind: 'OPENING', voucherId: { $exists: true } },
    { voucherId: 1 },
  )
    .session(session)
    .lean();
  const first = await VoucherModel.findOne({
    type: { $ne: 'REVERSAL' },
    _id: { $nin: openings.map((opening) => opening.voucherId) },
  })
    .sort({ date: 1 })
    .session(session);
  if (first && date > first.date) {
    throw invalidField(
      'date',
      `Opening balances must be dated on or before ${first.date}, the first entry in the books (${first.number}).`,
    );
  }
}

/** Type a journal or an opening batch. It waits for a different person to approve it. */
export async function createJournal(req: Request, input: z.output<typeof journalInput>) {
  const userId = new Types.ObjectId(currentUserOf(req).id);
  const now = new Date();
  if (input.date > istDate(now)) throw invalidField('date', 'The date cannot be in the future.');
  const journal = await mongoose.connection.transaction(async (session) => {
    const lines = await resolveLines(input.lines, userId, session);
    const totalPaise = checkBalanced(lines);
    await assertBankDayOpen(lines, input.date, session);
    if (input.kind === 'OPENING') await checkOpening(lines, input.date, null, session);
    const [created] = await JournalModel.create(
      [
        {
          number: await nextDocumentNumber('JNL', { session, at: now }),
          kind: input.kind,
          date: input.date,
          narration: input.narration,
          lines,
          totalPaise,
          createdBy: userId,
        },
      ],
      { session },
    );
    if (!created) throw new Error('The journal was not created');
    await writeAudit(req, {
      action: 'journal.create',
      entityType: 'Journal',
      entityId: created.id,
      after: { number: created.number, kind: created.kind, totalPaise },
      session,
    });
    return created;
  });
  return journal;
}

export async function findJournal(id: string) {
  const journal = isValidObjectId(id) ? await JournalModel.findById(id) : null;
  if (!journal) throw notFound('Journal not found.');
  return journal;
}

function checkPending(journal: JournalDoc, version: number) {
  if (journal.version !== version) {
    throw conflict('Someone else changed this entry. Reload and try again.', 'STALE_JOURNAL');
  }
  if (journal.status !== 'PENDING_APPROVAL') {
    throw conflict(`${journal.number} is not waiting for approval.`, 'NOT_PENDING');
  }
}

/** Move a pending journal on, only if nobody changed it meanwhile. */
async function closePending(
  journal: JournalDoc,
  set: Record<string, unknown>,
  session: ClientSession,
) {
  const result = await JournalModel.updateOne(
    { _id: journal._id, version: journal.version, status: 'PENDING_APPROVAL' },
    { $set: set, $inc: { version: 1 } },
    { session },
  );
  if (result.matchedCount !== 1) {
    throw conflict('Someone else changed this entry. Reload and try again.', 'STALE_JOURNAL');
  }
}

/**
 * A different person approves: the JV voucher is posted in the same transaction. The ledgers are checked again
 * (one may have been turned off), and so is the opening rule.
 */
export async function approveJournal(req: Request, journal: JournalDoc, version: number) {
  checkPending(journal, version);
  const userId = new Types.ObjectId(currentUserOf(req).id);
  if (journal.createdBy.equals(userId)) {
    throw forbidden(
      'You typed this entry, so someone else must approve it (maker and checker are different people).',
    );
  }
  const now = new Date();
  await mongoose.connection.transaction(async (session) => {
    const ledgers = await LedgerModel.find({
      _id: { $in: journal.lines.map((line) => line.ledgerId) },
    }).session(session);
    const off = ledgers.find((ledger) => !ledger.active);
    if (off) {
      throw conflict(
        `${off.name} has been turned off. Reject this entry and type it again.`,
        'LEDGER_OFF',
      );
    }
    const lines = journal.lines.map((line) => ({
      ledgerId: line.ledgerId,
      ledgerName: line.ledgerName,
      drPaise: line.drPaise,
      crPaise: line.crPaise,
    }));
    if (journal.kind === 'OPENING') await checkOpening(lines, journal.date, journal._id, session);
    const voucher = await postVoucher(
      req,
      {
        type: 'JOURNAL',
        date: journal.date,
        narration: (journal.kind === 'OPENING'
          ? `Opening balance: ${journal.narration}`
          : journal.narration
        ).slice(0, 300),
        source: { type: 'JOURNAL', id: journal._id, number: journal.number },
        lines: lines.map((line) => ({
          ledger: { _id: line.ledgerId, name: line.ledgerName },
          drPaise: line.drPaise,
          crPaise: line.crPaise,
        })),
        userId,
        now,
      },
      session,
    );
    await closePending(
      journal,
      { status: 'POSTED', approvedBy: userId, approvedAt: now, voucherId: voucher._id },
      session,
    );
    await writeAudit(req, {
      action: 'journal.approve',
      entityType: 'Journal',
      entityId: journal.id,
      after: { number: journal.number, voucher: voucher.number, totalPaise: journal.totalPaise },
      session,
    });
  });
}

export const rejectInput = z.object({
  version: z.number().int().min(0),
  note: z.string().trim().min(1, 'Say why you are rejecting it.').max(300),
});

/** A different person says no. The maker types a fresh entry. */
export async function rejectJournal(
  req: Request,
  journal: JournalDoc,
  input: z.output<typeof rejectInput>,
) {
  checkPending(journal, input.version);
  const userId = new Types.ObjectId(currentUserOf(req).id);
  if (journal.createdBy.equals(userId)) {
    throw forbidden('You typed this entry. Cancel it instead; someone else may reject it.');
  }
  await mongoose.connection.transaction(async (session) => {
    await closePending(
      journal,
      { status: 'REJECTED', rejectedBy: userId, rejectedAt: new Date(), rejectNote: input.note },
      session,
    );
    await writeAudit(req, {
      action: 'journal.reject',
      entityType: 'Journal',
      entityId: journal.id,
      after: { number: journal.number, note: input.note },
      session,
    });
  });
}

/** The maker withdraws it while it is still pending. */
export async function cancelJournal(req: Request, journal: JournalDoc, version: number) {
  checkPending(journal, version);
  const userId = new Types.ObjectId(currentUserOf(req).id);
  if (!journal.createdBy.equals(userId)) {
    throw forbidden(
      'Only the person who typed this entry can cancel it. You can reject it instead.',
    );
  }
  await mongoose.connection.transaction(async (session) => {
    await closePending(journal, { status: 'CANCELLED', cancelledAt: new Date() }, session);
    await writeAudit(req, {
      action: 'journal.cancel',
      entityType: 'Journal',
      entityId: journal.id,
      after: { number: journal.number },
      session,
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Lists and views

export const listQuery = z.object({
  ...pagingShape,
  status: z.enum(JOURNAL_STATUSES).optional(),
  kind: z.enum(JOURNAL_KINDS).optional(),
});

/** What a screen needs about one journal. `viewerId` decides which buttons show (maker ≠ checker). */
export async function journalViews(journals: JournalDoc[], viewerId: string) {
  const userIds = [
    ...new Set(
      journals.flatMap((journal) =>
        [journal.createdBy, journal.approvedBy, journal.rejectedBy, journal.reversedBy]
          .filter((id): id is Types.ObjectId => Boolean(id))
          .map(String),
      ),
    ),
  ];
  const voucherIds = journals.flatMap((journal) =>
    [journal.voucherId, journal.reverseVoucherId].filter((id): id is Types.ObjectId => Boolean(id)),
  );
  const [users, vouchers] = await Promise.all([
    userIds.length ? UserModel.find({ _id: { $in: userIds } }, { name: 1 }) : [],
    voucherIds.length ? VoucherModel.find({ _id: { $in: voucherIds } }, { number: 1 }) : [],
  ]);
  const userName = (id?: Types.ObjectId | null) =>
    id ? (users.find((user) => user._id.equals(id))?.name ?? '') : null;
  const voucherNumber = (id?: Types.ObjectId | null) =>
    id ? (vouchers.find((voucher) => voucher._id.equals(id))?.number ?? null) : null;
  return journals.map((journal) => {
    const madeByMe = String(journal.createdBy) === viewerId;
    return {
      id: journal.id,
      number: journal.number,
      kind: journal.kind,
      status: journal.status,
      version: journal.version,
      date: journal.date,
      narration: journal.narration,
      totalPaise: journal.totalPaise,
      lines: journal.lines.map((line) => ({
        ledgerId: String(line.ledgerId),
        ledgerName: line.ledgerName,
        drPaise: line.drPaise,
        crPaise: line.crPaise,
      })),
      createdBy: userName(journal.createdBy),
      createdAt: journal.createdAt,
      approvedBy: userName(journal.approvedBy),
      approvedAt: journal.approvedAt ?? null,
      rejectedBy: userName(journal.rejectedBy),
      rejectNote: journal.rejectNote ?? null,
      reversedBy: userName(journal.reversedBy),
      reverseNote: journal.reverseNote ?? null,
      voucherNumber: voucherNumber(journal.voucherId),
      reverseVoucherNumber: voucherNumber(journal.reverseVoucherId),
      /** Maker ≠ checker: the person who typed it cannot approve or reject it, but may cancel it. */
      typedByMe: madeByMe,
    };
  });
}

export async function listJournals(query: z.output<typeof listQuery>, viewerId: string) {
  const words = new RegExp(escapeRegex(query.q), 'i');
  const filter = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.q
      ? { $or: [{ number: words }, { narration: words }, { 'lines.ledgerName': words }] }
      : {}),
  };
  const [journals, total] = await Promise.all([
    JournalModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize),
    JournalModel.countDocuments(filter),
  ]);
  return {
    journals: await journalViews(journals, viewerId),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * The lines' picker: ledgers (with their group) and buyers / sellers who have no ledger yet, matching `q`.
 * Picking a party without a ledger is fine: the ledger is made when the entry is typed.
 */
export async function ledgerChoices(q: string) {
  const words = new RegExp(escapeRegex(q), 'i');
  const [ledgers, groups] = await Promise.all([
    LedgerModel.find({ active: true, ...(q ? { name: words } : {}) })
      .sort({ nameKey: 1 })
      .limit(40),
    LedgerGroupModel.find(),
  ]);
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const haveBuyer = new Set(
    ledgers.flatMap((l) => (l.party?.buyerId ? [String(l.party.buyerId)] : [])),
  );
  const haveSeller = new Set(
    ledgers.flatMap((l) => (l.party?.sellerId ? [String(l.party.sellerId)] : [])),
  );
  const choices: (
    | { kind: 'LEDGER'; ledgerId: string; name: string; group: string }
    | { kind: 'PARTY'; side: 'BUYER' | 'SELLER'; id: string; name: string }
  )[] = ledgers.map((ledger) => ({
    kind: 'LEDGER' as const,
    ledgerId: ledger.id,
    name: ledger.name,
    group: groupName.get(String(ledger.groupId)) ?? '',
  }));
  if (q) {
    // Parties are looked up only when the person types something: there can be thousands.
    const [buyers, sellers] = await Promise.all([
      BuyerModel.find({ firmName: words }, { firmName: 1, number: 1 })
        .sort({ firmName: 1 })
        .limit(20),
      SellerModel.find({ firmName: words }, { firmName: 1, number: 1 })
        .sort({ firmName: 1 })
        .limit(20),
    ]);
    for (const buyer of buyers) {
      if (!haveBuyer.has(buyer.id) && !(await LedgerModel.exists({ 'party.buyerId': buyer._id }))) {
        choices.push({
          kind: 'PARTY',
          side: 'BUYER',
          id: buyer.id,
          name: `${buyer.firmName} (${buyer.number}) · new buyer ledger`,
        });
      }
    }
    for (const seller of sellers) {
      if (
        !haveSeller.has(seller.id) &&
        !(await LedgerModel.exists({ 'party.sellerId': seller._id }))
      ) {
        choices.push({
          kind: 'PARTY',
          side: 'SELLER',
          id: seller.id,
          name: `${seller.firmName} (${seller.number}) · new seller ledger`,
        });
      }
    }
  }
  return choices;
}
