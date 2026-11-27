import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { JournalModel, LedgerGroupModel, LedgerModel, VoucherModel } from '../../models/index.js';
import { istDate } from '../../shared/dates.js';
import { onlyChanged, writeAudit } from '../../shared/audit.js';
import { encryptText } from '../../shared/encryption.js';
import { BANK_KINDS, HAND_LEDGER_GROUPS } from '../../shared/enums.js';
import { conflict, notFound } from '../../shared/errors.js';
import { escapeRegex, failIfDuplicate } from '../../shared/mongo.js';
import { IFSC_PATTERN } from '../../shared/validators.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
import { nameField } from '../masters/fields.js';
import { canEditMasters } from '../masters/permissions.js';
import { balanceOf, ledgerGroupId } from './books.js';

/**
 * Bank accounts (our bank ledgers) and the ledgers report. Vouchers are written only by the trade engine's
 * payment step (books.ts), never here.
 *   Bank accounts: Sales, Accounts and supervisors read them (Sales picks one when entering a payment);
 *   Founder and Admin add and change them. The account number is encrypted and never sent back.
 *   Ledgers and statements: Accounts, Controller, Founder, Admin.
 */
export const booksRouter: Router = Router();

const canReadBankAccounts = requireRole('SALES', 'ACCOUNTS', 'CONTROLLER', 'FOUNDER', 'ADMIN');
const canReadBooks = requireRole('ACCOUNTS', 'CONTROLLER', 'FOUNDER', 'ADMIN');
const canWriteLedgers = requireRole('ACCOUNTS', 'FOUNDER', 'ADMIN');
const NAME_TAKEN = 'A ledger with this name already exists.';

booksRouter.use('/bank-accounts', requireAuth, canReadBankAccounts);
booksRouter.use('/ledgers', requireAuth, canReadBooks);

const bankFields = {
  name: nameField('a name for the account, e.g. "HDFC Current 1234"', 120),
  kind: z.enum(BANK_KINDS),
  bankName: z.string().trim().min(1, 'Enter the bank name.').max(100),
  ifsc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(IFSC_PATTERN, 'An IFSC code is 4 letters, a zero, then 6 letters or digits.'),
};
const accountNumber = z
  .string()
  .trim()
  .regex(/^\d{9,18}$/, 'An account number has 9 to 18 digits.');
const createBody = z.object({ ...bankFields, accountNumber });
const updateBody = z.object({
  version: z.number().int().min(0),
  ...z.object(bankFields).partial().shape,
  // Left out = keep the number already saved.
  accountNumber: accountNumber.optional(),
  active: z.boolean().optional(),
});

type BankLedger = InstanceType<typeof LedgerModel>;
function toBankAccount(ledger: BankLedger) {
  return {
    id: ledger.id,
    name: ledger.name,
    kind: ledger.bank?.kind ?? 'CURRENT',
    bankName: ledger.bank?.bankName ?? '',
    accountLast4: ledger.bank?.accountLast4 ?? '',
    ifsc: ledger.bank?.ifsc ?? null,
    active: ledger.active,
    version: ledger.version,
  };
}

/** GET /bank-accounts?active=true  ->  { bankAccounts }, A to Z. */
booksRouter.get('/bank-accounts', async (req, res) => {
  const { active } = z.object({ active: z.enum(['true']).optional() }).parse(req.query);
  const ledgers = await LedgerModel.find({
    bank: { $exists: true },
    ...(active ? { active: true } : {}),
  }).sort({ nameKey: 1 });
  res.json({ bankAccounts: ledgers.map(toBankAccount) });
});

/** POST /bank-accounts { name, kind, bankName, ifsc, accountNumber }  ->  201 { bankAccount }. Founder/Admin. */
booksRouter.post('/bank-accounts', canEditMasters, async (req, res) => {
  const body = createBody.parse(req.body);
  const ledger = await LedgerModel.create({
    name: body.name,
    nameKey: body.name.toLowerCase(),
    groupId: await ledgerGroupId('Bank Accounts'),
    bank: {
      kind: body.kind,
      bankName: body.bankName,
      ifsc: body.ifsc,
      accountNumberEnc: encryptText(body.accountNumber), // fails here, before saving, if no key is set
      accountLast4: body.accountNumber.slice(-4),
    },
    createdBy: currentUserOf(req).id,
  }).catch(failIfDuplicate(NAME_TAKEN, 'NAME_TAKEN'));
  await writeAudit(req, {
    action: 'bankAccount.create',
    entityType: 'Ledger',
    entityId: ledger.id,
    after: {
      name: ledger.name,
      bankName: body.bankName,
      accountLast4: body.accountNumber.slice(-4),
    },
  });
  res.status(201).json({ bankAccount: toBankAccount(ledger) });
});

