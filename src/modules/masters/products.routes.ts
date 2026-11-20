import { Router } from 'express';
import mongoose, { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import {
  HsnCodeModel,
  ManufacturerModel,
  ProductModel,
  SkuModel,
  TechnicalModel,
} from '../../models/index.js';
import { onlyChanged, writeAudit } from '../../shared/audit.js';
import { PRODUCT_CATEGORIES, type ProductCategory } from '../../shared/enums.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { escapeRegex, failIfDuplicate } from '../../shared/mongo.js';
import { normaliseKey } from '../../shared/validators.js';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { nameField } from './fields.js';
import { canEditMasters } from './permissions.js';
import { packBody, toSku } from './skus.routes.js';

export const productsRouter: Router = Router();

const NAME_TAKEN = 'A product with this name already exists.';

const objectId = z.string().refine(isValidObjectId, 'Choose a value from the list.');
const name = nameField('the product name', 200);
/** GST rate in basis points: 1800 means 18%. */
const taxBp = z.number().int('Use a whole number of basis points.').min(0).max(10_000);

const createBody = z.object({
  name,
  category: z.enum(PRODUCT_CATEGORIES).default('PESTICIDE'),
  manufacturerId: objectId,
  technicalId: objectId,
  hsnCodeId: objectId,
  /** Leave it out to use the HSN code's GST rate. */
  taxBp: taxBp.optional(),
  /** A product always starts with at least one pack. */
  skus: z.array(packBody).min(1, 'Add at least one pack.').max(20),
});
const updateBody = z
  .object({
    name,
    category: z.enum(PRODUCT_CATEGORIES),
    manufacturerId: objectId,
    technicalId: objectId,
    hsnCodeId: objectId,
    taxBp,
    active: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to change.');

const listQuery = z.object({
  q: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

function toProduct(product: {
  id: string;
  name: string;
  category: ProductCategory;
  manufacturerId: unknown;
  technicalId: unknown;
  hsnCodeId: unknown;
  taxBp: number;
  active: boolean;
}) {
  return {
    id: product.id,
    name: product.name,
    category: product.category,
    manufacturerId: String(product.manufacturerId),
    technicalId: String(product.technicalId),
    hsnCodeId: String(product.hsnCodeId),
    taxBp: product.taxBp,
    active: product.active,
  };
}

async function findProduct(id: string) {
  if (!isValidObjectId(id)) throw notFound('Product not found.');
  const product = await ProductModel.findById(id);
  if (!product) throw notFound('Product not found.');
  return product;
}

/** Checks the chosen manufacturer, technical and HSN code exist and are active. Returns the HSN code. */
async function checkMasters(ids: {
  manufacturerId?: string | undefined;
  technicalId?: string | undefined;
  hsnCodeId?: string | undefined;
}) {
  if (ids.manufacturerId) {
    const manufacturer = await ManufacturerModel.findById(ids.manufacturerId);
    if (!manufacturer?.active) throw badRequest('Choose an active manufacturer.');
  }
  if (ids.technicalId) {
    const technical = await TechnicalModel.findById(ids.technicalId);
    if (!technical?.active) throw badRequest('Choose an active technical.');
  }
  if (ids.hsnCodeId) {
    const hsn = await HsnCodeModel.findById(ids.hsnCodeId);
    if (!hsn?.active) throw badRequest('Choose an active HSN code.');
    return hsn;
  }
  return null;
}

/** The new id if it differs from what the product has now, otherwise undefined (nothing to check). */
function ifChanged(newId: string | undefined, currentId: unknown): string | undefined {
  return newId !== undefined && newId !== String(currentId) ? newId : undefined;
}

productsRouter.use('/products', requireAuth);

/**
 * GET /products?q=&page=&pageSize=  ->  { products, total, page, pageSize }
 * Each product comes with its packs. `q` searches the product name. A to Z.
 */
productsRouter.get('/products', async (req, res) => {
  const { q, page, pageSize } = listQuery.parse(req.query);
  const search = normaliseKey(q);
  const filter = search ? { nameLower: { $regex: escapeRegex(search) } } : {};

  const [total, products] = await Promise.all([
    ProductModel.countDocuments(filter),
    ProductModel.find(filter)
      .sort({ nameLower: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize),
  ]);
  const skus = await SkuModel.find({ productId: { $in: products.map((p) => p._id) } }).sort({
    packLabelLower: 1,
  });

  res.json({
    products: products.map((product) => ({
      ...toProduct(product),
      skus: skus.filter((sku) => sku.productId.equals(product._id)).map(toSku),
    })),
    total,
    page,
    pageSize,
  });
});

/** GET /products/:id  ->  { product } (with its packs) */
productsRouter.get('/products/:id', async (req, res) => {
  const product = await findProduct(req.params.id);
  const skus = await SkuModel.find({ productId: product._id }).sort({ packLabelLower: 1 });
  res.json({ product: { ...toProduct(product), skus: skus.map(toSku) } });
});

/**
 * POST /products  { name, category?, manufacturerId, technicalId, hsnCodeId, taxBp?, skus: [...] }
 *   ->  201 { product }.
 * The product and its first packs are saved together: either all of them exist afterwards or none.
 */
productsRouter.post('/products', canEditMasters, async (req, res) => {
  const body = createBody.parse(req.body);
  const hsn = await checkMasters(body);
  if (!hsn) throw badRequest('Choose an HSN code.');

  const packLabels = body.skus.map((sku) => normaliseKey(sku.packLabel));
  if (new Set(packLabels).size !== packLabels.length) {
    throw badRequest('Two packs have the same label. Each pack label can be used once.');
  }

  const actorId = currentUserOf(req).id;
  const created = await mongoose.connection.transaction(async (session) => {
    const [product] = await ProductModel.create(
      [
        {
          name: body.name,
          category: body.category,
          manufacturerId: body.manufacturerId,
          technicalId: body.technicalId,
          hsnCodeId: body.hsnCodeId,
          taxBp: body.taxBp ?? hsn.gstBp,
          createdBy: actorId,
        },
      ],
      { session },
    ).catch(failIfDuplicate(NAME_TAKEN, 'NAME_TAKEN'));
    if (!product) throw new Error('Product was not created.');

    const skus = await SkuModel.create(
      body.skus.map((sku) => ({ ...sku, productId: product._id, createdBy: actorId })),
      { session, ordered: true }, // Mongoose requires `ordered` to create several documents in a transaction
    );
    await writeAudit(req, {
      action: 'product.create',
      entityType: 'Product',
      entityId: product.id,
      before: {},
      after: { name: product.name, taxBp: product.taxBp, packs: body.skus.length },
      session,
    });
    return { product, skus };
  });

  res
    .status(201)
    .json({ product: { ...toProduct(created.product), skus: created.skus.map(toSku) } });
});

/**
 * PATCH /products/:id  { name?, category?, manufacturerId?, technicalId?, hsnCodeId?, taxBp?, active? }
 *   ->  { product }.
 * Changing the HSN code does not change the tax rate by itself: send `taxBp` too if it should change.
 */
productsRouter.patch('/products/:id', canEditMasters, async (req, res) => {
  const changes = updateBody.parse(req.body);
  const product = await findProduct(req.params.id);
  // Only newly chosen values must be active: a product may keep a manufacturer that was turned off later.
  await checkMasters({
    manufacturerId: ifChanged(changes.manufacturerId, product.manufacturerId),
    technicalId: ifChanged(changes.technicalId, product.technicalId),
    hsnCodeId: ifChanged(changes.hsnCodeId, product.hsnCodeId),
  });

  const snapshot = () => ({
    name: product.name,
    category: product.category,
    manufacturerId: String(product.manufacturerId),
    technicalId: String(product.technicalId),
    hsnCodeId: String(product.hsnCodeId),
    taxBp: product.taxBp,
    active: product.active,
  });
  const before = snapshot();
  product.set(changes);
  const diff = onlyChanged(before, snapshot());

  if (Object.keys(diff.after).length > 0) {
    await product.save().catch(failIfDuplicate(NAME_TAKEN, 'NAME_TAKEN'));
    await writeAudit(req, {
      action: 'product.update',
      entityType: 'Product',
      entityId: product.id,
      ...diff,
    });
  }
  const skus = await SkuModel.find({ productId: product._id }).sort({ packLabelLower: 1 });
  res.json({ product: { ...toProduct(product), skus: skus.map(toSku) } });
});
