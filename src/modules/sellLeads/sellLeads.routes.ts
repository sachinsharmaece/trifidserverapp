import { Router, type NextFunction, type Request, type Response } from 'express';
import { isValidObjectId, type ClientSession, type Types } from 'mongoose';
import { z } from 'zod';
import { numberSetting } from '../../db/settings.js';
import {
  BuyerModel,
  ManufacturerModel,
  ReasonCodeModel,
  SellLeadModel,
  TehsilModel,
  UserModel,
} from '../../models/index.js';
import { SELL_LEAD_OPEN, type Role, type SellLeadStatus } from '../../shared/enums.js';
import { HttpError, conflict, invalidField, notFound } from '../../shared/errors.js';
import { escapeRegex } from '../../shared/mongo.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { logEvent } from '../fastOrder/eventLog.js';

/**
 * Seller leads (reference LOCK-39 Part B, lib/services/pushToPurchase.ts and /api/sell-leads).
 *
 *   GET  /sell-leads?firmId=           Sales: only his own pushes, status + reject code; Purchase/supervisors: all, in full
 *   GET  /sell-leads/:id
 *   POST /sell-leads                    { firmId, note, skuId?, productText?, approxQty?, qtyUnit?, expectedRatePaisePerUnit? }
 *   POST /sell-leads/:id/claim | /contact { note? } | /accept { note? } | /already-seller | /reject { code, note? }
 *   POST /sell-leads/:id/onboard        the prefill for "Register seller" (sets nothing)
 *   GET  /sell-leads/firms?q=           Purchase's firm picker for "Add seller lead": name, mobile, tehsil only
 *
 * Who: Sales, Purchase, Controller, Founder see and add; Purchase, Controller, Founder act. Anyone else (Admin
 * included) gets 404, as the reference. The lead becomes ONBOARDED when the seller is saved with its id
 * (POST /sellers { sellLeadId }).
 */
export const sellLeadsRouter: Router = Router();

const VIEW_ROLES: Role[] = ['SALES', 'PURCHASE', 'CONTROLLER', 'FOUNDER'];
const ACT_ROLES: Role[] = ['PURCHASE', 'CONTROLLER', 'FOUNDER'];
const CLOSED: SellLeadStatus[] = ['ONBOARDED', 'REJECTED', 'ALREADY_SELLER'];
const DEFAULT_PRODUCT_TEXT = 'General inquiry';

function rolesOr404(roles: Role[]) {
  return <P>(req: Request<P>, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) throw notFound('Not found.');
    next();
  };
}
sellLeadsRouter.use('/sell-leads', requireAuth, rolesOr404(VIEW_ROLES));

type LeadDoc = InstanceType<typeof SellLeadModel>;

const pastSla = (lead: LeadDoc, now = new Date()) =>
  !lead.closedAt && !lead.firstActionAt && now.getTime() > lead.dueAt.getTime();

/** Sales sees only status and reject code of his own pushes; Purchase and supervisors see the full lead. */
async function leadViews(leads: LeadDoc[], role: Role) {
  if (role === 'SALES') {
    return leads.map((lead) => ({
      id: lead.id,
      productText: lead.productText,
      status: lead.status,
      rejectCode: lead.rejectCode ?? null,
      createdAt: lead.createdAt,
    }));
  }
  const firms = await BuyerModel.find({ _id: { $in: leads.map((l) => l.firmId) } });
  const [tehsils, manufacturers, users] = await Promise.all([
    TehsilModel.find({ _id: { $in: firms.map((f) => f.tehsilId) } }),
    ManufacturerModel.find({ _id: { $in: firms.flatMap((f) => f.manufacturerIds) } }),
    UserModel.find({
      _id: { $in: leads.flatMap((l) => [l.pushedBy, ...(l.ownerUserId ? [l.ownerUserId] : [])]) },
    }),
  ]);
  const userName = (id: Types.ObjectId | null | undefined) =>
    id ? (users.find((u) => u._id.equals(id))?.name ?? '') : null;
  return leads.map((lead) => {
    const firm = firms.find((f) => f._id.equals(lead.firmId));
    const tehsil = firm && tehsils.find((t) => t._id.equals(firm.tehsilId));
    return {
      id: lead.id,
      // Never what the firm bought from us, his rates, tier or history: identity and contact only.
      firm: {
        name: firm?.firmName ?? '',
        personName: firm?.contactName ?? '',
        mobile: firm?.mobiles[0] ?? '',
        alternateMobile: firm?.mobiles[1] ?? null,
        gstin: firm?.gstin ?? '',
        tehsil: {
          name: tehsil?.name ?? '',
          district: tehsil?.district ?? '',
          state: tehsil?.state ?? '',
        },
        tradePosition: firm?.tradePosition ?? '',
        dealerships: (firm?.manufacturerIds ?? []).map(
          (mid) => manufacturers.find((m) => m._id.equals(mid))?.name ?? '',
        ),
      },
      skuId: lead.skuId ? String(lead.skuId) : null,
      productText: lead.productText,
      approxQty: lead.approxQty ?? null,
      qtyUnit: lead.qtyUnit ?? null,
      expectedRatePaisePerUnit: lead.expectedRatePaisePerUnit ?? null,
      note: lead.note,
      source: lead.source,
      pushedBy: userName(lead.pushedBy),
      status: lead.status,
      owner: userName(lead.ownerUserId),
      rejectCode: lead.rejectCode ?? null,
      rejectNote: lead.rejectNote ?? null,
      sellerId: lead.sellerId ? String(lead.sellerId) : null,
      createdAt: lead.createdAt,
      dueAt: lead.dueAt,
      firstActionAt: lead.firstActionAt ?? null,
      closedAt: lead.closedAt ?? null,
      pastSla: pastSla(lead),
      events: lead.events.map((event) => ({
        kind: event.kind,
        toStatus: event.toStatus,
        note: event.note ?? null,
        by: userName(event.by),
        at: event.at,
      })),
    };
  });
}

