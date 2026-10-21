import type { Types } from 'mongoose';
import { Manufacturer } from '../../../models/Manufacturer.js';
import { Product } from '../../../models/Product.js';
import { Seller } from '../../../models/Seller.js';
import { SellerCatalogueEntry } from '../../../models/SellerCatalogueEntry.js';
import { SellerDealership } from '../../../models/SellerDealership.js';
import { withTransaction } from '../../../db/transaction.js';
import { AppError } from '../../../shared/errors.js';
import { writeAuditLog } from '../../../shared/audit.js';
import { assertValidObjectId } from '../../../shared/objectId.js';

/**
 * What a seller carries, in one place. Two sources feed it:
 *
 *  - `manual` — a `SellerCatalogueEntry` the desk added after a call (one
 *    product, optionally with the packs he named).
 *  - `dealership` — every active product of a company he deals in
 *    (`SellerDealership`). Derived on read, never stored per product, so a new
 *    product on the company is his at once and unticking the company takes
 *    its products away without disturbing anything entered by hand.
 *
 * Every Purchase read that asks "who carries this" / "what does he carry" goes
 * through `resolveCatalogueEntries`, so a count on one screen can never
 * disagree with a list on another. A product present in both sources is one
 * row, and the manual one wins (it may carry pack detail).
 */
export interface CatalogueRow {
  sellerId: Types.ObjectId;
  productId: Types.ObjectId;
  /** Empty = the whole product, packs not detailed. */
  skuIds: Types.ObjectId[];
  source: 'manual' | 'dealership';
  /** The `SellerCatalogueEntry` id — null for a row that exists only through a dealership. */
  entryId: string | null;
  setAt: Date;
  setBy: Types.ObjectId | null;
}

const LIVE_PRODUCT = { active: true, deletedAt: null } as const;

export async function resolveCatalogueEntries(
  filter: { sellerId?: string; productId?: string } = {},
): Promise<CatalogueRow[]> {
  const query: Record<string, string> = {};
  if (filter.sellerId) query.sellerId = filter.sellerId;
  if (filter.productId) query.productId = filter.productId;

  const manual = await SellerCatalogueEntry.find(query);
  const rows: CatalogueRow[] = manual.map((e) => ({
    sellerId: e.sellerId as Types.ObjectId,
    productId: e.productId as Types.ObjectId,
    skuIds: e.skuIds as Types.ObjectId[],
    source: 'manual',
    entryId: (e._id as Types.ObjectId).toString(),
    setAt: e.setAt,
    setBy: e.setBy as Types.ObjectId,
  }));
  const seen = new Set(rows.map((r) => `${r.sellerId.toString()}:${r.productId.toString()}`));

  let dealerships;
  let productsByManufacturer = new Map<string, Array<{ _id: Types.ObjectId }>>();
  if (filter.productId) {
    const product = await Product.findOne({ _id: filter.productId, ...LIVE_PRODUCT });
    if (!product) return rows;
    dealerships = await SellerDealership.find({
      manufacturerId: product.manufacturerId,
      ...(filter.sellerId ? { sellerId: filter.sellerId } : {}),
    });
    productsByManufacturer.set((product.manufacturerId as unknown as Types.ObjectId).toString(), [
      product as unknown as { _id: Types.ObjectId },
    ]);
  } else {
    dealerships = await SellerDealership.find(filter.sellerId ? { sellerId: filter.sellerId } : {});
    if (dealerships.length === 0) return rows;
    const products = await Product.find({
      manufacturerId: { $in: [...new Set(dealerships.map((d) => d.manufacturerId.toString()))] },
      ...LIVE_PRODUCT,
    });
    productsByManufacturer = new Map();
    for (const p of products) {
      const key = (p.manufacturerId as unknown as Types.ObjectId).toString();
      if (!productsByManufacturer.has(key)) productsByManufacturer.set(key, []);
      productsByManufacturer.get(key)!.push(p as unknown as { _id: Types.ObjectId });
    }
  }

  for (const d of dealerships) {
    for (const p of productsByManufacturer.get(d.manufacturerId.toString()) ?? []) {
      const key = `${d.sellerId.toString()}:${p._id.toString()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        sellerId: d.sellerId as Types.ObjectId,
        productId: p._id,
        skuIds: [],
        source: 'dealership',
        entryId: null,
        setAt: (d as unknown as { updatedAt: Date }).updatedAt,
        setBy: (d.setBy as Types.ObjectId | null) ?? null,
      });
    }
  }
  return rows;
}

export interface SellerDealershipItem {
  manufacturerId: string;
  name: string;
  state: string;
  /** How many live products of this company he therefore carries. */
  productCount: number;
}

/** The companies he deals in, with how many products each brings. */
export async function getSellerDealerships(sellerId: string): Promise<SellerDealershipItem[]> {
  assertValidObjectId(sellerId, 'sellerId');
  const dealerships = await SellerDealership.find({ sellerId });
  if (dealerships.length === 0) return [];
  const manufacturerIds = dealerships.map((d) => d.manufacturerId);
  const [manufacturers, counts] = await Promise.all([
    Manufacturer.find({ _id: { $in: manufacturerIds } }),
    Product.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { manufacturerId: { $in: manufacturerIds }, ...LIVE_PRODUCT } },
      { $group: { _id: '$manufacturerId', n: { $sum: 1 } } },
    ]),
  ]);
  const countById = new Map(counts.map((c) => [c._id.toString(), c.n]));
  return manufacturers
    .map((m) => ({
      manufacturerId: (m._id as Types.ObjectId).toString(),
      name: m.name,
      state: m.state,
      productCount: countById.get((m._id as Types.ObjectId).toString()) ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Replaces his whole set of companies with `manufacturerIds` — the tick list
 * is saved as a whole, so ticking, unticking and "no change" are all one call.
 * Only the difference is written, and it is audit-logged.
 */
export async function setSellerDealerships(
  sellerId: string,
  manufacturerIds: string[],
  actor: { employeeId: string; correlationId: string },
): Promise<SellerDealershipItem[]> {
  assertValidObjectId(sellerId, 'sellerId');
  const seller = await Seller.findById(sellerId);
  if (!seller) throw new AppError({ code: 'NOT_FOUND', messageEn: 'Seller not found.' });

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
        await SellerDealership.deleteMany(
          { sellerId, manufacturerId: { $in: toRemove } },
          { session },
        );
      }
      if (toAdd.length > 0) {
        await SellerDealership.create(
          toAdd.map((manufacturerId) => ({ sellerId, manufacturerId, setBy: actor.employeeId })),
          { session, ordered: true },
        );
      }
      await writeAuditLog(
        {
          actorId: actor.employeeId,
          actorType: 'staff',
          entity: 'seller',
          entityId: sellerId,
          field: 'dealerships',
          oldValue: [...currentIds].sort(),
          newValue: [...wantedSet].sort(),
          correlationId: actor.correlationId,
        },
        session,
      );
    });
  }
  return getSellerDealerships(sellerId);
}
