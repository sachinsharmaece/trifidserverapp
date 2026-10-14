import { Manufacturer } from '../../models/Manufacturer.js';
import { Product } from '../../models/Product.js';
import { Sku } from '../../models/Sku.js';
import { AppError } from '../../shared/errors.js';
import { packLabelMatchesBaseUnit } from '../../shared/validators.js';
/**
 * New — not in the original API_CONTRACT.md. Nothing else creates a
 * `Manufacturer` row: `API-024` only covers products, which require a
 * `manufacturerId` that already exists. Without this, the product masters
 * screen would have no way to populate its manufacturer picker.
 */
export async function createManufacturer(name, aka = []) {
    const existing = await Manufacturer.findOne({ name }).collation({ locale: 'en', strength: 2 });
    if (existing) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'This manufacturer already exists.',
            field: 'name',
        });
    }
    const manufacturer = await Manufacturer.create({ name, aka });
    return { manufacturerId: manufacturer._id.toString() };
}
export async function listAllManufacturers() {
    const manufacturers = await Manufacturer.find({ active: true }).sort({ name: 1 });
    return manufacturers.map((manufacturer) => ({
        manufacturerId: manufacturer._id.toString(),
        name: manufacturer.name,
        aka: manufacturer.aka,
        state: manufacturer.state,
    }));
}
/**
 * Admin's rename/confirm on a manufacturer. `state` only ever moves
 * draft → live here — there is no code path back to draft (same shape as
 * `updateSku`'s immutable-`baseUnit` guarantee: one direction, enforced by
 * having no other caller, not by a schema rule).
 */
