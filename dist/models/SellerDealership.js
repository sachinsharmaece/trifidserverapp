import { Schema, model } from 'mongoose';
/**
 * Purchase-desk — a company a seller deals in (is a dealer or distributor
 * for). The seller-side twin of `models/BuyerDealership.ts`, with one
 * difference in meaning: a buyer's dealership is supply intelligence only
 * (BR-244), whereas a seller's says he can supply **every product of that
 * company** — so the products are derived from this link when read, never
 * copied into `SellerCatalogueEntry` (see `purchase.catalogue.ts`). A product
 * Admin adds to the company later is his straight away; unticking the company
 * removes it again without touching anything the desk added by hand.
 *
 * `setBy` is null when the seller ticked his own companies at self-registration.
 */
const sellerDealershipSchema = new Schema({
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    manufacturerId: { type: Schema.Types.ObjectId, ref: 'Manufacturer', required: true },
    setBy: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
}, { timestamps: true });
sellerDealershipSchema.index({ sellerId: 1, manufacturerId: 1 }, { unique: true });
sellerDealershipSchema.index({ manufacturerId: 1 });
export const SellerDealership = model('SellerDealership', sellerDealershipSchema, 'seller_dealership');
