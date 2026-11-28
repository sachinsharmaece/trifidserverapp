import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import {
  BuyerModel,
  ListingModel,
  ManufacturerModel,
  ProductModel,
  SkuModel,
} from '../../models/index.js';
import { conflict, notFound } from '../../shared/errors.js';
import { escapeRegex } from '../../shared/mongo.js';
import { normaliseKey } from '../../shared/validators.js';
import { requireAuth } from '../auth/requireAuth.js';
import { pagingShape } from '../parties/common.js';
import { canUseBuyers } from '../parties/permissions.js';
import { loadMargins, pricingTierOf } from './pricing.js';

/**
 * The Sales rate board: what we can offer one buyer today, and at what rate (FR-SAL-02).
 * It sits on the buyer side of the visibility wall, so it never carries the seller, the seller's rate (the landed
 * rate) or the margin: the API leaves them out, it does not hide them. Only the finished buyer rate goes out.
 */
export const boardRouter: Router = Router();

const boardQuery = z.object(pagingShape);

/**
 * GET /buyers/:id/board?q=&page=&pageSize=
 *   ->  { buyer: { id, number, firmName, tier, indicative }, rows, total, page, pageSize }
 * One row per live offer the buyer may be quoted: ACTIVE, not expired, for a pack and product that are turned on.
 * `buyerRatePaisePerUnit` and `boxValuePaise` are null when the margin matrix has no cell for the pack's class and
 * the buyer's tier ("Rate unavailable: margin cell missing", SRS-MST-05). `q` searches the product name.
 * Sorted by product, then pack, then lowest rate. Every live offer is loaded and paged in memory, which is fine for a
 * few thousand offers.
 */
boardRouter.get('/buyers/:id/board', requireAuth, canUseBuyers, async (req, res) => {
  const { q, page, pageSize } = boardQuery.parse(req.query);

  const id = req.params.id;
  const buyer = isValidObjectId(id) ? await BuyerModel.findById(id) : null;
  if (!buyer) throw notFound('Buyer not found.');
  if (!buyer.active) throw conflict('This buyer is turned off.', 'BUYER_INACTIVE');
  const { tier, indicative } = pricingTierOf(buyer);

  // Narrow to the products the person searched for. (A turned-off product or pack is dropped below either way.)
  const now = new Date();
  let packFilter = {};
  if (q) {
    const products = await ProductModel.find({
      nameLower: { $regex: escapeRegex(normaliseKey(q)) },
    }).select('_id');
    const packs = await SkuModel.find({ productId: { $in: products.map((p) => p._id) } }).select(
      '_id',
    );
    packFilter = { skuId: { $in: packs.map((p) => p._id) } };
  }
  const listings = await ListingModel.find({
    status: 'ACTIVE',
    expiresAt: { $gt: now },
    ...packFilter,
  });

  const skus = await SkuModel.find({ _id: { $in: listings.map((l) => l.skuId) }, active: true });
  const products = await ProductModel.find({
    _id: { $in: skus.map((s) => s.productId) },
    active: true,
  });
  const manufacturers = await ManufacturerModel.find({
    _id: { $in: products.map((p) => p.manufacturerId) },
  });
  const margins = await loadMargins(now);

  const rows = listings.flatMap((listing) => {
    const sku = skus.find((s) => s.id === String(listing.skuId));
    const product = sku && products.find((p) => p.id === String(sku.productId));
    if (!sku || !product) return []; // its pack or product has been turned off
    // The listing's rate is already the landed rate per unit (an Ex offer has had its COL added). A live SKU
    // price-matrix cell wins over the Parent matrix.
    const rate = margins.rateFor(sku, tier, listing.ratePaisePerUnit);
    return [
      {
        id: listing.id,
        skuId: sku.id,
        productName: product.name,
        manufacturerName:
          manufacturers.find((m) => m.id === String(product.manufacturerId))?.name ?? '',
        packLabel: sku.packLabel,
        unitsPerBox: listing.unitsPerBoxSnapshot,
        buyerRatePaisePerUnit: rate,
        boxValuePaise: rate === null ? null : rate * listing.unitsPerBoxSnapshot,
        expiryBand: listing.expiryBand,
        moqBoxes: listing.moqBoxes,
        quantityBoxes: listing.quantityBoxes,
      },
    ];
  });

  rows.sort(
    (a, b) =>
      a.productName.localeCompare(b.productName) ||
      a.packLabel.localeCompare(b.packLabel) ||
      // a missing rate goes last
      (a.buyerRatePaisePerUnit ?? Infinity) - (b.buyerRatePaisePerUnit ?? Infinity) ||
      a.id.localeCompare(b.id),
  );

  res.json({
    buyer: { id: buyer.id, number: buyer.number, firmName: buyer.firmName, tier, indicative },
    rows: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
    page,
    pageSize,
  });
});
