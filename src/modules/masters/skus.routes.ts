import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { ProductModel, SkuModel } from '../../models/index.js';
import { onlyChanged, writeAudit } from '../../shared/audit.js';
import { SKU_CLASSES, type SkuClass } from '../../shared/enums.js';
import { notFound } from '../../shared/errors.js';
import { failIfDuplicate } from '../../shared/mongo.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { nameField } from './fields.js';
import { canEditMasters } from './permissions.js';

/** A SKU is one pack of a product ("500 ML, 20 per box"). Packs are created with their product or added later. */
export const skusRouter: Router = Router();

const PACK_TAKEN = 'This product already has a pack with this label.';

/** The fields of one pack, as the admin app sends them. */
export const packBody = z.object({
  packLabel: nameField('the pack label, like 500 ML', 40),
  unitsPerBox: z
    .number()
    .int('Units per box must be a whole number.')
    .min(1, 'There is at least 1 unit in a box.')
    .max(10_000),
  skuClass: z.enum(SKU_CLASSES),
});
const updateBody = packBody
  .partial()
  .extend({ active: z.boolean().optional() })
  .refine((body) => Object.keys(body).length > 0, 'Nothing to change.');

export function toSku(sku: {
  id: string;
  productId: unknown;
  packLabel: string;
  unitsPerBox: number;
  skuClass: SkuClass;
  active: boolean;
}) {
  return {
    id: sku.id,
    productId: String(sku.productId),
    packLabel: sku.packLabel,
    unitsPerBox: sku.unitsPerBox,
    skuClass: sku.skuClass,
    active: sku.active,
  };
}

skusRouter.use(['/skus', '/products/:id/skus'], requireAuth);

/** POST /products/:id/skus  { packLabel, unitsPerBox, skuClass }  ->  201 { sku } */
skusRouter.post('/products/:id/skus', canEditMasters, async (req, res) => {
  const body = packBody.parse(req.body);
  if (!isValidObjectId(req.params.id)) throw notFound('Product not found.');
  const product = await ProductModel.findById(req.params.id);
  if (!product) throw notFound('Product not found.');

  const sku = await SkuModel.create({
    productId: product._id,
    ...body,
    createdBy: currentUserOf(req).id,
  }).catch(failIfDuplicate(PACK_TAKEN, 'PACK_TAKEN'));

  await writeAudit(req, {
    action: 'sku.create',
    entityType: 'Sku',
    entityId: sku.id,
    before: {},
    after: { product: product.name, ...body },
  });
  res.status(201).json({ sku: toSku(sku) });
});

/**
 * PATCH /skus/:id  { packLabel?, unitsPerBox?, skuClass?, active? }  ->  { sku }.
 * Not built yet: once listings or orders use a pack, `unitsPerBox` should become read-only
 * (changing it would change the value of boxes already sold). There are no listings yet.
 */
skusRouter.patch('/skus/:id', canEditMasters, async (req, res) => {
  const changes = updateBody.parse(req.body);
  if (!isValidObjectId(req.params.id)) throw notFound('Pack not found.');
  const sku = await SkuModel.findById(req.params.id);
  if (!sku) throw notFound('Pack not found.');

  const before = {
    packLabel: sku.packLabel,
    unitsPerBox: sku.unitsPerBox,
    skuClass: sku.skuClass,
    active: sku.active,
  };
  sku.set(changes);
  const diff = onlyChanged(before, {
    packLabel: sku.packLabel,
    unitsPerBox: sku.unitsPerBox,
    skuClass: sku.skuClass,
    active: sku.active,
  });

  if (Object.keys(diff.after).length > 0) {
    await sku.save().catch(failIfDuplicate(PACK_TAKEN, 'PACK_TAKEN'));
    await writeAudit(req, { action: 'sku.update', entityType: 'Sku', entityId: sku.id, ...diff });
  }
  res.json({ sku: toSku(sku) });
});
