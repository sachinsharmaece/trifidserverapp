import { Router } from 'express';
import mongoose, { isValidObjectId, type HydratedDocument } from 'mongoose';
import { z } from 'zod';
import { nextPartyNumber } from '../../db/documentNumbers.js';
import { BuyerModel, TehsilModel, type Buyer } from '../../models/index.js';
import { onlyChanged, writeAudit } from '../../shared/audit.js';
import { TRADE_POSITIONS } from '../../shared/enums.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { gstStateCode } from '../../shared/gstStates.js';
import { escapeRegex, failIfDuplicate } from '../../shared/mongo.js';
import { normaliseKey } from '../../shared/validators.js';
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
import { assignNewParty, dormancyEnabled } from '../dormancy/dormancy.js';
import { ownerScopeFilter } from './staffScope.js';
import { canUseBuyers } from './permissions.js';

/** Buyers: the firms TriFid sells to. Only Sales and the supervisors may see them (see permissions.ts). */
export const buyersRouter: Router = Router();

const DUPLICATE_MESSAGE = 'Another buyer already has this GSTIN or mobile number.';

const buyerShape = {
  firmName: nameField('the firm name', 200),
  contactName: nameField('the contact name', 100),
  /** The main number first. Repeats are dropped. */
  mobiles: z
    .array(mobileField)
    .min(1, 'Enter at least one mobile number.')
    .max(5, 'At most 5 mobile numbers.')
    .transform((list) => [...new Set(list)]),
  /** Leave it out or empty for a buyer with no GSTIN (B2C). */
  gstin: z.union([z.literal(''), gstinField]),
  tehsilId: objectId,
  village: optionalText(100),
  address: nameField('the address', 500),
  deliveryLocation: nameField('the delivery location', 200),
  tradePosition: z.enum(TRADE_POSITIONS),
  traderFlag: z.boolean(),
  manufacturerIds: manufacturerIdsField,
};

const createBody = z.object({
  ...buyerShape,
  gstin: buyerShape.gstin.optional(),
  village: buyerShape.village.optional(),
  manufacturerIds: buyerShape.manufacturerIds.optional(),
});
const updateBody = z
  .object({ ...buyerShape, active: z.boolean() })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to change.');

type BuyerDoc = HydratedDocument<Buyer>;

function toBuyer(buyer: BuyerDoc, tehsil: TehsilSummary | null) {
  return {
    id: buyer.id,
    number: buyer.number,
    firmName: buyer.firmName,
    contactName: buyer.contactName,
    mobiles: [...buyer.mobiles],
    gstin: buyer.gstin ?? '',
    tehsil,
    village: buyer.village ?? '',
    address: buyer.address,
    deliveryLocation: buyer.deliveryLocation,
    stateCode: buyer.stateCode,
    tradePosition: buyer.tradePosition,
    traderFlag: buyer.traderFlag,
    rateTier: buyer.rateTier,
    /** False until classified: rates are then "indicative" (priced as RETAILER). */
    classified: Boolean(buyer.classifiedAt),
    manufacturerIds: buyer.manufacturerIds.map(String),
    active: buyer.active,
    createdAt: buyer.createdAt,
  };
}

async function withTehsil(buyer: BuyerDoc) {
  const tehsils = await tehsilSummaries([buyer.tehsilId]);
  return toBuyer(buyer, tehsils.get(String(buyer.tehsilId)) ?? null);
}

function auditFields(buyer: BuyerDoc) {
  return {
    firmName: buyer.firmName,
    contactName: buyer.contactName,
    mobiles: [...buyer.mobiles],
    gstin: buyer.gstin ?? '',
    tehsilId: String(buyer.tehsilId),
    village: buyer.village ?? '',
    address: buyer.address,
    deliveryLocation: buyer.deliveryLocation,
    stateCode: buyer.stateCode,
    tradePosition: buyer.tradePosition,
    traderFlag: buyer.traderFlag,
    rateTier: buyer.rateTier,
    manufacturerIds: buyer.manufacturerIds.map(String).sort(),
    active: buyer.active,
  };
}

async function findBuyer(id: string) {
  if (!isValidObjectId(id)) throw notFound('Buyer not found.');
  const buyer = await BuyerModel.findById(id);
  if (!buyer) throw notFound('Buyer not found.');
  return buyer;
}