sellLeadsRouter.get('/sell-leads', async (req, res) => {
  const { firmId } = z
    .object({
      firmId: z
        .string()
        .regex(/^[a-f0-9]{24}$/)
        .optional(),
    })
    .parse(req.query);
  const me = currentUserOf(req);
  const leads = await SellLeadModel.find({
    ...(me.role === 'SALES' ? { pushedBy: me.id } : {}),
    ...(firmId ? { firmId } : {}),
  })
    .sort({ createdAt: -1 })
    .limit(500);
  res.json({ sellLeads: await leadViews(leads, me.role) });
});

/** Purchase's narrow firm picker (reference search-for-sell-lead): never GSTIN, tier or anything else. */
sellLeadsRouter.get('/sell-leads/firms', async (req, res) => {
  const { q } = z.object({ q: z.string().trim().max(100).default('') }).parse(req.query);
  if (q.length < 2) {
    res.json({ buyers: [] });
    return;
  }
  const words = new RegExp(escapeRegex(q), 'i');
  const buyers = await BuyerModel.find({ $or: [{ firmName: words }, { mobiles: words }] })
    .sort({ firmName: 1 })
    .limit(20);
  const tehsils = await TehsilModel.find({ _id: { $in: buyers.map((b) => b.tehsilId) } });
  res.json({
    buyers: buyers.map((b) => ({
      id: b.id,
      name: b.firmName,
      mobile: b.mobiles[0] ?? '',
      tehsilName: tehsils.find((t) => t._id.equals(b.tehsilId))?.name ?? '',
    })),
  });
});

async function findLead(req: Request<{ id: string }>) {
  const me = currentUserOf(req);
  const lead = isValidObjectId(req.params.id) ? await SellLeadModel.findById(req.params.id) : null;
  if (!lead || (me.role === 'SALES' && !lead.pushedBy.equals(me.id))) {
    throw notFound('Seller lead not found');
  }
  return lead;
}

sellLeadsRouter.get('/sell-leads/:id', async (req, res) => {
  const lead = await findLead(req);
  const [view] = await leadViews([lead], currentUserOf(req).role);
  res.json({ sellLead: view });
});

const createBody = z.object({
  firmId: z.string().regex(/^[a-f0-9]{24}$/, 'Select a firm'),
  skuId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .optional(),
  productText: z.string().trim().max(200).optional(),
  approxQty: z.number().int().positive().optional(),
  qtyUnit: z.string().trim().max(20).optional(),
  expectedRatePaisePerUnit: z.number().int().positive().optional(),
  note: z.string().trim().min(1, 'Note is required').max(500),
});

const normalise = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();

