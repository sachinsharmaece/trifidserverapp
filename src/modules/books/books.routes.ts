import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { LedgerGroupModel, LedgerModel, VoucherModel } from '../../models/index.js';
import { onlyChanged, writeAudit } from '../../shared/audit.js';
import { encryptText } from '../../shared/encryption.js';
import { BANK_KINDS } from '../../shared/enums.js';
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

function kindOf(ledger: { party?: { side: string } | null; bank?: unknown }) {
  if (ledger.bank) return 'BANK';
  if (ledger.party?.side === 'BUYER') return 'BUYER';
  if (ledger.party?.side === 'SELLER') return 'SELLER';
  return 'OTHER';
}

/**
 * GET /ledgers?q=  ->  { ledgers }: every ledger with its group, debit and credit totals, and balance (Dr/Cr).
 * One ledger per row, so a buyer and a seller never share a row (SRS-ACC-07).
 */
booksRouter.get('/ledgers', async (req, res) => {
  const { q } = z.object({ q: z.string().trim().max(100).default('') }).parse(req.query);
  const [ledgers, groups, totals] = await Promise.all([
    LedgerModel.find(q ? { name: new RegExp(escapeRegex(q), 'i') } : {}).sort({ nameKey: 1 }),
    LedgerGroupModel.find(),
    totalsByLedger(),
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
        drPaise: sum.drPaise,
        crPaise: sum.crPaise,
        balance: balanceOf(sum.drPaise, sum.crPaise),
      };
    }),
  });
});

/**
 * GET /ledgers/:id/statement  ->  { ledger, lines, totals }: this ledger's voucher lines, oldest first, with the
 * running balance. For a bank ledger this is the bank book.
 */
booksRouter.get('/ledgers/:id/statement', async (req, res) => {
  const ledger = isValidObjectId(req.params.id) ? await LedgerModel.findById(req.params.id) : null;
  if (!ledger) throw notFound('Ledger not found.');
  const group = await LedgerGroupModel.findById(ledger.groupId);
  const vouchers = await VoucherModel.find({ 'lines.ledgerId': ledger._id }).sort({
    date: 1,
    number: 1,
  });
  let drPaise = 0;
  let crPaise = 0;
  const lines = vouchers.flatMap((voucher) =>
    voucher.lines
      .filter((line) => String(line.ledgerId) === ledger.id)
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
    },
    lines,
    totals: { drPaise, crPaise, balance: balanceOf(drPaise, crPaise) },
  });
});
