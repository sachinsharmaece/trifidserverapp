import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { HsnCodeModel } from '../../models/index.js';
import { onlyChanged, writeAudit } from '../../shared/audit.js';
import { notFound } from '../../shared/errors.js';
import { failIfDuplicate } from '../../shared/mongo.js';
import { HSN_PATTERN } from '../../shared/validators.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { descriptionField } from './fields.js';
import { canEditMasters } from './permissions.js';
export const hsnCodesRouter = Router();
const CODE_TAKEN = 'This HSN code already exists.';
/** GST rate in basis points: 1800 means 18%. */
const gstBp = z.number().int('Use a whole number of basis points.').min(0).max(10_000);
const description = descriptionField;
const createBody = z.object({
    code: z.string().trim().regex(HSN_PATTERN, 'An HSN code has 4, 6 or 8 digits.'),
    description: description.optional(),
    gstBp,
});
// The code itself cannot change: products point at it. Add a new code instead.
const updateBody = z
    .object({ description, gstBp, active: z.boolean() })
    .partial()
    .refine((body) => Object.keys(body).length > 0, 'Nothing to change.');
function toHsnCode(hsn) {
    return {
        id: hsn.id,
        code: hsn.code,
        description: hsn.description ?? '',
        gstBp: hsn.gstBp,
        active: hsn.active,
    };
}
async function findHsnCode(id) {
    if (!isValidObjectId(id))
        throw notFound('HSN code not found.');
    const hsn = await HsnCodeModel.findById(id);
    if (!hsn)
        throw notFound('HSN code not found.');
    return hsn;
}
hsnCodesRouter.use('/hsn-codes', requireAuth);
/** GET /hsn-codes  ->  { hsnCodes }, every one, by code. */
hsnCodesRouter.get('/hsn-codes', async (_req, res) => {
    const hsnCodes = await HsnCodeModel.find().sort({ code: 1 });
    res.json({ hsnCodes: hsnCodes.map(toHsnCode) });
});
/** POST /hsn-codes  { code, description?, gstBp }  ->  201 { hsnCode } */
hsnCodesRouter.post('/hsn-codes', canEditMasters, async (req, res) => {
    const body = createBody.parse(req.body);
    const hsn = await HsnCodeModel.create({
        code: body.code,
        ...(body.description ? { description: body.description } : {}),
        gstBp: body.gstBp,
        createdBy: currentUserOf(req).id,
    }).catch(failIfDuplicate(CODE_TAKEN, 'CODE_TAKEN'));
    await writeAudit(req, {
        action: 'hsn.create',
        entityType: 'HsnCode',
        entityId: hsn.id,
        before: {},
        after: { code: hsn.code, gstBp: hsn.gstBp },
    });
    res.status(201).json({ hsnCode: toHsnCode(hsn) });
});
/**
 * PATCH /hsn-codes/:id  { description?, gstBp?, active? }  ->  { hsnCode }.
 * Changing the GST rate does NOT change products that already use this code: their own tax rate stays as it is.
 */
hsnCodesRouter.patch('/hsn-codes/:id', canEditMasters, async (req, res) => {
    const changes = updateBody.parse(req.body);
    const hsn = await findHsnCode(req.params.id);
    const before = { description: hsn.description ?? '', gstBp: hsn.gstBp, active: hsn.active };
    if (changes.description !== undefined) {
        hsn.set('description', changes.description === '' ? undefined : changes.description);
    }
    if (changes.gstBp !== undefined)
        hsn.gstBp = changes.gstBp;
    if (changes.active !== undefined)
        hsn.active = changes.active;
    const diff = onlyChanged(before, {
        description: hsn.description ?? '',
        gstBp: hsn.gstBp,
        active: hsn.active,
    });
    if (Object.keys(diff.after).length > 0) {
        await hsn.save();
        await writeAudit(req, {
            action: 'hsn.update',
            entityType: 'HsnCode',
            entityId: hsn.id,
            ...diff,
        });
    }
    res.json({ hsnCode: toHsnCode(hsn) });
});
//# sourceMappingURL=hsnCodes.routes.js.map