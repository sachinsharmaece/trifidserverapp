import { Router, type Request } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { BuyerModel, PartyAccountModel, SellerModel } from '../../models/index.js';
import type { PartyType } from '../../shared/enums.js';
import { HttpError, invalidField, notFound } from '../../shared/errors.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { logEvent } from '../fastOrder/eventLog.js';
import { canUseBuyers, canUseSellers } from '../parties/permissions.js';

/**
 * Staff side of the portals (reference PortalLoginPanel, /api/buyers/[id]/portal-account,
 * /api/sellers/[id]/portal-account, /api/portal-accounts/[id], lib/services/enablePortalAccount.ts).
 *
 *   GET  /buyers/:id/portal-account     ->  { accounts }      (the buyer side: Sales and the supervisors)
 *   POST /buyers/:id/portal-account     { mobile, personName? }  ->  201 { account }
 *   GET  /sellers/:id/portal-account    (the seller side: Purchase and the supervisors)
 *   POST /sellers/:id/portal-account
 *   PATCH /portal-accounts/:id          { active }  ->  { account }   suspend / reactivate (any staff, as the reference)
 *
 * Turning a login on is always a person's decision, never automatic. One mobile number is one login anywhere; the
 * same firm may get a second login with another mobile.
 */
export const portalAccountsRouter: Router = Router();

const createBody = z.object({
  mobile: z.string().trim().min(1, 'Enter a mobile number'),
  personName: z.string().trim().max(100).optional(),
});

function accountView(a: InstanceType<typeof PartyAccountModel>) {
  return {
    id: a.id,
    partyType: a.partyType,
    mobile: a.mobile,
    personName: a.personName ?? null,
    active: a.active,
    lastLoginAt: a.lastLoginAt ?? null,
    createdAt: (a as unknown as { createdAt: Date }).createdAt,
  };
}

async function findParty(partyType: PartyType, id: string) {
  if (!isValidObjectId(id)) return null;
  return partyType === 'BUYER' ? BuyerModel.findById(id) : SellerModel.findById(id);
}

function routesFor(partyType: PartyType) {
  const base = partyType === 'BUYER' ? '/buyers' : '/sellers';
  const guard = partyType === 'BUYER' ? canUseBuyers : canUseSellers;
  const key = partyType === 'BUYER' ? 'buyerId' : 'sellerId';
  const what = partyType === 'BUYER' ? 'Buyer' : 'Seller';

  portalAccountsRouter.get(`${base}/:id/portal-account`, requireAuth, guard, async (req, res) => {
    const id = (req as Request<{ id: string }>).params.id;
    if (!(await findParty(partyType, id))) throw notFound(`${what} not found`);
    const accounts = await PartyAccountModel.find({ [key]: id }).sort({ createdAt: -1 });
    res.json({ accounts: accounts.map(accountView) });
  });

  portalAccountsRouter.post(`${base}/:id/portal-account`, requireAuth, guard, async (req, res) => {
    const id = (req as Request<{ id: string }>).params.id;
    const body = createBody.parse(req.body);
    const party = await findParty(partyType, id);
    if (!party) throw notFound(`${what} not found`);
    if (!/^\d{10}$/.test(body.mobile)) {
      throw invalidField('mobile', 'Enter a valid 10-digit mobile number');
    }
    const existing = await PartyAccountModel.findOne({ mobile: body.mobile });
    if (existing) {
      throw new HttpError(
        409,
        'PORTAL_MOBILE_TAKEN',
        'This mobile number is already registered to a portal login',
        [{ path: 'mobile', message: 'This mobile number is already registered to a portal login' }],
      );
    }
    const me = currentUserOf(req);
    const account = await PartyAccountModel.create({
      partyType,
      [key]: party._id,
      mobile: body.mobile,
      ...(body.personName ? { personName: body.personName } : {}),
      createdBy: me.id,
    });
    await logEvent({
      category: 'PORTAL',
      entityType: 'PartyAccount',
      entityId: account._id,
      partyId: party._id,
      action: 'ENABLED',
      userId: me.id,
      newValue: { partyType, [key]: id, mobile: body.mobile },
    });
    res.status(201).json({ account: accountView(account) });
  });
}
routesFor('BUYER');
routesFor('SELLER');

portalAccountsRouter.patch('/portal-accounts/:id', requireAuth, async (req, res) => {
  const { active } = z.object({ active: z.boolean() }).parse(req.body);
  const account = isValidObjectId(req.params.id)
    ? await PartyAccountModel.findByIdAndUpdate(
        req.params.id,
        { active },
        { returnDocument: 'after' },
      )
    : null;
  if (!account) throw notFound('Portal login not found');
  await logEvent({
    category: 'PORTAL',
    entityType: 'PartyAccount',
    entityId: account._id,
    partyId: account.buyerId ?? account.sellerId ?? null,
    action: active ? 'REACTIVATED' : 'SUSPENDED',
    userId: currentUserOf(req).id,
  });
  res.json({ account: accountView(account) });
});
