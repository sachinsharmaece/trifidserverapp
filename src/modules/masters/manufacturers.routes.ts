import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { ManufacturerModel } from '../../models/index.js';
import { onlyChanged, writeAudit } from '../../shared/audit.js';
import { notFound } from '../../shared/errors.js';
import { failIfDuplicate } from '../../shared/mongo.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { nameField } from './fields.js';
import { canEditMasters } from './permissions.js';

export const manufacturersRouter: Router = Router();

const NAME_TAKEN = 'A manufacturer with this name already exists.';

const name = nameField('the manufacturer name');
const createBody = z.object({ name });
const updateBody = z
  .object({ name, active: z.boolean() })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to change.');

function toManufacturer(manufacturer: { id: string; name: string; active: boolean }) {
  return { id: manufacturer.id, name: manufacturer.name, active: manufacturer.active };
}

async function findManufacturer(id: string) {
  if (!isValidObjectId(id)) throw notFound('Manufacturer not found.');
  const manufacturer = await ManufacturerModel.findById(id);
  if (!manufacturer) throw notFound('Manufacturer not found.');
  return manufacturer;
}

manufacturersRouter.use('/manufacturers', requireAuth);

/** GET /manufacturers  ->  { manufacturers }, every one (active and turned off), A to Z. */
manufacturersRouter.get('/manufacturers', async (_req, res) => {
  const manufacturers = await ManufacturerModel.find().sort({ nameLower: 1 });
  res.json({ manufacturers: manufacturers.map(toManufacturer) });
});

/** POST /manufacturers  { name }  ->  201 { manufacturer } */
manufacturersRouter.post('/manufacturers', canEditMasters, async (req, res) => {
  const body = createBody.parse(req.body);
  const manufacturer = await ManufacturerModel.create({
    name: body.name,
    createdBy: currentUserOf(req).id,
  }).catch(failIfDuplicate(NAME_TAKEN, 'NAME_TAKEN'));

  await writeAudit(req, {
    action: 'manufacturer.create',
    entityType: 'Manufacturer',
    entityId: manufacturer.id,
    before: {},
    after: { name: manufacturer.name },
  });
  res.status(201).json({ manufacturer: toManufacturer(manufacturer) });
});

/** PATCH /manufacturers/:id  { name?, active? }  ->  { manufacturer }. Never deleted: turn it off instead. */
manufacturersRouter.patch('/manufacturers/:id', canEditMasters, async (req, res) => {
  const changes = updateBody.parse(req.body);
  const manufacturer = await findManufacturer(req.params.id);

  const before = { name: manufacturer.name, active: manufacturer.active };
  if (changes.name !== undefined) manufacturer.name = changes.name;
  if (changes.active !== undefined) manufacturer.active = changes.active;
  const diff = onlyChanged(before, { name: manufacturer.name, active: manufacturer.active });

  if (Object.keys(diff.after).length > 0) {
    await manufacturer.save().catch(failIfDuplicate(NAME_TAKEN, 'NAME_TAKEN'));
    await writeAudit(req, {
      action: 'manufacturer.update',
      entityType: 'Manufacturer',
      entityId: manufacturer.id,
      ...diff,
    });
  }
  res.json({ manufacturer: toManufacturer(manufacturer) });
});
