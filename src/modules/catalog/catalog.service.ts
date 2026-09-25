import type { Types } from 'mongoose';
import { Manufacturer } from '../../models/Manufacturer.js';
import { Product } from '../../models/Product.js';
import { Sku } from '../../models/Sku.js';
import { AppError } from '../../shared/errors.js';

/**
 * New — not in the original API_CONTRACT.md. Nothing else creates a
 * `Manufacturer` row: `API-024` only covers products, which require a
 * `manufacturerId` that already exists. Without this, the product masters
 * screen would have no way to populate its manufacturer picker.
 */
export async function createManufacturer(name: string): Promise<{ manufacturerId: string }> {
  const existing = await Manufacturer.findOne({ name });
  if (existing) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This manufacturer already exists.',
      field: 'name',
    });
  }
  const manufacturer = await Manufacturer.create({ name });
  return { manufacturerId: (manufacturer._id as Types.ObjectId).toString() };
}

export async function listAllManufacturers(): Promise<
  Array<{ manufacturerId: string; name: string; state: string }>
> {
  const manufacturers = await Manufacturer.find({ active: true }).sort({ name: 1 });
  return manufacturers.map((manufacturer) => ({
    manufacturerId: (manufacturer._id as Types.ObjectId).toString(),
    name: manufacturer.name,
    state: manufacturer.state,
  }));
}

/**
 * Admin's rename/confirm on a manufacturer. `state` only ever moves
 * draft → live here — there is no code path back to draft (same shape as
 * `updateSku`'s immutable-`baseUnit` guarantee: one direction, enforced by
 * having no other caller, not by a schema rule).
 */
export async function updateManufacturer(
  manufacturerId: string,
  updates: { name?: string; state?: 'live' },
): Promise<{ manufacturerId: string }> {
  const manufacturer = await Manufacturer.findByIdAndUpdate(
    manufacturerId,
    { $set: updates },
    { new: true },
  );
  if (!manufacturer) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Manufacturer not found.' });
  }
  return { manufacturerId: (manufacturer._id as Types.ObjectId).toString() };
}

// API-020 — step 1 of the one picker (BR-111). Technical is the primary
// axis everywhere.
export async function listTechnicals(): Promise<string[]> {
  const technicals = await Product.distinct('technical', { active: true, deletedAt: null });
  return (technicals as string[]).sort();
}

// API-021 — step 2.
export async function listManufacturersForTechnical(
  technical: string,
): Promise<Array<{ manufacturerId: string; name: string }>> {
  const manufacturerIds = await Product.distinct('manufacturerId', {
    technical,
    active: true,
    deletedAt: null,
  });
  const manufacturers = await Manufacturer.find({
    _id: { $in: manufacturerIds },
    active: true,
  }).sort({
    name: 1,
  });
  return manufacturers.map((manufacturer) => ({
    manufacturerId: (manufacturer._id as Types.ObjectId).toString(),
    name: manufacturer.name,
  }));
}

// API-022 — step 3.
export async function listProducts(
  technical: string,
  manufacturerId?: string,
): Promise<Array<{ productId: string; brand: string; hsn: string; class: string }>> {
  const query: Record<string, unknown> = { technical, active: true, deletedAt: null };
  if (manufacturerId) query.manufacturerId = manufacturerId;
  const products = await Product.find(query).sort({ brand: 1 });
  return products.map((product) => ({
    productId: (product._id as Types.ObjectId).toString(),
    brand: product.brand,
    hsn: product.hsn,
    class: product.class,
  }));
}

interface ProductListItem {
  productId: string;
  brand: string;
  technical: string;
  manufacturerId: string;
  manufacturerName?: string;
  hsn: string;
  class: string;
  active: boolean;
  state: string;
  createdBy: string | null;
}