export async function updateManufacturer(manufacturerId, updates) {
    const manufacturer = await Manufacturer.findByIdAndUpdate(manufacturerId, { $set: updates }, { new: true });
    if (!manufacturer) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Manufacturer not found.' });
    }
    return { manufacturerId: manufacturer._id.toString() };
}
// API-020 — step 1 of the one picker (BR-111). Technical is the primary
// axis everywhere.
export async function listTechnicals() {
    const technicals = await Product.distinct('technical', { active: true, deletedAt: null });
    return technicals.sort();
}
// API-021 — step 2.
export async function listManufacturersForTechnical(technical) {
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
        manufacturerId: manufacturer._id.toString(),
        name: manufacturer.name,
    }));
}
// API-022 — step 3.
export async function listProducts(technical, manufacturerId) {
    // B-22 — this feeds every technical→product→pack picker (counterparty
    // and staff-proxy alike); a draft "cannot back a live listing until Admin
    // confirms it" (listing.service.ts), so it never belongs as a choice here
    // — filtered at the source instead of by each picker re-checking `state`.
    const query = {
        technical,
        active: true,
        state: 'live',
        deletedAt: null,
    };
    if (manufacturerId)
        query.manufacturerId = manufacturerId;
    const products = await Product.find(query).sort({ brand: 1 });
    return products.map((product) => ({
        productId: product._id.toString(),
        brand: product.brand,
        hsn: product.hsn,
        class: product.class,
    }));
}
// New — the admin catalog-management screen's own unfiltered list (not
// BR-111's counterparty picker, see catalog.validation.ts's own note).
// Cursor-paginated on `_id`, same pattern as `listRegistrations`.
export async function listAllProducts(cursor, limit) {
    const query = { deletedAt: null };
    if (cursor)
        query._id = { $gt: cursor };
    const products = await Product.find(query)
        .sort({ _id: 1 })
        .limit(limit + 1);
    const hasMore = products.length > limit;
    const page = hasMore ? products.slice(0, limit) : products;
    const manufacturers = await Manufacturer.find({
        _id: { $in: page.map((product) => product.manufacturerId) },
    });
    const manufacturerNameById = new Map(manufacturers.map((manufacturer) => [
        manufacturer._id.toString(),
        manufacturer.name,
    ]));
    const items = page.map((product) => ({
        productId: product._id.toString(),
        brand: product.brand,
        technical: product.technical,
        manufacturerId: product.manufacturerId.toString(),
        manufacturerName: manufacturerNameById.get(product.manufacturerId.toString()),
        hsn: product.hsn,
        class: product.class,
        active: product.active,
        state: product.state,
        createdBy: product.createdBy
            ? product.createdBy.toString()
            : null,
    }));
    const nextCursor = hasMore
        ? page[page.length - 1]._id.toString()
        : undefined;
    return { items, nextCursor };
}
// New — the detail/edit screen's own read; API-022's `listProducts` above
// stays the technical-scoped picker.
export async function getProductById(productId) {
    const product = await Product.findOne({ _id: productId, deletedAt: null });
    if (!product) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Product not found.' });
    }
    const manufacturer = await Manufacturer.findById(product.manufacturerId);
    return {
        productId: product._id.toString(),
        brand: product.brand,
        technical: product.technical,
        manufacturerId: product.manufacturerId.toString(),
        manufacturerName: manufacturer?.name,
        hsn: product.hsn,
        class: product.class,
        active: product.active,
        state: product.state,
        createdBy: product.createdBy
            ? product.createdBy.toString()
            : null,
    };
}
// API-023.
export async function listSkusForProduct(productId) {
    // B-22 — same reasoning as `listProducts` above: this is the pack picker,
    // never the Manage desk's own draft-review list (`listAllProducts`).
    const skus = await Sku.find({ productId, active: true, state: 'live', deletedAt: null }).sort({
        packLabel: 1,
    });
    return skus.map((sku) => ({
        skuId: sku._id.toString(),
        packLabel: sku.packLabel,
        packSize: sku.packSize,
        baseUnit: sku.baseUnit,
        unitsPerBox: sku.unitsPerBox,
        active: sku.active,
        baseUnitsPerBox: sku.baseUnitsPerBox,
        state: sku.state,
    }));
}
// API-024 POST.
export async function createProduct(input) {
    const manufacturer = await Manufacturer.findById(input.manufacturerId);
    if (!manufacturer) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'Manufacturer not found.',
            field: 'manufacturerId',
        });
    }
    const product = await Product.create(input);
    return { productId: product._id.toString() };
}
// API-024 PATCH. `state` only ever moves draft → live (Admin's confirm
// action) — never accepted going the other way, same one-direction shape
// as `updateManufacturer` above.
export async function updateProduct(productId, updates) {
    const product = await Product.findByIdAndUpdate(productId, { $set: updates }, { new: true });
    if (!product) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Product not found.' });
    }
    return { productId: product._id.toString() };
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
export async function createManufacturerDraft(name, createdBy, aka = []) {
    const existing = await Manufacturer.findOne({ name }).collation({ locale: 'en', strength: 2 });
    if (existing) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'This manufacturer already exists.',
            field: 'name',
        });
    }
    const manufacturer = await Manufacturer.create({ name, aka, state: 'draft', createdBy });
    return { manufacturerId: manufacturer._id.toString() };
}
export async function createProductDraft(input, createdBy) {
    const manufacturer = await Manufacturer.findById(input.manufacturerId);
    if (!manufacturer) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'Manufacturer not found.',
            field: 'manufacturerId',
        });
    }
    const product = await Product.create({ ...input, state: 'draft', createdBy });
    return { productId: product._id.toString() };
}
export async function createSkuDraft(input, createdBy) {
    const product = await Product.findById(input.productId);
    if (!product) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'Product not found.',
            field: 'productId',
        });
    }
    let sku;
    try {
        sku = await Sku.create({ ...input, state: 'draft', createdBy });
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
            throw new AppError({
                code: 'VALIDATION_FAILED',
                messageEn: 'This pack already exists for this product.',
                field: 'packLabel',
            });
        }
        throw error;
    }
    return {
        skuId: sku._id.toString(),
        baseUnitsPerBox: sku.baseUnitsPerBox,
    };
}
/**
 * Purchase-desk v2 — the near-duplicate check on "Add a product" needs every
 * product's name, not one technical's slice of it (API-022's own scope,
 * BR-111). Deliberately unpaginated, same "kept deliberately small" scale
 * reasoning as `listAllProducts` above — revisit if that stops being true.
 */
