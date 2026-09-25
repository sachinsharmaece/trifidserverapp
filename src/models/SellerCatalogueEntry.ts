import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Purchase-desk v2 — the seller catalogue: what a seller *can* supply, from
 * a phone call. Deliberately separate from `models/Listing.ts` (a priced
 * offer, live on the buyer board): no rate, no condition set, no territory,
 * and this row never appears on the buyer board on its own. It exists so
 * "who do I ring for this SKU" is a query, not something held in a caller's
 * head — see `modules/desk/purchase/purchase.service.ts`'s supply-matrix
 * reads, which are built entirely from this collection plus live listings.
 *
 * `skuIds: []` means the seller carries the product but the packs haven't
 * been detailed yet — product-level and pack-level are both valid entries.
 */
const sellerCatalogueEntrySchema = new Schema(
  {
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    skuIds: [{ type: Schema.Types.ObjectId, ref: 'Sku' }],
    setBy: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    setAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true },
);

sellerCatalogueEntrySchema.index({ sellerId: 1, productId: 1 }, { unique: true });
sellerCatalogueEntrySchema.index({ productId: 1 });

export type SellerCatalogueEntryDocument = InferSchemaType<typeof sellerCatalogueEntrySchema>;
export const SellerCatalogueEntry = model<SellerCatalogueEntryDocument>(
  'SellerCatalogueEntry',
  sellerCatalogueEntrySchema,
  'seller_catalogue_entry',
);