/**
 * PATCH /bank-accounts/:id { version, name?, kind?, bankName?, ifsc?, accountNumber?, active? }  ->  { bankAccount }.
 * Never deleted: turn it off instead (a turned-off account cannot receive new payments).
 */
booksRouter.patch('/bank-accounts/:id', canEditMasters, async (req, res) => {
  const body = updateBody.parse(req.body);
  const ledger = isValidObjectId(req.params.id) ? await LedgerModel.findById(req.params.id) : null;
  if (!ledger?.bank) throw notFound('Bank account not found.');
  const before = toBankAccount(ledger);
  if (ledger.version !== body.version) {
    throw conflict('Someone else changed this account. Reload and try again.', 'STALE_LEDGER');
  }
  if (body.name !== undefined) {
    ledger.name = body.name;
    ledger.nameKey = body.name.toLowerCase();
  }
  if (body.kind !== undefined) ledger.set('bank.kind', body.kind);
  if (body.bankName !== undefined) ledger.set('bank.bankName', body.bankName);
  if (body.ifsc !== undefined) ledger.set('bank.ifsc', body.ifsc);
  if (body.accountNumber !== undefined) {
    ledger.set('bank.accountNumberEnc', encryptText(body.accountNumber));
    ledger.set('bank.accountLast4', body.accountNumber.slice(-4));
  }
  if (body.active !== undefined) ledger.active = body.active;
  ledger.version += 1;
  await ledger.save().catch(failIfDuplicate(NAME_TAKEN, 'NAME_TAKEN'));
  const { version: _before, ...beforeRest } = before;
  const { version: _after, ...afterRest } = toBankAccount(ledger);
  await writeAudit(req, {
    action: 'bankAccount.update',
    entityType: 'Ledger',
    entityId: ledger.id,
    ...onlyChanged(beforeRest, afterRest),
  });
  res.json({ bankAccount: toBankAccount(ledger) });
});

/**
 * Every ledger's totals, worked out from the posted vouchers. Fine for TriFid's volume; a cached balance per
 * ledger can come later (ARCH B3.5 `ledger_balances`, P2).
 */
async function totalsByLedger() {
  const totals = new Map<string, { drPaise: number; crPaise: number }>();
  const vouchers = await VoucherModel.find({}, { lines: 1 }).lean();
  for (const voucher of vouchers) {
    for (const line of voucher.lines) {
      const key = String(line.ledgerId);
      const sum = totals.get(key) ?? { drPaise: 0, crPaise: 0 };
      sum.drPaise += line.drPaise;
      sum.crPaise += line.crPaise;
      totals.set(key, sum);
    }
  }
  return totals;
}

/**
 * For each ledger with a balance: the date its balance last moved off zero (or changed side), i.e. how long it has
 * been pending. A simple reading of "days since the oldest unpaid entry" (reference Ledger screen).
 */
async function pendingSinceByLedger() {
  const since = new Map<string, string>();
  const net = new Map<string, number>();
  const vouchers = await VoucherModel.find({}, { date: 1, lines: 1 })
    .sort({ date: 1, number: 1 })
    .lean();
  for (const voucher of vouchers) {
    for (const line of voucher.lines) {
      const key = String(line.ledgerId);
      const before = net.get(key) ?? 0;
      const after = before + line.drPaise - line.crPaise;
      net.set(key, after);
      if (after === 0) since.delete(key);
      else if (before === 0 || Math.sign(before) !== Math.sign(after)) since.set(key, voucher.date);
    }
  }
  return since;
}

