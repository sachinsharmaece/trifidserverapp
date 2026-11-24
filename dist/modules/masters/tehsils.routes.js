import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { TehsilModel } from '../../models/index.js';
import { onlyChanged, writeAudit } from '../../shared/audit.js';
import { notFound } from '../../shared/errors.js';
import { escapeRegex, failIfDuplicate } from '../../shared/mongo.js';
import { PINCODE_PATTERN, normaliseKey } from '../../shared/validators.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { nameField } from './fields.js';
import { canEditMasters } from './permissions.js';
/** A tehsil is a sub-district area. Buyers and sellers are placed in one, so it is picked from this list. */
export const tehsilsRouter = Router();
const TEHSIL_TAKEN = 'This tehsil already exists in that state and district.';
const state = nameField('the state', 60);
const district = nameField('the district', 80);
const name = nameField('the tehsil name', 80);
/** The 6-digit pincodes this tehsil covers. Repeats are dropped. */
const pincodes = z
    .array(z.string().trim().regex(PINCODE_PATTERN, 'A pincode has 6 digits and does not start with 0.'))
    .max(100, 'At most 100 pincodes.')
    .transform((list) => [...new Set(list)].sort());
const createBody = z.object({ state, district, name, pincodes: pincodes.default([]) });
const updateBody = z
    .object({ state, district, name, pincodes, active: z.boolean() })
    .partial()
    .refine((body) => Object.keys(body).length > 0, 'Nothing to change.');
const listQuery = z.object({
    q: z.string().trim().max(100).default(''),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    /** `true` lists only active tehsils (what a buyer or seller form offers), `false` only turned-off ones. */
    active: z.enum(['true', 'false']).optional(),
});
function toTehsil(tehsil) {
    return {
        id: tehsil.id,
        state: tehsil.state,
        district: tehsil.district,
        name: tehsil.name,
        pincodes: [...tehsil.pincodes],
        active: tehsil.active,
    };
}
async function findTehsil(id) {
    if (!isValidObjectId(id))
        throw notFound('Tehsil not found.');
    const tehsil = await TehsilModel.findById(id);
    if (!tehsil)
        throw notFound('Tehsil not found.');
    return tehsil;
}
tehsilsRouter.use('/tehsils', requireAuth);
/**
 * GET /tehsils?q=&page=&pageSize=&active=  ->  { tehsils, total, page, pageSize }
 * `q` is either a 6-digit pincode, or part of the state, district or tehsil name. Sorted by state, district, name.
 * There can be thousands of tehsils, so the server searches and pages.
 */
tehsilsRouter.get('/tehsils', async (req, res) => {
    const { q, page, pageSize, active } = listQuery.parse(req.query);
    const search = normaliseKey(q);
    // `key` holds "state|district|name" in lower case, so one search covers all three.
    const filter = {
        ...(!search
            ? {}
            : PINCODE_PATTERN.test(search)
                ? { pincodes: search }
                : { key: { $regex: escapeRegex(search) } }),
        ...(active ? { active: active === 'true' } : {}),
    };
    const [total, tehsils] = await Promise.all([
        TehsilModel.countDocuments(filter),
        TehsilModel.find(filter)
            .sort({ key: 1 })
            .skip((page - 1) * pageSize)
            .limit(pageSize),
    ]);
    res.json({ tehsils: tehsils.map(toTehsil), total, page, pageSize });
});
/** POST /tehsils  { state, district, name, pincodes? }  ->  201 { tehsil } */
tehsilsRouter.post('/tehsils', canEditMasters, async (req, res) => {
    const body = createBody.parse(req.body);
    const tehsil = await TehsilModel.create({ ...body, createdBy: currentUserOf(req).id }).catch(failIfDuplicate(TEHSIL_TAKEN, 'TEHSIL_TAKEN'));
    await writeAudit(req, {
        action: 'tehsil.create',
        entityType: 'Tehsil',
        entityId: tehsil.id,
        before: {},
        after: { state: tehsil.state, district: tehsil.district, name: tehsil.name },
    });
    res.status(201).json({ tehsil: toTehsil(tehsil) });
});
/**
 * PATCH /tehsils/:id  { state?, district?, name?, pincodes?, active? }  ->  { tehsil }.
 * Not built yet: turning a tehsil off should be refused while buyers or sellers use it (ARCH §B9);
 * there are no buyers or sellers yet.
 */
tehsilsRouter.patch('/tehsils/:id', canEditMasters, async (req, res) => {
    const changes = updateBody.parse(req.body);
    const tehsil = await findTehsil(req.params.id);
    const snapshot = () => ({
        state: tehsil.state,
        district: tehsil.district,
        name: tehsil.name,
        pincodes: [...tehsil.pincodes],
        active: tehsil.active,
    });
    const before = snapshot();
    tehsil.set(changes);
    const diff = onlyChanged(before, snapshot());
    if (Object.keys(diff.after).length > 0) {
        await tehsil.save().catch(failIfDuplicate(TEHSIL_TAKEN, 'TEHSIL_TAKEN'));
        await writeAudit(req, {
            action: 'tehsil.update',
            entityType: 'Tehsil',
            entityId: tehsil.id,
            ...diff,
        });
    }
    res.json({ tehsil: toTehsil(tehsil) });
});
//# sourceMappingURL=tehsils.routes.js.map