export async function listAllProductsLite() {
    const products = await Product.find({ deletedAt: null }).sort({ brand: 1 });
    const manufacturers = await Manufacturer.find({});
    const manufacturerById = new Map(manufacturers.map((m) => [m._id.toString(), m]));
    return products.map((p) => ({
        productId: p._id.toString(),
        brand: p.brand,
        technical: p.technical,
        manufacturerName: manufacturerById.get(p.manufacturerId.toString())?.name ?? '—',
        state: p.state,
    }));
}
/** Products→Master tab's "waiting on Admin" panel — every draft row, across all three models. */
export async function listDraftMasters() {
    const [manufacturers, products, skus] = await Promise.all([
        Manufacturer.find({ state: 'draft' }).sort({ createdAt: -1 }),
        Product.find({ state: 'draft' }).sort({ createdAt: -1 }),
        Sku.find({ state: 'draft' }).sort({ createdAt: -1 }),
    ]);
    const productById = new Map(products.map((p) => [p._id.toString(), p]));
    const skuProducts = await Product.find({
        _id: { $in: skus.map((s) => s.productId).filter((id) => !productById.has(id.toString())) },
    });
    for (const p of skuProducts)
        productById.set(p._id.toString(), p);
    return [
        ...manufacturers.map((m) => ({
            kind: 'manufacturer',
            id: m._id.toString(),
            name: m.name,
            createdBy: m.createdBy ? m.createdBy.toString() : null,
            createdAt: m.createdAt,
        })),
        ...products.map((p) => ({
            kind: 'product',
            id: p._id.toString(),
            name: p.brand,
            createdBy: p.createdBy ? p.createdBy.toString() : null,
            createdAt: p.createdAt,
        })),
        ...skus.map((s) => {
            const product = productById.get(s.productId.toString());
            return {
                kind: 'sku',
                id: s._id.toString(),
                name: `${product?.brand ?? '—'} ${s.packLabel}`,
                createdBy: s.createdBy ? s.createdBy.toString() : null,
                createdAt: s.createdAt,
            };
        }),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
/**
 * New — the Manage desk's own SKU edit. `baseUnit` is deliberately not an
 * accepted field here at all (BR-055, `models/Sku.ts`'s own `immutable:
 * true`) — there is no code path that can change it, not even this one.
 * Fetched and `.save()`d rather than `findByIdAndUpdate`, so the model's own
 * `pre('validate')` hook recomputes `baseUnitsPerBox` from the new
 * `packSize`/`unitsPerBox` — a `$set` update would leave it stale.
 */
export async function updateSku(skuId, updates) {
    const sku = await Sku.findById(skuId);
    if (!sku) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'SKU not found.' });
    }
    // B-21 — the same cross-check as `importSkus`: an edited label must still
    // match this SKU's (immutable) base unit.
    if (updates.packLabel !== undefined &&
        !packLabelMatchesBaseUnit(updates.packLabel, sku.baseUnit)) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: `The pack "${updates.packLabel}" does not look like a ${sku.baseUnit} pack.`,
            field: 'packLabel',
        });
    }
    if (updates.packLabel !== undefined)
        sku.packLabel = updates.packLabel;
    if (updates.packSize !== undefined)
        sku.packSize = updates.packSize;
    if (updates.unitsPerBox !== undefined)
        sku.unitsPerBox = updates.unitsPerBox;
    if (updates.active !== undefined)
        sku.active = updates.active;
    if (updates.state !== undefined)
        sku.state = updates.state;
    await sku.save();
    return { skuId: sku._id.toString(), baseUnitsPerBox: sku.baseUnitsPerBox };
}
const VALID_BASE_UNITS = new Set(['LTR', 'KG', 'PC']);
/**
 * API-025. BR-055 — a row satisfying neither the LTR/KG pattern nor the PC
 * pattern is rejected outright, not imported with a guessed value. Every
 * row gets its own result so the operator sees exactly what failed and why
 * — never a single all-or-nothing failure for the whole file.
 */
export async function importSkus(productId, rows) {
    const product = await Product.findById(productId);
    if (!product) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Product not found.' });
    }
    const results = [];
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
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
        // B-21 — the Purchase desk's own draft-SKU path already cross-checks
        // this (`draftSkuSchema`'s superRefine); this path let "500 GM" through
        // with `baseUnit: 'LTR'` because it never called the same check.
        if (!packLabelMatchesBaseUnit(row.packLabel, baseUnit)) {
            results.push({
                index,
                accepted: false,
                reason: `The pack "${row.packLabel}" does not look like a ${baseUnit} pack.`,
            });
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
            results.push({ index, accepted: true, skuId: sku._id.toString() });
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : 'Could not create this SKU.';
            results.push({ index, accepted: false, reason });
        }
    }
    return results;
}
