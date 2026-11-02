import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { Manufacturer } from '../src/models/Manufacturer.js';
import { Product } from '../src/models/Product.js';
import { Sku } from '../src/models/Sku.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { Buyer } from '../src/models/Buyer.js';
import { Ask } from '../src/models/Ask.js';
import { Listing } from '../src/models/Listing.js';
import { ListingLine } from '../src/models/ListingLine.js';
import { raiseAsk } from '../src/modules/demand/demand.service.js';
import { getActiveDemandByProduct } from '../src/modules/desk/purchase/purchase.service.js';
import { randomMobile } from './helpers.js';

/**
 * 30 Oct — BR-371. Purchase → Demand shows one row per product with its asks under it (the asks
 * stay separate records), and the same buyer re-asking for the same thing adds to his open ask.
 */
async function makeProduct(tag: string) {
  const company = await Manufacturer.create({ name: `${tag} Co` });
  const product = await Product.create({
    brand: `${tag} Brand`,
    technical: 'Clodinafop',
    manufacturerId: company._id,
    hsn: '38089110',
  });
  const pack = (packLabel: string, packSize: number) =>
    Sku.create({ productId: product._id, packLabel, packSize, baseUnit: 'KG', unitsPerBox: 10 });
  return { product, small: await pack('100 GM', 0.1), large: await pack('500 GM', 0.5) };
}

async function makeBuyer(tag: string) {
  const cp = await Counterparty.create({
    kind: 'buyer',
    status: 'active',
    firm: `${tag} Buyer ${Math.random()}`,
    mobile: randomMobile(),
  });
  await Buyer.create({ counterpartyId: cp._id });
  return String(cp._id);
}

const over12 = { expiryBand: 'over12' as const };

describe('Purchase → Demand — one row per product (BR-371)', () => {
  it('adds up boxes and asks, counts a seller once across them, and keeps each ask', async () => {
    const tag = `Dem${Date.now()}`;
    const { product, small, large } = await makeProduct(tag);
    const [b1, b2, b3] = [await makeBuyer(tag), await makeBuyer(tag), await makeBuyer(tag)];
    const a1 = await raiseAsk(b1, {
      skuId: String(small._id),
      allPacks: false,
      qty: 30,
      conditionRequirement: over12,
    });
    const a2 = await raiseAsk(b2, {
      skuId: String(large._id),
      allPacks: false,
      qty: 100,
      conditionRequirement: { expiryBand: 'under12', deliveryBand: '48h' },
    });
    const a3 = await raiseAsk(b3, {
      productId: String(product._id),
      allPacks: true,
      qty: 17,
      conditionRequirement: over12,
    });

    // One seller lists both packs — he is one seller for the product, not two.
    const listing = await Listing.create({
      sellerId: new Types.ObjectId(),
      productId: product._id,
      origin: 'seller_initiated',
      scopeType: 'all_india',
      state: 'live',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    for (const sku of [small, large]) {
      await ListingLine.create({
        listingId: listing._id,
        skuId: sku._id,
        ratePaise: 39000,
        expiryBand: 'over12',
        moqExact: 1,
        deliveryBand: '2-5d',
        provenance: 'company',
        qty: 100,
      });
    }

    const group = (await getActiveDemandByProduct({})).find(
      (g) => g.productId === String(product._id),
    )!;
    expect(group).toMatchObject({
      brand: `${tag} Brand`,
      askCount: 3,
      totalBoxes: 147,
      sellerCounts: { quoted: 0, active: 1, dormant: 0 },
      noSeller: false,
    });
    expect(group.asks.map((a) => a.askId).sort()).toEqual([a1.askId, a2.askId, a3.askId].sort());
    const byId = new Map(group.asks.map((a) => [a.askId, a]));
    expect(byId.get(a1.askId)).toMatchObject({
      qty: 30,
      packLabel: '100 GM',
      expiryBand: 'over12',
    });
    expect(byId.get(a2.askId)).toMatchObject({
      packLabel: '500 GM',
      expiryBand: 'under12',
      deliveryBand: '48h',
    });
    expect(byId.get(a3.askId)).toMatchObject({ packLabel: null, qty: 17 });
    // No buyer identity on the page (BR-067).
    expect(JSON.stringify(group)).not.toMatch(/buyerId|firm/i);
  });

  it('No-seller only keeps just the asks with no seller', async () => {
    const tag = `Nos${Date.now()}`;
    const { small } = await makeProduct(tag);
    const buyer = await makeBuyer(tag);
    await raiseAsk(buyer, {
      skuId: String(small._id),
      allPacks: false,
      qty: 4,
      conditionRequirement: over12,
    });
    const group = (await getActiveDemandByProduct({ noSellerOnly: true })).find(
      (g) => g.brand === `${tag} Brand`,
    )!;
    expect(group).toMatchObject({ askCount: 1, totalBoxes: 4, noSeller: true });
  });
});

describe('Raising the same ask again adds to the open one (BR-371)', () => {
  it('same buyer, pack and conditions → one ask with the boxes added', async () => {
    const tag = `Dup${Date.now()}`;
    const { small } = await makeProduct(tag);
    const buyer = await makeBuyer(tag);
    const input = {
      skuId: String(small._id),
      allPacks: false,
      qty: 5,
      conditionRequirement: over12,
    };
    const first = await raiseAsk(buyer, input);
    const again = await raiseAsk(buyer, { ...input, qty: 3 });
    expect(again).toMatchObject({ askId: first.askId, merged: true });
    expect((await Ask.findById(first.askId))!.qty).toBe(8);
    expect(await Ask.countDocuments({ skuId: small._id })).toBe(1);
  });

  it('another pack, other conditions, another buyer, or a quoted ask → a new ask', async () => {
    const tag = `New${Date.now()}`;
    const { small, large } = await makeProduct(tag);
    const buyer = await makeBuyer(tag);
    const base = {
      skuId: String(small._id),
      allPacks: false,
      qty: 5,
      conditionRequirement: over12,
    };
    const first = await raiseAsk(buyer, base);

    const otherPack = await raiseAsk(buyer, { ...base, skuId: String(large._id) });
    const otherExpiry = await raiseAsk(buyer, {
      ...base,
      conditionRequirement: { expiryBand: 'under12' },
    });
    const otherDelivery = await raiseAsk(buyer, {
      ...base,
      conditionRequirement: { expiryBand: 'over12', deliveryBand: '48h' },
    });
    const otherBuyer = await raiseAsk(await makeBuyer(tag), base);
    for (const r of [otherPack, otherExpiry, otherDelivery, otherBuyer]) {
      expect(r.merged).toBe(false);
      expect(r.askId).not.toBe(first.askId);
    }

    // Once sellers have quoted, its quantity stands: a repeat opens a new ask beside it.
    await Ask.updateOne({ _id: first.askId }, { state: 'quoted' });
    const afterQuote = await raiseAsk(buyer, base);
    expect(afterQuote.merged).toBe(false);
    expect((await Ask.findById(first.askId))!.qty).toBe(5);
  });
});
