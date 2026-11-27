import { Router } from 'express';
import mongoose, { isValidObjectId, type HydratedDocument } from 'mongoose';
import { z } from 'zod';
import { nextPartyNumber } from '../../db/documentNumbers.js';
import { SellerModel, type Seller } from '../../models/index.js';
import { onlyChanged, writeAudit } from '../../shared/audit.js';
import { encryptText, hashText } from '../../shared/encryption.js';
import { conflict, notFound } from '../../shared/errors.js';
import { escapeRegex, failIfDuplicate } from '../../shared/mongo.js';
import { SELLER_TIERS } from '../../shared/enums.js';
import { IFSC_PATTERN, normaliseKey } from '../../shared/validators.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { nameField } from '../masters/fields.js';
import {
  checkManufacturers,
  checkTehsil,
  gstinField,
  ifChanged,
  listQuery,
  manufacturerIdsField,
  mobileField,
  newlyAdded,
  objectId,
  optionalText,
  tehsilSummaries,
  type TehsilSummary,
} from './common.js';
import { canUseSellers } from './permissions.js';

/** Sellers: the firms TriFid buys from. Only Purchase and the supervisors may see them (see permissions.ts). */
export const sellersRouter: Router = Router();

const DUPLICATE_MESSAGE = 'Another seller already has this GSTIN, mobile number or bank account.';

const bankShape = {
  /** 9 to 18 digits. Spaces and dashes are dropped. */
  accountNumber: z
    .string()
    .trim()
    .transform((text) => text.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^\d{9,18}$/, 'An account number has 9 to 18 digits.')),
  ifsc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(IFSC_PATTERN, 'An IFSC code is 4 letters, a zero, then 6 letters or digits.'),
  // Optional on the reference-copy branch: the reference form asks only for the number and IFSC.
  bankName: nameField('the bank name', 100).optional(),
  holderName: nameField('the account holder name', 150).optional(),
};

const sellerShape = {
  firmName: nameField('the firm name', 200),
  gstin: gstinField,
  mobile: mobileField,
  contactName: optionalText(100),
  tehsilId: objectId,
  address: optionalText(500),
  /** Time of day, like "17:30". */
  dispatchCutoff: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 17:30.'),
  manufacturerIds: manufacturerIdsField,
};

