import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { TechnicalModel } from '../../models/index.js';
import { onlyChanged, writeAudit } from '../../shared/audit.js';
import { notFound } from '../../shared/errors.js';
import { failIfDuplicate } from '../../shared/mongo.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { descriptionField, nameField } from './fields.js';
import { canEditMasters } from './permissions.js';
export const technicalsRouter = Router();
const NAME_TAKEN = 'A technical with this name already exists.';
const name = nameField('the technical name');
/** Optional detail like "Azadirachtin 0.03% EC". */
const description = descriptionField;
const createBody = z.object({ name, description: description.optional() });
const updateBody = z
    .object({ name, description, active: z.boolean() })
    .partial()
    .refine((body) => Object.keys(body).length > 0, 'Nothing to change.');
function toTechnical(technical) {
    return {
        id: technical.id,
        name: technical.name,
        description: technical.description ?? '',
        active: technical.active,
    };
}
async function findTechnical(id) {
    if (!isValidObjectId(id))
        throw notFound('Technical not found.');
    const technical = await TechnicalModel.findById(id);
    if (!technical)
        throw notFound('Technical not found.');
    return technical;
}
technicalsRouter.use('/technicals', requireAuth);
/** GET /technicals  ->  { technicals }, every one (active and turned off), A to Z. */
technicalsRouter.get('/technicals', async (_req, res) => {
    const technicals = await TechnicalModel.find().sort({ nameLower: 1 });
    res.json({ technicals: technicals.map(toTechnical) });
});
/** POST /technicals  { name, description? }  ->  201 { technical } */
technicalsRouter.post('/technicals', canEditMasters, async (req, res) => {
    const body = createBody.parse(req.body);
    const technical = await TechnicalModel.create({
        name: body.name,
        ...(body.description ? { description: body.description } : {}),
        createdBy: currentUserOf(req).id,
    }).catch(failIfDuplicate(NAME_TAKEN, 'NAME_TAKEN'));
    await writeAudit(req, {
        action: 'technical.create',
        entityType: 'Technical',
        entityId: technical.id,
        before: {},
        after: { name: technical.name },
    });
    res.status(201).json({ technical: toTechnical(technical) });
});
/** PATCH /technicals/:id  { name?, description?, active? }  ->  { technical }. Never deleted. */
technicalsRouter.patch('/technicals/:id', canEditMasters, async (req, res) => {
    const changes = updateBody.parse(req.body);
    const technical = await findTechnical(req.params.id);
    const before = {
        name: technical.name,
        description: technical.description ?? '',
        active: technical.active,
    };
    if (changes.name !== undefined)
        technical.name = changes.name;
    if (changes.description !== undefined) {
        technical.set('description', changes.description === '' ? undefined : changes.description);
    }
    if (changes.active !== undefined)
        technical.active = changes.active;
    const diff = onlyChanged(before, {
        name: technical.name,
        description: technical.description ?? '',
        active: technical.active,
    });
    if (Object.keys(diff.after).length > 0) {
        await technical.save().catch(failIfDuplicate(NAME_TAKEN, 'NAME_TAKEN'));
        await writeAudit(req, {
            action: 'technical.update',
            entityType: 'Technical',
            entityId: technical.id,
            ...diff,
        });
    }
    res.json({ technical: toTechnical(technical) });
});
//# sourceMappingURL=technicals.routes.js.map