// New — the admin catalog-management screen's own unfiltered list (not
// BR-111's counterparty picker, see catalog.validation.ts's own note).
// Cursor-paginated on `_id`, same pattern as `listRegistrations`.
export async function listAllProducts(
  cursor: string | undefined,
  limit: number,
): Promise<{ items: ProductListItem[]; nextCursor?: string }> {
  const query: Record<string, unknown> = { deletedAt: null };
  if (cursor) query._id = { $gt: cursor };

  const products = await Product.find(query)
    .sort({ _id: 1 })
    .limit(limit + 1);

  const hasMore = products.length > limit;
  const page = hasMore ? products.slice(0, limit) : products;

  const manufacturers = await Manufacturer.find({
    _id: { $in: page.map((product) => product.manufacturerId) },
  });
  const manufacturerNameById = new Map(
    manufacturers.map((manufacturer) => [
      (manufacturer._id as Types.ObjectId).toString(),
      manufacturer.name,
    ]),
  );

  const items = page.map((product) => ({
    productId: (product._id as Types.ObjectId).toString(),
    brand: product.brand,
    technical: product.technical,
    manufacturerId: (product.manufacturerId as unknown as Types.ObjectId).toString(),
    manufacturerName: manufacturerNameById.get(
      (product.manufacturerId as unknown as Types.ObjectId).toString(),
    ),
    hsn: product.hsn,
    class: product.class,
    active: product.active,
    state: product.state,
    createdBy: product.createdBy
      ? (product.createdBy as unknown as Types.ObjectId).toString()
      : null,
  }));

  const nextCursor = hasMore
    ? (page[page.length - 1]!._id as Types.ObjectId).toString()
    : undefined;
  return { items, nextCursor };
}

// New — the detail/edit screen's own read; API-022's `listProducts` above
// stays the technical-scoped picker.
export async function getProductById(productId: string): Promise<ProductListItem> {
  const product = await Product.findOne({ _id: productId, deletedAt: null });
  if (!product) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Product not found.' });
  }
  const manufacturer = await Manufacturer.findById(product.manufacturerId);
  return {
    productId: (product._id as Types.ObjectId).toString(),
    brand: product.brand,
    technical: product.technical,
    manufacturerId: (product.manufacturerId as unknown as Types.ObjectId).toString(),
    manufacturerName: manufacturer?.name,
    hsn: product.hsn,
    class: product.class,
    active: product.active,
    state: product.state,
    createdBy: product.createdBy
      ? (product.createdBy as unknown as Types.ObjectId).toString()
      : null,
  };
}

interface SkuListItem {
  skuId: string;
  packLabel: string;
  packSize: number;
  baseUnit: string;
  unitsPerBox: number;
  baseUnitsPerBox: number;
  active: boolean;
  state: string;
}

// API-023.
export async function listSkusForProduct(productId: string): Promise<SkuListItem[]> {
  const skus = await Sku.find({ productId, active: true, deletedAt: null }).sort({ packLabel: 1 });
  return skus.map((sku) => ({
    skuId: (sku._id as Types.ObjectId).toString(),
    packLabel: sku.packLabel,
    packSize: sku.packSize,
    baseUnit: sku.baseUnit,
    unitsPerBox: sku.unitsPerBox,
    active: sku.active,
    baseUnitsPerBox: sku.baseUnitsPerBox,
    state: sku.state,
  }));
}

interface CreateProductInput {
  brand: string;
  technical: string;
  manufacturerId: string;
  hsn: string;
  class?: 'A' | 'B' | 'C';
}

// API-024 POST.
export async function createProduct(input: CreateProductInput): Promise<{ productId: string }> {
  const manufacturer = await Manufacturer.findById(input.manufacturerId);
  if (!manufacturer) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Manufacturer not found.',
      field: 'manufacturerId',
    });
  }
  const product = await Product.create(input);
  return { productId: (product._id as Types.ObjectId).toString() };
}

// API-024 PATCH. `state` only ever moves draft → live (Admin's confirm
// action) — never accepted going the other way, same one-direction shape
// as `updateManufacturer` above.
export async function updateProduct(
  productId: string,
  updates: Partial<CreateProductInput> & { active?: boolean; state?: 'live' },
): Promise<{ productId: string }> {
  const product = await Product.findByIdAndUpdate(productId, { $set: updates }, { new: true });
  if (!product) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Product not found.' });
  }
  return { productId: (product._id as Types.ObjectId).toString() };
}

// ---------------------------------------------------------------------------
// Purchase-desk v2, LOCK-26-style amendment — Purchase may raise a draft
// company/product/pack mid-call (`CATALOG_DRAFT_CREATE`), separately from
// Admin's own `createManufacturer`/`createProduct`/`importSkus` above, which
// stay untouched and always create `state: 'live'` rows. A draft is usable
// in a seller's catalogue at once (`purchase.service.ts`'s catalogue-entry
// writes place no state check on it) but cannot back a live listing — see
// `listing.service.ts#createListing`'s guard — until Admin calls
// `updateManufacturer`/`updateProduct`/`updateSku` with `state: 'live'`.
// Near-duplicate detection is deliberately not a backend concern: the
// desk's own screen matches the typed name against the already-fetched
// `listAllManufacturers`/`getAllProducts` lists client-side, the same way
// the prototype this was designed against does it.
// ---------------------------------------------------------------------------

