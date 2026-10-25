import { Manufacturer } from '../../models/Manufacturer.js';
import { Hsn } from '../../models/Hsn.js';
import { Product } from '../../models/Product.js';
import { Sku } from '../../models/Sku.js';
import { Technical } from '../../models/Technical.js';
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
// ---------------------------------------------------------------------------
// Technical and HSN masters. A product still stores `technical` (name) and
// `hsn` (code) as plain strings; these masters are what the admin picks from,
// and `ensureTechnical`/`ensureHsn` keep them in step whenever a product is
// written (admin or Purchase draft), so a master can never be missing a value
// a product already uses.
// ---------------------------------------------------------------------------
const CI = { locale: 'en', strength: 2 };
function isDuplicateKey(error) {
    return !!error && typeof error === 'object' && 'code' in error && error.code === 11000;
}
/** Returns the master's own spelling of `name`, creating the master row if there is none. */
async function ensureTechnical(name, createdBy) {
    const trimmed = name.trim();
    const existing = await Technical.findOne({ name: trimmed }).collation(CI);
    if (existing)
        return existing.name;
    try {
        const created = await Technical.create({
            name: trimmed,
            ...(createdBy ? { state: 'draft', createdBy } : {}),
        });
        return created.name;
    }
    catch (error) {
        // Lost a race with a concurrent create of the same name — take theirs.
        if (isDuplicateKey(error)) {
            const winner = await Technical.findOne({ name: trimmed }).collation(CI);
            if (winner)
                return winner.name;
        }
        throw error;
    }
}
/** The master's default rate for `code`, creating the master row (at the fallback) if there is none. */
async function ensureHsn(code, fallbackTaxPercent) {
    const existing = await Hsn.findOne({ code });
    if (existing)
        return existing.taxPercent;
    try {
        await Hsn.create({ code, taxPercent: fallbackTaxPercent });
    }
    catch (error) {
        if (!isDuplicateKey(error))
            throw error;
    }
    return fallbackTaxPercent;
}
export async function listTechnicalMasters() {
    const technicals = await Technical.find({ active: true }).sort({ name: 1 });
    return technicals.map((t) => ({
        technicalId: t._id.toString(),
        name: t.name,
        state: t.state,
    }));
}
export async function createTechnical(name) {
    const existing = await Technical.findOne({ name: name.trim() }).collation(CI);
    if (existing) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'This technical already exists.',
            field: 'name',
        });
    }
    const technical = await Technical.create({ name: name.trim() });
    return { technicalId: technical._id.toString() };
}
export async function listHsnMasters() {
    const rows = await Hsn.find({ active: true }).sort({ code: 1 });
    return rows.map((h) => ({
        hsnId: h._id.toString(),
        code: h.code,
        description: h.description ?? '',
        taxPercent: h.taxPercent,
    }));
}
export async function createHsn(input) {
    if (await Hsn.exists({ code: input.code })) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'This HSN already exists.',
            field: 'code',
        });
    }
    const hsn = await Hsn.create(input);
    return { hsnId: hsn._id.toString() };
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
function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * The searchable product dropdown on staff call forms: live products matched by brand or
 * technical name, no technical chosen first. Same visibility rule as `listProducts` —
 * drafts never appear as a choice. Capped, so an empty search is "the first fifty".
 */
export async function searchProducts(q, limit) {
    const query = { active: true, state: 'live', deletedAt: null };
    const term = q.trim();
    if (term) {
        const pattern = new RegExp(escapeRegex(term), 'i');
        query.$or = [{ brand: pattern }, { technical: pattern }];
    }
    const products = await Product.find(query).sort({ brand: 1 }).limit(limit);
    return products.map((product) => ({
        productId: product._id.toString(),
        brand: product.brand,
        technical: product.technical,
    }));
}
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
        category: product.category,
        taxPercent: product.taxPercent,
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
        category: product.category,
        taxPercent: product.taxPercent,
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
/**
 * BR-055 only knows LTR/KG/PC, so an ML/GM pack is stored in the base unit
 * (500 ML -> 0.5 LTR) while the label keeps what the admin typed ("500 ML").
 */