const createBody = z.object({
  ...sellerShape,
  // Leaving these out when adding a seller is the same as sending them empty.
  contactName: sellerShape.contactName.optional(),
  address: sellerShape.address.optional(),
  manufacturerIds: sellerShape.manufacturerIds.optional(),
  bank: z.object(bankShape),
});
const updateBody = z
  .object({
    ...sellerShape,
    // On update the account number is optional: leave it out to keep the saved one.
    bank: z.object({ ...bankShape, accountNumber: bankShape.accountNumber.optional() }).partial(),
    active: z.boolean(),
    tier: z.enum(SELLER_TIERS),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to change.');

type SellerDoc = HydratedDocument<Seller>;

/** What the browser gets. Never the bank account number or its locked copy or fingerprint: only the last 4 digits. */
function toSeller(seller: SellerDoc, tehsil: TehsilSummary | null) {
  return {
    id: seller.id,
    number: seller.number,
    firmName: seller.firmName,
    gstin: seller.gstin,
    mobile: seller.mobile,
    contactName: seller.contactName ?? '',
    tehsil,
    address: seller.address ?? '',
    dispatchCutoff: seller.dispatchCutoff,
    bank: {
      accountLast4: seller.bank?.accountLast4 ?? '',
      ifsc: seller.bank?.ifsc ?? '',
      bankName: seller.bank?.bankName ?? '',
      holderName: seller.bank?.holderName ?? '',
    },
    manufacturerIds: seller.manufacturerIds.map(String),
    tier: seller.tier,
    /** TriFid Stock (reference L42.9): its listings are always auto-confirm. */
    isHouse: Boolean(seller.isHouse),
    active: seller.active,
    createdAt: seller.createdAt,
  };
}

async function withTehsil(seller: SellerDoc) {
  const tehsils = await tehsilSummaries([seller.tehsilId]);
  return toSeller(seller, tehsils.get(String(seller.tehsilId)) ?? null);
}

/** The fields that go in the audit log. Never the full account number. */
function auditFields(seller: SellerDoc) {
  return {
    firmName: seller.firmName,
    gstin: seller.gstin,
    mobile: seller.mobile,
    contactName: seller.contactName ?? '',
    tehsilId: String(seller.tehsilId),
    address: seller.address ?? '',
    dispatchCutoff: seller.dispatchCutoff,
    ifsc: seller.bank?.ifsc ?? '',
    bankName: seller.bank?.bankName ?? '',
    holderName: seller.bank?.holderName ?? '',
    accountLast4: seller.bank?.accountLast4 ?? '',
    manufacturerIds: seller.manufacturerIds.map(String).sort(),
    tier: seller.tier,
    active: seller.active,
  };
}

async function findSeller(id: string) {
  if (!isValidObjectId(id)) throw notFound('Seller not found.');
  const seller = await SellerModel.findById(id);
  if (!seller) throw notFound('Seller not found.');
  return seller;
}

/** If another seller already has this GSTIN, mobile or bank account, a 409 that names that seller. */
async function findDuplicate(
  values: {
    gstin?: string | undefined;
    mobile?: string | undefined;
    accountHash?: string | undefined;
  },
  exceptId?: string,
) {
  const any: Record<string, string>[] = [];
  if (values.gstin) any.push({ gstin: values.gstin });
  if (values.mobile) any.push({ mobile: values.mobile });
  if (values.accountHash) any.push({ 'bank.accountHash': values.accountHash });
  if (any.length === 0) return null;

  const other = await SellerModel.findOne({
    $or: any,
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  });
  if (!other) return null;
  const what =
    other.gstin === values.gstin
      ? 'GSTIN'
      : other.mobile === values.mobile
        ? 'mobile number'
        : 'bank account';
  return conflict(
    `This ${what} is already used by seller ${other.number} (${other.firmName}).`,
    'SELLER_EXISTS',
  );
}

sellersRouter.use('/sellers', requireAuth, canUseSellers);

/**
 * GET /sellers?q=&page=&pageSize=&active=  ->  { sellers, total, page, pageSize }
 * `q` searches the seller number, firm name, contact name, mobile and GSTIN. Sorted by firm name.
 */
sellersRouter.get('/sellers', async (req, res) => {
  const { q, page, pageSize, active } = listQuery.parse(req.query);
  const search = q
    ? {
        $or: [
          { number: new RegExp(escapeRegex(q), 'i') },
          { firmKey: { $regex: escapeRegex(normaliseKey(q)) } },
          { contactName: new RegExp(escapeRegex(q), 'i') },
          { mobile: new RegExp(`^${escapeRegex(q)}`) },
          { gstin: new RegExp(`^${escapeRegex(q.toUpperCase())}`) },
        ],
      }
    : {};
  const filter = { ...search, ...(active ? { active: active === 'true' } : {}) };

  const [total, sellers] = await Promise.all([
    SellerModel.countDocuments(filter),
    SellerModel.find(filter)
      .sort({ firmKey: 1, number: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize),
  ]);
  const tehsils = await tehsilSummaries(sellers.map((seller) => seller.tehsilId));
  res.json({
    sellers: sellers.map((seller) =>
      toSeller(seller, tehsils.get(String(seller.tehsilId)) ?? null),
    ),
    total,
    page,
    pageSize,
  });
});

/** GET /sellers/:id  ->  { seller } */
sellersRouter.get('/sellers/:id', async (req, res) => {
  res.json({ seller: await withTehsil(await findSeller(req.params.id)) });
});

/**
 * POST /sellers  { firmName, gstin, mobile, contactName?, tehsilId, address?, dispatchCutoff, manufacturerIds?,
 *                  bank: { accountNumber, ifsc, bankName, holderName } }  ->  201 { seller }.
 * The account number is locked (AES-256-GCM) before saving. The seller number (SEL-0001) is given automatically.
 */
sellersRouter.post('/sellers', async (req, res) => {
  const body = createBody.parse(req.body);
  const manufacturerIds = body.manufacturerIds ?? [];
  await checkTehsil(body.tehsilId);
  await checkManufacturers(manufacturerIds);

  const accountHash = hashText(body.bank.accountNumber); // also fails early, before any write, if no key is set
  const duplicate = await findDuplicate({ gstin: body.gstin, mobile: body.mobile, accountHash });
  if (duplicate) throw duplicate;
  const accountNumberEnc = encryptText(body.bank.accountNumber);

  const seller = await mongoose.connection.transaction(async (session) => {
    const number = await nextPartyNumber('SEL', { session });
    const [created] = await SellerModel.create(
      [
        {
          number,
          firmName: body.firmName,
          gstin: body.gstin,
          mobile: body.mobile,
          ...(body.contactName ? { contactName: body.contactName } : {}),
          tehsilId: body.tehsilId,
          ...(body.address ? { address: body.address } : {}),
          dispatchCutoff: body.dispatchCutoff,
          bank: {
            accountNumberEnc,
            accountHash,
            accountLast4: body.bank.accountNumber.slice(-4),
            ifsc: body.bank.ifsc,
            ...(body.bank.bankName ? { bankName: body.bank.bankName } : {}),
            holderName: body.bank.holderName ?? body.firmName,
          },
          manufacturerIds,
          createdBy: currentUserOf(req).id,
        },
      ],
      { session },
    ).catch(failIfDuplicate(DUPLICATE_MESSAGE, 'SELLER_EXISTS'));
    if (!created) throw new Error('Seller was not created.');
    await writeAudit(req, {
      action: 'seller.create',
      entityType: 'Seller',
      entityId: created.id,
      before: {},
      after: { number, firmName: created.firmName, gstin: created.gstin },
      session,
    });
    return created;
  });

  res.status(201).json({ seller: await withTehsil(seller) });
});

/**
 * PATCH /sellers/:id  { any of the fields above, bank: { any of them }, active? }  ->  { seller }.
 * Send no `bank.accountNumber` to keep the saved one. Empty `contactName` or `address` clears it.
 */
sellersRouter.patch('/sellers/:id', async (req, res) => {
  const changes = updateBody.parse(req.body);
  const seller = await findSeller(req.params.id);
  if (seller.isHouse) {
    throw conflict(
      'TriFid Stock is kept by the system: it has no details or tier to change.',
      'HOUSE_SELLER',
    );
  }

  // Only newly chosen values must be active: a seller may keep a tehsil or manufacturer turned off later.
  const newTehsil = ifChanged(changes.tehsilId, seller.tehsilId);
  if (newTehsil) await checkTehsil(newTehsil);
  await checkManufacturers(newlyAdded(changes.manufacturerIds, seller.manufacturerIds));

  const newNumber = changes.bank?.accountNumber;
  const accountHash = newNumber ? hashText(newNumber) : undefined;
  const duplicate = await findDuplicate(
    { gstin: changes.gstin, mobile: changes.mobile, accountHash },
    seller.id,
  );
  if (duplicate) throw duplicate;

  const before = auditFields(seller);
  const { bank, contactName, address, ...rest } = changes;
  seller.set(rest);
  if (contactName !== undefined) seller.set('contactName', contactName || undefined);
  if (address !== undefined) seller.set('address', address || undefined);
  if (bank?.ifsc !== undefined) seller.set('bank.ifsc', bank.ifsc);
  if (bank?.bankName !== undefined) seller.set('bank.bankName', bank.bankName);
  if (bank?.holderName !== undefined) seller.set('bank.holderName', bank.holderName);
  if (newNumber && accountHash) {
    seller.set('bank.accountNumberEnc', encryptText(newNumber)); // fails here, before saving, if no key is set
    seller.set('bank.accountHash', accountHash);
    seller.set('bank.accountLast4', newNumber.slice(-4));
  }

  const diff = onlyChanged(before, auditFields(seller));
  if (newNumber) {
    // Replacing a number can leave the last 4 digits the same, so say so explicitly (never log the number).
    diff.before['accountNumber'] = 'on file';
    diff.after['accountNumber'] = 'replaced';
  }
  if (Object.keys(diff.after).length > 0) {
    await seller.save().catch(failIfDuplicate(DUPLICATE_MESSAGE, 'SELLER_EXISTS'));
    await writeAudit(req, {
      action: 'seller.update',
      entityType: 'Seller',
      entityId: seller.id,
      ...diff,
    });
  }
  res.json({ seller: await withTehsil(seller) });
});