/** Days from an ISO date (YYYY-MM-DD) to today (IST). */
function daysSince(day: string) {
  const ms = Date.parse(`${istDate(new Date())}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

/** Each ledger's opening balance: the lines of posted OPENING journals. */
async function openingsByLedger() {
  const openings = new Map<string, { drPaise: number; crPaise: number }>();
  const journals = await JournalModel.find(
    { kind: 'OPENING', status: 'POSTED' },
    { lines: 1 },
  ).lean();
  for (const journal of journals) {
    for (const line of journal.lines) {
      const key = String(line.ledgerId);
      const sum = openings.get(key) ?? { drPaise: 0, crPaise: 0 };
      sum.drPaise += line.drPaise;
      sum.crPaise += line.crPaise;
      openings.set(key, sum);
    }
  }
  return openings;
}

function kindOf(ledger: { party?: { side: string } | null; bank?: unknown }) {
  if (ledger.bank) return 'BANK';
  if (ledger.party?.side === 'BUYER') return 'BUYER';
  if (ledger.party?.side === 'SELLER') return 'SELLER';
  return 'OTHER';
}

/** A ledger Accounts made by hand: not a buyer, seller, bank account or automatic-posting ledger. */
function isHandLedger(ledger: { party?: unknown; bank?: unknown; system?: unknown }) {
  return !ledger.party && !ledger.bank && !ledger.system;
}

const handLedgerBody = z.object({
  name: nameField('a name for the ledger, e.g. "Office rent"', 120),
  group: z.enum(HAND_LEDGER_GROUPS),
});

/**
 * POST /ledgers { name, group }  ->  201 { ledger }. The ledger master (SRS-ACC-02, Build 9): Accounts adds the
 * ledgers journals need (rent, interest, capital, a loan). Only the groups in HAND_LEDGER_GROUPS: buyer, seller,
 * bank and automatic ledgers are made by the system (Q-ACC-13: Accounts may add Capital and Loans).
 */
booksRouter.post('/ledgers', canWriteLedgers, async (req, res) => {
  const body = handLedgerBody.parse(req.body);
  const ledger = await LedgerModel.create({
    name: body.name,
    nameKey: body.name.toLowerCase(),
    groupId: await ledgerGroupId(body.group),
    createdBy: currentUserOf(req).id,
  }).catch(failIfDuplicate(NAME_TAKEN, 'NAME_TAKEN'));
  await writeAudit(req, {
    action: 'ledger.create',
    entityType: 'Ledger',
    entityId: ledger.id,
    after: { name: ledger.name, group: body.group },
  });
  res.status(201).json({ ledger: { id: ledger.id, name: ledger.name, group: body.group } });
});

const handLedgerUpdate = z.object({
  version: z.number().int().min(0),
  name: handLedgerBody.shape.name.optional(),
  active: z.boolean().optional(),
});

/**
 * PATCH /ledgers/:id { version, name?, active? }  ->  { ledger }. Rename or turn off a hand-made ledger. A ledger
 * is never deleted (vouchers name it), and one with a balance is not turned off: clear it with a journal first.
 */
booksRouter.patch('/ledgers/:id', canWriteLedgers, async (req, res) => {
  const body = handLedgerUpdate.parse(req.body);
  const ledger = isValidObjectId(req.params.id) ? await LedgerModel.findById(req.params.id) : null;
  if (!ledger) throw notFound('Ledger not found.');
  if (!isHandLedger(ledger)) {
    throw conflict(
      'This ledger is kept by the system. Change it where it comes from (bank accounts, buyers, sellers).',
      'MANAGED_LEDGER',
    );
  }
  if (ledger.version !== body.version) {
    throw conflict('Someone else changed this ledger. Reload and try again.', 'STALE_LEDGER');
  }
  if (body.active === false && ledger.active) {
    const sum = (await totalsByLedger()).get(ledger.id) ?? { drPaise: 0, crPaise: 0 };
    if (sum.drPaise !== sum.crPaise) {
      throw conflict(
        'This ledger still has a balance. Clear it with a journal before turning it off.',
        'LEDGER_HAS_BALANCE',
      );
    }
  }
  const before = { name: ledger.name, active: ledger.active };
  if (body.name !== undefined) {
    ledger.name = body.name;
    ledger.nameKey = body.name.toLowerCase();
  }
  if (body.active !== undefined) ledger.active = body.active;
  ledger.version += 1;
  await ledger.save().catch(failIfDuplicate(NAME_TAKEN, 'NAME_TAKEN'));
  await writeAudit(req, {
    action: 'ledger.update',
    entityType: 'Ledger',
    entityId: ledger.id,
    ...onlyChanged(before, { name: ledger.name, active: ledger.active }),
  });
  res.json({
    ledger: { id: ledger.id, name: ledger.name, active: ledger.active, version: ledger.version },
  });
});

/**
 * GET /ledgers?q=  ->  { ledgers }: every ledger with its group, debit and credit totals, and balance (Dr/Cr).
 * One ledger per row, so a buyer and a seller never share a row (SRS-ACC-07).
 */
booksRouter.get('/ledgers', async (req, res) => {
  const { q } = z.object({ q: z.string().trim().max(100).default('') }).parse(req.query);
  const [ledgers, groups, totals, since, openings] = await Promise.all([
    LedgerModel.find(q ? { name: new RegExp(escapeRegex(q), 'i') } : {}).sort({ nameKey: 1 }),
    LedgerGroupModel.find(),
    totalsByLedger(),
    pendingSinceByLedger(),
    openingsByLedger(),
  ]);
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  res.json({
    ledgers: ledgers.map((ledger) => {
      const sum = totals.get(ledger.id) ?? { drPaise: 0, crPaise: 0 };
      return {
        id: ledger.id,
        name: ledger.name,
        group: groupName.get(String(ledger.groupId)) ?? '',
        kind: kindOf(ledger),
        active: ledger.active,
        /** Made by hand (Build 9): it can be renamed and turned off here. The others are kept where they come from. */
        hand: isHandLedger(ledger),
        version: ledger.version,
        drPaise: sum.drPaise,
        crPaise: sum.crPaise,
        balance: balanceOf(sum.drPaise, sum.crPaise),
        /** Days the balance has been pending (null when it is zero). */
        pendingDays: since.has(ledger.id) ? daysSince(since.get(ledger.id)!) : null,
        /** The opening balance from a posted Opening journal (null when none). */
        opening: openings.has(ledger.id)
          ? balanceOf(openings.get(ledger.id)!.drPaise, openings.get(ledger.id)!.crPaise)
          : null,
        partyId: ledger.party?.buyerId
          ? String(ledger.party.buyerId)
          : ledger.party?.sellerId
            ? String(ledger.party.sellerId)
            : null,
      };
    }),
  });
});

/**
 * GET /ledgers/:id/statement  ->  { ledger, lines, totals }: this ledger's voucher lines, oldest first, with the
 * running balance. For a bank ledger this is the bank book.
 */
const statementQuery = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

booksRouter.get('/ledgers/:id/statement', async (req, res) => {
  const { from, to } = statementQuery.parse(req.query);
  const ledger = isValidObjectId(req.params.id) ? await LedgerModel.findById(req.params.id) : null;
  if (!ledger) throw notFound('Ledger not found.');
  const group = await LedgerGroupModel.findById(ledger.groupId);
  const vouchers = await VoucherModel.find({ 'lines.ledgerId': ledger._id }).sort({
    date: 1,
    number: 1,
  });
  let drPaise = 0;
  let crPaise = 0;
  // Entries before `from` are carried in as the brought-forward balance; entries after `to` are left out.
  let broughtDrPaise = 0;
  let broughtCrPaise = 0;
  const lines = vouchers.flatMap((voucher) =>
    voucher.lines
      .filter((line) => String(line.ledgerId) === ledger.id)
      .filter((line) => {
        if (from && voucher.date < from) {
          broughtDrPaise += line.drPaise;
          broughtCrPaise += line.crPaise;
          drPaise += line.drPaise;
          crPaise += line.crPaise;
          return false;
        }
        return !(to && voucher.date > to);
      })
      .map((line) => {
        drPaise += line.drPaise;
        crPaise += line.crPaise;
        return {
          date: voucher.date,
          voucherNumber: voucher.number,
          voucherType: voucher.type,
          narration: voucher.narration,
          drPaise: line.drPaise,
          crPaise: line.crPaise,
          balance: balanceOf(drPaise, crPaise),
        };
      }),
  );
  res.json({
    ledger: {
      id: ledger.id,
      name: ledger.name,
      group: group?.name ?? '',
      kind: kindOf(ledger),
      /** The buyer behind a buyer ledger (for his credit card on the statement). */
      buyerId: ledger.party?.buyerId ? String(ledger.party.buyerId) : null,
    },
    lines,
    broughtForward: balanceOf(broughtDrPaise, broughtCrPaise),
    totals: { drPaise, crPaise, balance: balanceOf(drPaise, crPaise) },
  });
});