function packToSkuFields(pack) {
    const baseUnit = pack.unit === 'ML' ? 'LTR' : pack.unit === 'GM' ? 'KG' : pack.unit;
    const factor = pack.unit === 'ML' || pack.unit === 'GM' ? 1000 : 1;
    return {
        packLabel: `${pack.packSize} ${pack.unit}`,
        packSize: Math.round((pack.packSize / factor) * 1e6) / 1e6,
        baseUnit,
        unitsPerBox: pack.unitsPerBox,
    };
}
// API-024 POST. Optionally creates the product's packs (SKUs) in the same
// call. Mongo here has no multi-document transaction, so everything that can
// be checked up front is, and a failed SKU insert rolls the product back.
export async function createProduct(input) {
    const { packs = [], ...productInput } = input;
    const manufacturer = await Manufacturer.findById(input.manufacturerId);
    if (!manufacturer) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'Manufacturer not found.',
            field: 'manufacturerId',
        });
    }
    const skuRows = packs.map(packToSkuFields);
    const labels = new Set();
    for (const row of skuRows) {
        const key = row.packLabel.toLowerCase();
        if (labels.has(key)) {
            throw new AppError({
                code: 'VALIDATION_FAILED',
                messageEn: `The pack "${row.packLabel}" is listed twice.`,
                field: 'packs',
            });
        }
        labels.add(key);
    }
    const technical = await ensureTechnical(input.technical);
    const masterRate = await ensureHsn(input.hsn, input.taxPercent ?? 18);
    const product = await Product.create({
        ...productInput,
        technical,
        taxPercent: input.taxPercent ?? masterRate,
    });
    const productId = product._id.toString();
    const skuIds = [];
    try {
        for (const row of skuRows) {
            const sku = await Sku.create({ productId, ...row });
            skuIds.push(sku._id.toString());
        }
    }
    catch (error) {
        await Sku.deleteMany({ productId });
        await Product.deleteOne({ _id: productId });
        throw error;
    }
    return { productId, skuIds };
}
// API-024 PATCH. `state` only ever moves draft → live (Admin's confirm
// action) — never accepted going the other way, same one-direction shape
// as `updateManufacturer` above.
export async function updateProduct(productId, updates) {
    // The same check create makes — an edit may not point at a manufacturer
    // that does not exist.
    if (updates.manufacturerId !== undefined &&
        !(await Manufacturer.exists({ _id: updates.manufacturerId }))) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'Manufacturer not found.',
            field: 'manufacturerId',
        });
    }
    const $set = { ...updates };
    if ($set.technical !== undefined)
        $set.technical = await ensureTechnical($set.technical);
    if ($set.hsn !== undefined) {
        const masterRate = await ensureHsn($set.hsn, $set.taxPercent ?? 18);
        // Changing the HSN picks up that HSN's rate unless the caller set one.
        if ($set.taxPercent === undefined)
            $set.taxPercent = masterRate;
    }
    const product = await Product.findByIdAndUpdate(productId, { $set }, { new: true });
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
    const technical = await ensureTechnical(input.technical, createdBy);
    const taxPercent = input.taxPercent ?? (await ensureHsn(input.hsn, 18));
    const product = await Product.create({
        ...input,
        technical,
        taxPercent,
        state: 'draft',
        createdBy,
    });
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
// ---------------------------------------------------------------------------
// One pack rule for create and edit (24 Oct). A pack is typed as a size in a
// unit the admin picks — 500 ML — and stored in the base unit (0.5 LTR) with
// the label keeping what was typed. Create, "Add pack" on an existing
// product, and editing a pack all go through packToSkuFields / packOf.
// ---------------------------------------------------------------------------
/** How a stored pack reads back in the unit it was entered in: 0.5 LTR labelled "500 ML" → 500 ML. */
export function packOf(sku) {
    const small = sku.baseUnit === 'LTR' ? 'ML' : sku.baseUnit === 'KG' ? 'GM' : null;
    const match = small ? new RegExp(`^\\s*([\\d.]+)\\s*${small}\\b`, 'i').exec(sku.packLabel) : null;
    if (small && match && Math.abs(Number(match[1]) / 1000 - sku.packSize) < 1e-6) {
        return { unit: small, size: Number(match[1]) };
    }
    return { unit: sku.baseUnit, size: sku.packSize };
}
const packKey = (row) => `${row.baseUnit}:${Math.round(row.packSize * 1e6)}`;
/** The Manage desk's pack list: every pack, inactive and draft too (the pickers only show live, active ones). */
export async function listAdminSkus(productId) {
    const skus = await Sku.find({ productId, deletedAt: null }).sort({ baseUnit: 1, packSize: 1 });
    return skus.map((sku) => {
        const pack = packOf(sku);
        return {
            skuId: sku._id.toString(),
            packLabel: sku.packLabel,
            packSize: sku.packSize,
            baseUnit: sku.baseUnit,
            unitsPerBox: sku.unitsPerBox,
            active: sku.active,
            baseUnitsPerBox: sku.baseUnitsPerBox,
            state: sku.state,
            unit: pack.unit,
            displaySize: pack.size,
        };
    });
}
/** "Add pack" on an existing product — the same rule, and duplicate check, as packs given on create. */
export async function addProductPacks(productId, packs) {
    if (!(await Product.exists({ _id: productId }))) {
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Product not found.' });
    }
    const existing = await Sku.find({ productId, deletedAt: null }, { baseUnit: 1, packSize: 1, packLabel: 1 });
    const taken = new Map(existing.map((s) => [packKey(s), s.packLabel]));
    const rows = packs.map(packToSkuFields);
    for (const row of rows) {
        const clash = taken.get(packKey(row));
        if (clash) {
            throw new AppError({
                code: 'VALIDATION_FAILED',
                messageEn: `This product already has the pack "${clash}".`,
                field: 'packs',
            });
        }
        taken.set(packKey(row), row.packLabel);
    }
    const skuIds = [];
    for (const row of rows) {
        const sku = await Sku.create({ productId, ...row });
        skuIds.push(sku._id.toString());
    }
    return { skuIds };
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
    // A pack's unit is fixed once it exists (orders, stock and prices hang off
    // it): change the size in the unit it was entered in, or make it inactive
    // and add a new pack.
    if (updates.unit !== undefined) {
        const current = packOf(sku);
        if (updates.unit !== current.unit) {
            throw new AppError({
                code: 'VALIDATION_FAILED',
                messageEn: `A pack's unit cannot change (this one is ${current.unit}). Make it inactive and add a new pack.`,
                field: 'unit',
            });
        }
        if (updates.packSize !== undefined) {
            const fields = packToSkuFields({
                packSize: updates.packSize,
                unit: updates.unit,
                unitsPerBox: updates.unitsPerBox ?? sku.unitsPerBox,
            });
            const clash = await Sku.findOne({
                productId: sku.productId,
                _id: { $ne: sku._id },
                deletedAt: null,
                baseUnit: fields.baseUnit,
                packSize: fields.packSize,
            });
            if (clash) {
                throw new AppError({
                    code: 'VALIDATION_FAILED',
                    messageEn: `This product already has the pack "${clash.packLabel}".`,
                    field: 'packSize',
                });
            }
            sku.packSize = fields.packSize;
            sku.packLabel = fields.packLabel;
        }
    }
    if (updates.packLabel !== undefined && updates.unit === undefined)
        sku.packLabel = updates.packLabel;
    if (updates.packSize !== undefined && updates.unit === undefined)
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