/** If another buyer already has this GSTIN or one of these mobile numbers, a 409 that names that buyer. */
async function findDuplicate(
  values: { gstin?: string | undefined; mobiles?: string[] | undefined },
  exceptId?: string,
) {
  const any: Record<string, unknown>[] = [];
  if (values.gstin) any.push({ gstin: values.gstin });
  if (values.mobiles?.length) any.push({ mobiles: { $in: values.mobiles } });
  if (any.length === 0) return null;

  const other = await BuyerModel.findOne({
    $or: any,
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  });
  if (!other) return null;
  if (values.gstin && other.gstin === values.gstin) {
    return conflict(
      `This GSTIN is already used by buyer ${other.number} (${other.firmName}).`,
      'BUYER_EXISTS',
    );
  }
  const mobile = other.mobiles.find((number) => values.mobiles?.includes(number));
  return conflict(
    `The mobile number ${mobile ?? ''} is already used by buyer ${other.number} (${other.firmName}).`,
    'BUYER_EXISTS',
  );
}

/**
 * The GST state code decides CGST+SGST (Madhya Pradesh) or IGST (other states) on every invoice.
 * It comes from the GSTIN; a buyer with no GSTIN gets the state of their tehsil.
 */
async function stateCodeFor(gstin: string | null | undefined, tehsilId: unknown): Promise<string> {
  if (gstin) return gstin.slice(0, 2);
  const tehsil = await TehsilModel.findById(tehsilId);
  const code = tehsil ? gstStateCode(tehsil.state) : undefined;
  if (!code) {
    throw badRequest(
      `Cannot work out the GST state code for "${tehsil?.state ?? 'this tehsil'}". Enter the buyer's GSTIN, or correct the state name of the tehsil.`,
    );
  }
  return code;
}

buyersRouter.use('/buyers', requireAuth, canUseBuyers);

/**
 * GET /buyers?q=&page=&pageSize=&active=  ->  { buyers, total, page, pageSize }
 * `q` searches the buyer number, firm name, contact name, mobile numbers and GSTIN. Sorted by firm name.
 */