export async function createManufacturerDraft(
  name: string,
  createdBy: string,
): Promise<{ manufacturerId: string }> {
  const existing = await Manufacturer.findOne({ name });
  if (existing) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'This manufacturer already exists.',
      field: 'name',
    });
  }
  const manufacturer = await Manufacturer.create({ name, state: 'draft', createdBy });
  return { manufacturerId: (manufacturer._id as Types.ObjectId).toString() };
}

export async function createProductDraft(
  input: CreateProductInput,
  createdBy: string,
): Promise<{ productId: string }> {
  const manufacturer = await Manufacturer.findById(input.manufacturerId);
  if (!manufacturer) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Manufacturer not found.',
      field: 'manufacturerId',
    });
  }
  const product = await Product.create({ ...input, state: 'draft', createdBy });
  return { productId: (product._id as Types.ObjectId).toString() };
}

interface CreateSkuDraftInput {
  productId: string;
  packLabel: string;
  packSize: number;
  baseUnit: 'LTR' | 'KG' | 'PC';
  unitsPerBox: number;
}

export async function createSkuDraft(
  input: CreateSkuDraftInput,
  createdBy: string,
): Promise<{ skuId: string; baseUnitsPerBox: number }> {
  const product = await Product.findById(input.productId);
  if (!product) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      messageEn: 'Product not found.',
      field: 'productId',
    });
  }
  const sku = await Sku.create({ ...input, state: 'draft', createdBy });
  return {
    skuId: (sku._id as Types.ObjectId).toString(),
    baseUnitsPerBox: sku.baseUnitsPerBox,
  };
}

export interface ProductLiteItem {
  productId: string;
  brand: string;
  technical: string;
  manufacturerName: string;
  state: string;
}

/**
 * Purchase-desk v2 — the near-duplicate check on "Add a product" needs every
 * product's name, not one technical's slice of it (API-022's own scope,
 * BR-111). Deliberately unpaginated, same "kept deliberately small" scale
 * reasoning as `listAllProducts` above — revisit if that stops being true.
 */
export async function listAllProductsLite(): Promise<ProductLiteItem[]> {
  const products = await Product.find({ deletedAt: null }).sort({ brand: 1 });
  const manufacturers = await Manufacturer.find({});
  const manufacturerById = new Map(
    manufacturers.map((m) => [(m._id as Types.ObjectId).toString(), m]),
  );
  return products.map((p) => ({
    productId: (p._id as Types.ObjectId).toString(),
    brand: p.brand,
    technical: p.technical,
    manufacturerName:
      manufacturerById.get((p.manufacturerId as unknown as Types.ObjectId).toString())?.name ?? '—',
    state: p.state,
  }));
}

export interface DraftMasterItem {
  kind: 'manufacturer' | 'product' | 'sku';
  id: string;
  name: string;
  createdBy: string | null;
  createdAt: Date;
}