/** "Push to purchase" (Sales) and "Add seller lead" (Purchase): the only ways a lead is made. */
sellLeadsRouter.post('/sell-leads', async (req, res) => {
  const input = createBody.parse(req.body);
  const me = currentUserOf(req);
  const firm = await BuyerModel.findById(input.firmId);
  if (!firm) throw invalidField('firmId', 'Select a valid firm');
  const productText = input.productText || DEFAULT_PRODUCT_TEXT;
  // One open lead per firm and product (only when a product is named, as the reference).
  if (input.productText) {
    const open = await SellLeadModel.find({ firmId: firm._id, status: { $in: SELL_LEAD_OPEN } });
    const existing = open.find((lead) =>
      input.skuId
        ? String(lead.skuId) === input.skuId
        : !lead.skuId && normalise(lead.productText) === normalise(productText),
    );
    if (existing) {
      throw new HttpError(
        409,
        'LEAD_EXISTS',
        'An open seller lead already exists for this firm and product',
        {
          existingLeadId: existing.id,
        },
      );
    }
  }
  const slaHours = await numberSetting('SELL_LEAD_SLA_HOURS', 24);
  const now = new Date();
  const lead = await SellLeadModel.create({
    firmId: firm._id,
    ...(input.skuId ? { skuId: input.skuId } : {}),
    productText,
    ...(input.approxQty ? { approxQty: input.approxQty } : {}),
    ...(input.qtyUnit ? { qtyUnit: input.qtyUnit } : {}),
    ...(input.expectedRatePaisePerUnit
      ? { expectedRatePaisePerUnit: input.expectedRatePaisePerUnit }
      : {}),
    note: input.note,
    // From the caller's role, never from the client.
    source: me.role === 'SALES' ? 'SALES_PUSH' : 'PURCHASE_MANUAL',
    pushedBy: me.id,
    dueAt: new Date(now.getTime() + slaHours * 3_600_000),
    events: [{ kind: 'PUSH', toStatus: 'NEW', by: me.id, at: now }],
  });
  await logEvent({
    category: 'SELL_LEAD',
    entityType: 'SellLead',
    entityId: lead._id,
    partyId: firm._id,
    action: 'PUSH',
    userId: me.id,
    newValue: { productText },
  });
  const [view] = await leadViews([lead], me.role);
  res.status(201).json({ sellLead: view });
});

/** Moves an open lead and records the event (closed leads are final). */
async function move(
  req: Request<{ id: string }>,
  kind: string,
  next: (lead: LeadDoc) => {
    status: SellLeadStatus;
    firstAction: boolean;
    close: boolean;
    set?: object;
  },
  note?: string,
) {
  const me = currentUserOf(req);
  const lead = await findLead(req);
  if (CLOSED.includes(lead.status)) {
    throw conflict(
      `This lead is already ${lead.status.toLowerCase().replace('_', ' ')}`,
      'LEAD_CLOSED',
    );
  }
  const now = new Date();
  const step = next(lead);
  const from = lead.status;
  lead.set({
    status: step.status,
    ...(step.firstAction && !lead.firstActionAt ? { firstActionAt: now } : {}),
    ...(step.close ? { closedAt: now } : {}),
    ...(step.set ?? {}),
  });
  lead.events.push({
    kind,
    fromStatus: from,
    toStatus: step.status,
    ...(note ? { note } : {}),
    by: me.id,
    at: now,
  });
  await lead.save();
  await logEvent({
    category: 'SELL_LEAD',
    entityType: 'SellLead',
    entityId: lead._id,
    partyId: lead.firmId,
    action: kind,
    userId: me.id,
    ...(note ? { reason: note } : {}),
  });
  return lead;
}

const noteBody = z.object({ note: z.string().trim().max(500).optional() });
const actOnly = rolesOr404(ACT_ROLES);

/** Claim: a Purchase person takes the lead. Not a first action (the SLA clock keeps running). */
sellLeadsRouter.post('/sell-leads/:id/claim', actOnly, async (req, res) => {
  const me = currentUserOf(req).id;
  const lead = await move(req, 'CLAIM', () => ({
    status: 'CLAIMED',
    firstAction: false,
    close: false,
    set: { ownerUserId: me },
  }));
  res.json({ sellLead: { id: lead.id, status: lead.status } });
});

/** Log contact: a first action. NEW/CLAIMED → CONTACTED; later contacts are logged without moving back. */
sellLeadsRouter.post('/sell-leads/:id/contact', actOnly, async (req, res) => {
  const { note } = noteBody.parse(req.body ?? {});
  const me = currentUserOf(req).id;
  const lead = await move(
    req,
    'CONTACT',
    (l) => ({
      status: l.status === 'NEW' || l.status === 'CLAIMED' ? 'CONTACTED' : l.status,
      firstAction: true,
      close: false,
      set: l.ownerUserId ? {} : { ownerUserId: me },
    }),
    note,
  );
  res.json({ sellLead: { id: lead.id, status: lead.status, firstActionAt: lead.firstActionAt } });
});