buyersRouter.get('/buyers', async (req, res) => {
  const { q, page, pageSize, active } = listQuery.parse(req.query);
  const search = q
    ? {
        $or: [
          { number: new RegExp(escapeRegex(q), 'i') },
          { firmKey: { $regex: escapeRegex(normaliseKey(q)) } },
          { contactName: new RegExp(escapeRegex(q), 'i') },
          { mobiles: new RegExp(`^${escapeRegex(q)}`) },
          { gstin: new RegExp(`^${escapeRegex(q.toUpperCase())}`) },
        ],
      }
    : {};
  const scope = await ownerScopeFilter(currentUserOf(req));
  const filter = {
    ...(Object.keys(search).length && Object.keys(scope).length
      ? { $and: [search, scope] }
      : { ...search, ...scope }),
    ...(active ? { active: active === 'true' } : {}),
  };

  const [total, buyers] = await Promise.all([
    BuyerModel.countDocuments(filter),
    BuyerModel.find(filter)
      .sort({ firmKey: 1, number: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize),
  ]);
  const tehsils = await tehsilSummaries(buyers.map((buyer) => buyer.tehsilId));
  res.json({
    buyers: buyers.map((buyer) => toBuyer(buyer, tehsils.get(String(buyer.tehsilId)) ?? null)),
    total,
    page,
    pageSize,
  });
});

/** GET /buyers/:id  ->  { buyer } */
buyersRouter.get('/buyers/:id', async (req, res) => {
  res.json({ buyer: await withTehsil(await findBuyer(req.params.id)) });
});

/**
 * POST /buyers  { firmName, contactName, mobiles, gstin?, tehsilId, village?, address, deliveryLocation,
 *                 tradePosition, traderFlag, manufacturerIds? }  ->  201 { buyer }.
 * The buyer number (BUY-0001), the GST state code and the rate tier are worked out automatically.
 * A new buyer is not classified yet.
 */
buyersRouter.post('/buyers', async (req, res) => {
  const body = createBody.parse(req.body);
  const manufacturerIds = body.manufacturerIds ?? [];
  await checkTehsil(body.tehsilId);
  await checkManufacturers(manufacturerIds);
  const duplicate = await findDuplicate({ gstin: body.gstin, mobiles: body.mobiles });
  if (duplicate) throw duplicate;
  const stateCode = await stateCodeFor(body.gstin, body.tehsilId);

  // Dormant policy on: the holder is chosen by the dormancy module below (reference acquiredByUserId is a mirror of
  // the holding); off: the person who registered the buyer owns it.
  const dormancyOn = await dormancyEnabled();
  const buyer = await mongoose.connection.transaction(async (session) => {
    const number = await nextPartyNumber('BUY', { session });
    const [created] = await BuyerModel.create(
      [
        {
          number,
          firmName: body.firmName,
          contactName: body.contactName,
          mobiles: body.mobiles,
          ...(body.gstin ? { gstin: body.gstin } : {}),
          tehsilId: body.tehsilId,
          ...(body.village ? { village: body.village } : {}),
          address: body.address,
          deliveryLocation: body.deliveryLocation,
          stateCode,
          tradePosition: body.tradePosition,
          traderFlag: body.traderFlag,
          manufacturerIds,
          createdBy: currentUserOf(req).id,
          ...(dormancyOn ? {} : { acquiredById: currentUserOf(req).id }),
        },
      ],
      { session },
    ).catch(failIfDuplicate(DUPLICATE_MESSAGE, 'BUYER_EXISTS'));
    if (!created) throw new Error('Buyer was not created.');
    await writeAudit(req, {
      action: 'buyer.create',
      entityType: 'Buyer',
      entityId: created.id,
      before: {},
      after: { number, firmName: created.firmName, rateTier: created.rateTier },
      session,
    });
    return created;
  });
  // Reference LOCK-34 §4.5: every place that creates a buyer gives it a holder. Does nothing with the policy off.
  await assignNewParty(buyer._id, 'STAFF', currentUserOf(req).id);

  res.status(201).json({ buyer: await withTehsil(buyer) });
});

/**
 * PATCH /buyers/:id  { any of the fields above, active? }  ->  { buyer }.
 * Empty `gstin` makes the buyer a B2C buyer; empty `village` clears it. The state code and the rate tier are
 * worked out again when their inputs change. Changing the trade position does not change `classified`.
 */
buyersRouter.patch('/buyers/:id', async (req, res) => {
  const changes = updateBody.parse(req.body);
  const buyer = await findBuyer(req.params.id);

  const newTehsil = ifChanged(changes.tehsilId, buyer.tehsilId);
  if (newTehsil) await checkTehsil(newTehsil);
  await checkManufacturers(newlyAdded(changes.manufacturerIds, buyer.manufacturerIds));
  const duplicate = await findDuplicate(
    { gstin: changes.gstin, mobiles: changes.mobiles },
    buyer.id,
  );
  if (duplicate) throw duplicate;

  const before = auditFields(buyer);
  const { gstin, village, ...rest } = changes;
  buyer.set(rest);
  if (gstin !== undefined) buyer.set('gstin', gstin || undefined);
  if (village !== undefined) buyer.set('village', village || undefined);
  if (gstin !== undefined || changes.tehsilId !== undefined) {
    buyer.set('stateCode', await stateCodeFor(buyer.gstin, buyer.tehsilId));
  }

  const diff = onlyChanged(before, { ...auditFields(buyer), rateTier: expectedTier(buyer) });
  if (Object.keys(diff.after).length > 0) {
    await buyer.save().catch(failIfDuplicate(DUPLICATE_MESSAGE, 'BUYER_EXISTS'));
    await writeAudit(req, {
      action: 'buyer.update',
      entityType: 'Buyer',
      entityId: buyer.id,
      ...diff,
    });
  }
  res.json({ buyer: await withTehsil(buyer) });
});

/** The tier the buyer will have once saved (the model works it out when saving): trader flag wins. */
function expectedTier(buyer: BuyerDoc) {
  return buyer.traderFlag ? 'TRADER' : buyer.tradePosition;
}

/**
 * POST /buyers/:id/classify  ->  { buyer }.
 * "Classify now": confirms the buyer's tier, so rates stop being "indicative". (The system also classifies a buyer
 * automatically at their first seller confirmation; that comes with the trade engine.)
 */
buyersRouter.post('/buyers/:id/classify', async (req, res) => {
  const buyer = await findBuyer(req.params.id);
  if (!buyer.classifiedAt) {
    buyer.classifiedAt = new Date();
    await buyer.save();
    await writeAudit(req, {
      action: 'buyer.classify',
      entityType: 'Buyer',
      entityId: buyer.id,
      before: { classified: false },
      after: { classified: true, rateTier: buyer.rateTier },
    });
  }
  res.json({ buyer: await withTehsil(buyer) });
});
