import { Manufacturer } from '../../../models/Manufacturer.js';
import { Product } from '../../../models/Product.js';
import { Seller } from '../../../models/Seller.js';
import { SellerCatalogueEntry } from '../../../models/SellerCatalogueEntry.js';
import { SellerDealership } from '../../../models/SellerDealership.js';
import { withTransaction } from '../../../db/transaction.js';
import { AppError } from '../../../shared/errors.js';
import { writeAuditLog } from '../../../shared/audit.js';
import { assertValidObjectId } from '../../../shared/objectId.js';
const LIVE_PRODUCT = { active: true, deletedAt: null };
export async function resolveCatalogueEntries(filter = {}) {
    const query = {};
    if (filter.sellerId)
        query.sellerId = filter.sellerId;
    if (filter.productId)
        query.productId = filter.productId;
    const manual = await SellerCatalogueEntry.find(query);
    const rows = manual.map((e) => ({
        sellerId: e.sellerId,
        productId: e.productId,
        skuIds: e.skuIds,
        source: 'manual',
        entryId: e._id.toString(),
        setAt: e.setAt,
        setBy: e.setBy,
    }));
    const seen = new Set(rows.map((r) => `${r.sellerId.toString()}:${r.productId.toString()}`));
    let dealerships;
    let productsByManufacturer = new Map();
    if (filter.productId) {
        const product = await Product.findOne({ _id: filter.productId, ...LIVE_PRODUCT });
        if (!product)
            return rows;
        dealerships = await SellerDealership.find({
            manufacturerId: product.manufacturerId,
            ...(filter.sellerId ? { sellerId: filter.sellerId } : {}),
        });
        productsByManufacturer.set(product.manufacturerId.toString(), [
            product,
        ]);
    }
    else {
        dealerships = await SellerDealership.find(filter.sellerId ? { sellerId: filter.sellerId } : {});
        if (dealerships.length === 0)
            return rows;
        const products = await Product.find({
            manufacturerId: { $in: [...new Set(dealerships.map((d) => d.manufacturerId.toString()))] },
            ...LIVE_PRODUCT,
        });
        productsByManufacturer = new Map();
        for (const p of products) {
            const key = p.manufacturerId.toString();
            if (!productsByManufacturer.has(key))
                productsByManufacturer.set(key, []);
            productsByManufacturer.get(key).push(p);
        }
    }
    for (const d of dealerships) {
        for (const p of productsByManufacturer.get(d.manufacturerId.toString()) ?? []) {
            const key = `${d.sellerId.toString()}:${p._id.toString()}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            rows.push({
                sellerId: d.sellerId,
                productId: p._id,
                skuIds: [],
                source: 'dealership',
                entryId: null,
                setAt: d.updatedAt,
                setBy: d.setBy ?? null,
            });
        }
    }
    return rows;
}
/** The companies he deals in, with how many products each brings. */
export async function getSellerDealerships(sellerId) {
    assertValidObjectId(sellerId, 'sellerId');
    const dealerships = await SellerDealership.find({ sellerId });
    if (dealerships.length === 0)
        return [];
    const manufacturerIds = dealerships.map((d) => d.manufacturerId);
    const [manufacturers, counts] = await Promise.all([
        Manufacturer.find({ _id: { $in: manufacturerIds } }),
        Product.aggregate([
            { $match: { manufacturerId: { $in: manufacturerIds }, ...LIVE_PRODUCT } },
            { $group: { _id: '$manufacturerId', n: { $sum: 1 } } },
        ]),
    ]);
    const countById = new Map(counts.map((c) => [c._id.toString(), c.n]));
    return manufacturers
        .map((m) => ({
        manufacturerId: m._id.toString(),
        name: m.name,
        state: m.state,
        productCount: countById.get(m._id.toString()) ?? 0,
    }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
/**
 * Replaces his whole set of companies with `manufacturerIds` — the tick list
 * is saved as a whole, so ticking, unticking and "no change" are all one call.
 * Only the difference is written, and it is audit-logged.
 */
export async function setSellerDealerships(sellerId, manufacturerIds, actor) {
    assertValidObjectId(sellerId, 'sellerId');
    const seller = await Seller.findById(sellerId);
    if (!seller)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller not found.' });
    const wanted = [...new Set(manufacturerIds)];
    wanted.forEach((id) => assertValidObjectId(id, 'manufacturerIds'));
    const known = await Manufacturer.find({ _id: { $in: wanted } }, { _id: 1 });
    if (known.length !== wanted.length) {
        throw new AppError({
            code: 'VALIDATION_FAILED',
            messageEn: 'One of those companies does not exist.',
            field: 'manufacturerIds',
        });
    }
    const current = await SellerDealership.find({ sellerId });
    const currentIds = new Set(current.map((d) => d.manufacturerId.toString()));
    const wantedSet = new Set(wanted);
    const toAdd = wanted.filter((id) => !currentIds.has(id));
    const toRemove = [...currentIds].filter((id) => !wantedSet.has(id));
    if (toAdd.length > 0 || toRemove.length > 0) {
        await withTransaction(async (session) => {
            if (toRemove.length > 0) {
                await SellerDealership.deleteMany({ sellerId, manufacturerId: { $in: toRemove } }, { session });
            }
            if (toAdd.length > 0) {
                await SellerDealership.create(toAdd.map((manufacturerId) => ({ sellerId, manufacturerId, setBy: actor.employeeId })), { session, ordered: true });
            }
            await writeAuditLog({
                actorId: actor.employeeId,
                actorType: 'staff',
                entity: 'seller',
                entityId: sellerId,
                field: 'dealerships',
                oldValue: [...currentIds].sort(),
                newValue: [...wantedSet].sort(),
                correlationId: actor.correlationId,
            }, session);
        });
    }
    return getSellerDealerships(sellerId);
}