/** Products→Master tab's "waiting on Admin" panel — every draft row, across all three models. */
export async function listDraftMasters(): Promise<DraftMasterItem[]> {
  const [manufacturers, products, skus] = await Promise.all([
    Manufacturer.find({ state: 'draft' }).sort({ createdAt: -1 }),
    Product.find({ state: 'draft' }).sort({ createdAt: -1 }),
    Sku.find({ state: 'draft' }).sort({ createdAt: -1 }),
  ]);
  const productById = new Map(products.map((p) => [(p._id as Types.ObjectId).toString(), p]));
  const skuProducts = await Product.find({
    _id: { $in: skus.map((s) => s.productId).filter((id) => !productById.has(id.toString())) },
  });
  for (const p of skuProducts) productById.set((p._id as Types.ObjectId).toString(), p);

  return [
    ...manufacturers.map((m) => ({
      kind: 'manufacturer' as const,
      id: (m._id as Types.ObjectId).toString(),
      name: m.name,
      createdBy: m.createdBy ? (m.createdBy as unknown as Types.ObjectId).toString() : null,
      createdAt: m.createdAt as Date,
    })),
    ...products.map((p) => ({
      kind: 'product' as const,
      id: (p._id as Types.ObjectId).toString(),
      name: p.brand,
      createdBy: p.createdBy ? (p.createdBy as unknown as Types.ObjectId).toString() : null,
      createdAt: p.createdAt as Date,
    })),
    ...skus.map((s) => {
      const product = productById.get((s.productId as unknown as Types.ObjectId).toString());
      return {
        kind: 'sku' as const,
        id: (s._id as Types.ObjectId).toString(),
        name: `${product?.brand ?? '—'} ${s.packLabel}`,
        createdBy: s.createdBy ? (s.createdBy as unknown as Types.ObjectId).toString() : null,
        createdAt: s.createdAt as Date,
      };
    }),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

interface UpdateSkuInput {
  packLabel?: string;
  packSize?: number;
  unitsPerBox?: number;
  active?: boolean;
}

/**
 * New — the Manage desk's own SKU edit. `baseUnit` is deliberately not an
 * accepted field here at all (BR-055, `models/Sku.ts`'s own `immutable:
 * true`) — there is no code path that can change it, not even this one.
 * Fetched and `.save()`d rather than `findByIdAndUpdate`, so the model's own
 * `pre('validate')` hook recomputes `baseUnitsPerBox` from the new
 * `packSize`/`unitsPerBox` — a `$set` update would leave it stale.
 */
export async function updateSku(
  skuId: string,
  updates: UpdateSkuInput & { state?: 'live' },
): Promise<{ skuId: string; baseUnitsPerBox: number }> {
  const sku = await Sku.findById(skuId);
  if (!sku) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'SKU not found.' });
  }

  if (updates.packLabel !== undefined) sku.packLabel = updates.packLabel;
  if (updates.packSize !== undefined) sku.packSize = updates.packSize;
  if (updates.unitsPerBox !== undefined) sku.unitsPerBox = updates.unitsPerBox;
  if (updates.active !== undefined) sku.active = updates.active;
  if (updates.state !== undefined) sku.state = updates.state;
  await sku.save();

  return { skuId: (sku._id as Types.ObjectId).toString(), baseUnitsPerBox: sku.baseUnitsPerBox };
}

interface SkuImportRow {
  packLabel: string;
  packSize: unknown;
  baseUnit: unknown;
  unitsPerBox: unknown;
}

interface SkuImportRowResult {
  index: number;
  accepted: boolean;
  skuId?: string;
  reason?: string;
}

const VALID_BASE_UNITS = new Set(['LTR', 'KG', 'PC']);

/**
 * API-025. BR-055 — a row satisfying neither the LTR/KG pattern nor the PC
 * pattern is rejected outright, not imported with a guessed value. Every
 * row gets its own result so the operator sees exactly what failed and why
 * — never a single all-or-nothing failure for the whole file.
 */
export async function importSkus(
  productId: string,
  rows: SkuImportRow[],
): Promise<SkuImportRowResult[]> {
  const product = await Product.findById(productId);
  if (!product) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Product not found.' });
  }

  const results: SkuImportRowResult[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const baseUnit = row.baseUnit;
    const packSize = row.packSize;
    const unitsPerBox = row.unitsPerBox;

    if (typeof baseUnit !== 'string' || !VALID_BASE_UNITS.has(baseUnit)) {
      results.push({ index, accepted: false, reason: 'baseUnit must be LTR, KG or PC.' });
      continue;
    }
    if (typeof unitsPerBox !== 'number' || !Number.isFinite(unitsPerBox) || unitsPerBox <= 0) {
      results.push({ index, accepted: false, reason: 'unitsPerBox must be a positive number.' });
      continue;
    }
    if (typeof packSize !== 'number' || !Number.isFinite(packSize) || packSize <= 0) {
      results.push({ index, accepted: false, reason: 'packSize must be a positive number.' });
      continue;
    }

    try {
      const sku = await Sku.create({
        productId,
        packLabel: row.packLabel,
        packSize,
        baseUnit,
        unitsPerBox,
      });
      results.push({ index, accepted: true, skuId: (sku._id as Types.ObjectId).toString() });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Could not create this SKU.';
      results.push({ index, accepted: false, reason });
    }
  }

  return results;
}