sellLeadsRouter.post('/sell-leads/:id/accept', actOnly, async (req, res) => {
  const { note } = noteBody.parse(req.body ?? {});
  const me = currentUserOf(req).id;
  const lead = await move(
    req,
    'ACCEPT',
    (l) => ({
      status: 'ACCEPTED',
      firstAction: true,
      close: false,
      set: l.ownerUserId ? {} : { ownerUserId: me },
    }),
    note,
  );
  res.json({ sellLead: { id: lead.id, status: lead.status, firstActionAt: lead.firstActionAt } });
});

sellLeadsRouter.post('/sell-leads/:id/already-seller', actOnly, async (req, res) => {
  const lead = await move(req, 'ALREADY_SELLER', () => ({
    status: 'ALREADY_SELLER',
    firstAction: false,
    close: true,
  }));
  res.json({ sellLead: { id: lead.id, status: lead.status } });
});

/** Reject: a reason code (context SELL_LEAD_REJECT) is required; "OTHER" needs a note too. */
sellLeadsRouter.post('/sell-leads/:id/reject', actOnly, async (req, res) => {
  const { code, note } = z
    .object({ code: z.string().trim().default(''), note: z.string().trim().max(500).optional() })
    .parse(req.body);
  if (!code) throw invalidField('rejectCode', 'A reason code is required to reject');
  const reason = await ReasonCodeModel.findOne({ code, context: 'SELL_LEAD_REJECT' });
  if (!reason) throw invalidField('rejectCode', 'Not a valid reject code');
  if (code === 'OTHER' && !note) {
    throw invalidField('rejectNote', 'A note is required when the reason is Other');
  }
  const lead = await move(
    req,
    'REJECT',
    () => ({
      status: 'REJECTED',
      firstAction: true,
      close: true,
      set: { rejectCode: code, ...(note ? { rejectNote: note } : {}) },
    }),
    note ?? reason.label,
  );
  res.json({ sellLead: { id: lead.id, status: lead.status, rejectCode: lead.rejectCode } });
});

/** "Start seller onboarding": what the Register seller form starts with. Sets nothing. */
sellLeadsRouter.post('/sell-leads/:id/onboard', actOnly, async (req, res) => {
  const lead = await findLead(req);
  const firm = await BuyerModel.findById(lead.firmId).orFail();
  res.json({
    prefill: {
      leadId: lead.id,
      name: firm.firmName,
      gstin: firm.gstin ?? '',
      mobile: firm.mobiles[0] ?? '',
      tehsilId: String(firm.tehsilId),
      contactName: firm.contactName,
      address: firm.address,
    },
  });
});

/**
 * The seller was saved from this lead: ONBOARDED (called by POST /sellers { sellLeadId }, inside its transaction).
 */
export async function linkOnboardedSeller(
  req: Request,
  leadId: string,
  sellerId: Types.ObjectId,
  session: ClientSession,
) {
  const me = currentUserOf(req);
  if (!ACT_ROLES.includes(me.role)) throw notFound('Seller lead not found');
  const lead = isValidObjectId(leadId)
    ? await SellLeadModel.findById(leadId).session(session)
    : null;
  if (!lead) throw invalidField('sellLeadId', 'Seller lead not found');
  if (CLOSED.includes(lead.status)) {
    throw conflict(
      `This lead is already ${lead.status.toLowerCase().replace('_', ' ')}`,
      'LEAD_CLOSED',
    );
  }
  const now = new Date();
  lead.events.push({
    kind: 'ONBOARD',
    fromStatus: lead.status,
    toStatus: 'ONBOARDED',
    by: me.id,
    at: now,
  });
  lead.set({
    status: 'ONBOARDED',
    sellerId,
    closedAt: now,
    ...(lead.firstActionAt ? {} : { firstActionAt: now }),
  });
  await lead.save({ session });
  await logEvent(
    {
      category: 'SELL_LEAD',
      entityType: 'SellLead',
      entityId: lead._id,
      partyId: lead.firmId,
      action: 'ONBOARD',
      userId: me.id,
      newValue: { sellerId: String(sellerId) },
    },
    session,
  );
}
