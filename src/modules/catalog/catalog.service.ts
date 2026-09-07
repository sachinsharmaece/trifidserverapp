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
  Array<{ manufacturerId: string; name: string }>
> {
  const manufacturers = await Manufacturer.find({ active: true }).sort({ name: 1 });
  return manufacturers.map((manufacturer) => ({
    manufacturerId: (manufacturer._id as Types.ObjectId).toString(),
    name: manufacturer.name,
  }));
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

interface SkuListItem {
  skuId: string;
  packLabel: string;
  packSize: number;
  baseUnit: string;
  unitsPerBox: number;
  baseUnitsPerBox: number;
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
    baseUnitsPerBox: sku.baseUnitsPerBox,
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

// API-024 PATCH.
export async function updateProduct(
  productId: string,
  updates: Partial<CreateProductInput> & { active?: boolean },
): Promise<{ productId: string }> {
  const product = await Product.findByIdAndUpdate(productId, { $set: updates }, { new: true });
  if (!product) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Product not found.' });
  }
  return { productId: (product._id as Types.ObjectId).toString() };
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
