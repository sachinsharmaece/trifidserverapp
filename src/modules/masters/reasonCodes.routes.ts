import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { ReasonCodeModel } from '../../models/index.js';
import { onlyChanged, writeAudit } from '../../shared/audit.js';
import { REASON_CODE_CONTEXTS, type ReasonCodeContext } from '../../shared/enums.js';
import { notFound } from '../../shared/errors.js';
import { failIfDuplicate } from '../../shared/mongo.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { nameField } from './fields.js';
import { canEditMasters } from './permissions.js';

/**
 * Reasons staff pick from a dropdown ("buyer said no because...", "order cancelled because...").
 * Each code belongs to one context and is offered only in that context's dropdown (SRS-MST-07).
 */
export const reasonCodesRouter: Router = Router();

const CODE_TAKEN = 'A reason code with this code already exists.';

const context = z.enum(REASON_CODE_CONTEXTS);
const label = nameField('the label', 120);
const sort = z.number().int('Use a whole number.').min(0).max(10_000);

const createBody = z.object({
  /** Typed in any case; saved as UPPER_SNAKE_CASE, like WRONG_PRICE. It never changes afterwards. */
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Use capital letters, digits and _, like WRONG_PRICE.')
    .max(40),
  label,
  context,
  sort: sort.default(100),
});
// The code and its context cannot change: records that used the code would no longer match its dropdown.
const updateBody = z
  .object({ label, sort, active: z.boolean() })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to change.');

const listQuery = z.object({
  context: context.optional(),
  /** `active=true` is what a dropdown asks for: only codes that can still be picked. */
  active: z.enum(['true', 'false']).optional(),
});

function toReasonCode(reason: {
  id: string;
  code: string;
  label: string;
  context: ReasonCodeContext;
  sort?: number | null | undefined;
  active: boolean;
}) {
  return {
    id: reason.id,
    code: reason.code,
    label: reason.label,
    context: reason.context,
    sort: reason.sort ?? 100,
    active: reason.active,
  };
}

async function findReasonCode(id: string) {
  if (!isValidObjectId(id)) throw notFound('Reason code not found.');
  const reason = await ReasonCodeModel.findById(id);
  if (!reason) throw notFound('Reason code not found.');
  return reason;
}

reasonCodesRouter.use('/reason-codes', requireAuth);

/** GET /reason-codes?context=&active=  ->  { reasonCodes }, by context, then display order, then label. */
reasonCodesRouter.get('/reason-codes', async (req, res) => {
  const query = listQuery.parse(req.query);
  const filter = {
    ...(query.context ? { context: query.context } : {}),
    ...(query.active ? { active: query.active === 'true' } : {}),
  };
  const reasonCodes = await ReasonCodeModel.find(filter).sort({ context: 1, sort: 1, label: 1 });
  res.json({ reasonCodes: reasonCodes.map(toReasonCode) });
});

/** POST /reason-codes  { code, label, context, sort? }  ->  201 { reasonCode } */
reasonCodesRouter.post('/reason-codes', canEditMasters, async (req, res) => {
  const body = createBody.parse(req.body);
  const reason = await ReasonCodeModel.create({ ...body, createdBy: currentUserOf(req).id }).catch(
    failIfDuplicate(CODE_TAKEN, 'CODE_TAKEN'),
  );

  await writeAudit(req, {
    action: 'reason_code.create',
    entityType: 'ReasonCode',
    entityId: reason.id,
    before: {},
    after: { code: reason.code, context: reason.context, label: reason.label },
  });
  res.status(201).json({ reasonCode: toReasonCode(reason) });
});

/** PATCH /reason-codes/:id  { label?, sort?, active? }  ->  { reasonCode }. Never deleted: turn it off instead. */
reasonCodesRouter.patch('/reason-codes/:id', canEditMasters, async (req, res) => {
  const changes = updateBody.parse(req.body);
  const reason = await findReasonCode(req.params.id);

  const snapshot = () => ({ label: reason.label, sort: reason.sort, active: reason.active });
  const before = snapshot();
  reason.set(changes);
  const diff = onlyChanged(before, snapshot());

  if (Object.keys(diff.after).length > 0) {
    await reason.save();
    await writeAudit(req, {
      action: 'reason_code.update',
      entityType: 'ReasonCode',
      entityId: reason.id,
      ...diff,
    });
  }
  res.json({ reasonCode: toReasonCode(reason) });
});
