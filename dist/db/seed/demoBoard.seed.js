import { numberSetting } from '../settings.js';
import { nextPartyNumber } from '../documentNumbers.js';
import { BuyerModel, HsnCodeModel, ListingModel, ManufacturerModel, ProductModel, SellerModel, SkuModel, TechnicalModel, TehsilModel, } from '../../models/index.js';
import { dedupeKeyOf } from '../../modules/listings/rates.js';
import { encryptText, hashText } from '../../shared/encryption.js';
import { gstinCheckChar } from '../../shared/validators.js';
/**
 * MADE-UP data so the Rate board has one row to practise a deal on:
 *   Demo Seller Agency offers "Demo Insecticide 500 ML" (class A, 20 per box) at ₹500.00 per unit (FOR),
 *   and Demo Krishi Kendra (a classified Dealer) can be quoted for it.
 * With the demo margin for class A × Dealer (10%) the board shows ₹550.00 per unit, ₹11,000.00 a box.
 *
 * Everything is named "Demo …" so it is easy to spot, and each item is looked up first, so running this
 * twice changes nothing. Turn the demo seller, buyer and product off in the app when you no longer want them.
 * These rows are written straight to the collections, so they have no audit lines.
 */
export const DEMO_SELLER = 'Demo Seller Agency';
export const DEMO_BUYER = 'Demo Krishi Kendra';
export const DEMO_PRODUCT = 'Demo Insecticide';
const DAY_MS = 24 * 60 * 60 * 1000;
/** A GSTIN that passes the check-digit test: Madhya Pradesh (23) + a made-up PAN. */
const gstin = (pan) => {
    const first14 = `23${pan}1Z`;
    return first14 + gstinCheckChar(first14);
};
/** Adds whatever is missing and returns one line per item for the console. */
export async function addDemoBoard(createdBy) {
    const done = [];
    const note = (what, added) => done.push(`${what}: ${added ? 'added' : 'already there'}`);
    // 1. Masters the product needs. Real ones with the same name or code are reused.
    let tehsil = await TehsilModel.findOne({
        state: 'Madhya Pradesh',
        district: 'Indore',
        name: 'Mhow',
    });
    note('tehsil Mhow (Indore)', !tehsil);
    tehsil ??= await TehsilModel.create({
        state: 'Madhya Pradesh',
        district: 'Indore',
        name: 'Mhow',
    });
    let manufacturer = await ManufacturerModel.findOne({ nameLower: 'demo crop care' });
    note('manufacturer Demo Crop Care', !manufacturer);
    manufacturer ??= await ManufacturerModel.create({ name: 'Demo Crop Care' });
    let technical = await TechnicalModel.findOne({ nameLower: 'imidacloprid 17.8% sl' });
    note('technical Imidacloprid 17.8% SL', !technical);
    technical ??= await TechnicalModel.create({ name: 'Imidacloprid 17.8% SL' });
    let hsn = await HsnCodeModel.findOne({ code: '3808' });
    note('HSN code 3808 (GST 18%)', !hsn);
    hsn ??= await HsnCodeModel.create({ code: '3808', description: 'Pesticides', gstBp: 1800 });
    let product = await ProductModel.findOne({ nameLower: DEMO_PRODUCT.toLowerCase() });
    note(`product ${DEMO_PRODUCT}`, !product);
    product ??= await ProductModel.create({
        name: DEMO_PRODUCT,
        manufacturerId: manufacturer._id,
        technicalId: technical._id,
        hsnCodeId: hsn._id,
        taxBp: hsn.gstBp,
    });
    let pack = await SkuModel.findOne({ productId: product._id, packLabelLower: '500 ml' });
    note('pack 500 ML (20 per box, class A)', !pack);
    pack ??= await SkuModel.create({
        productId: product._id,
        packLabel: '500 ML',
        unitsPerBox: 20,
        skuClass: 'A',
    });
    // 2. The seller and the buyer.
    let seller = await SellerModel.findOne({ firmName: DEMO_SELLER });
    note(`seller ${DEMO_SELLER}`, !seller);
    if (!seller) {
        const accountNumber = '000111222333';
        seller = await SellerModel.create({
            number: await nextPartyNumber('SEL'),
            firmName: DEMO_SELLER,
            gstin: gstin('DEMOS1234D'),
            mobile: '9999900001',
            tehsilId: tehsil._id,
            dispatchCutoff: '17:30',
            bank: {
                accountNumberEnc: encryptText(accountNumber),
                accountHash: hashText(accountNumber),
                accountLast4: accountNumber.slice(-4),
                ifsc: 'HDFC0000001',
                bankName: 'HDFC Bank',
                holderName: DEMO_SELLER,
            },
            manufacturerIds: [manufacturer._id],
            createdBy,
        });
    }
    const buyerThere = await BuyerModel.exists({ firmName: DEMO_BUYER });
    note(`buyer ${DEMO_BUYER} (Dealer, classified)`, !buyerThere);
    if (!buyerThere) {
        await BuyerModel.create({
            number: await nextPartyNumber('BUY'),
            firmName: DEMO_BUYER,
            contactName: 'Demo Contact',
            mobiles: ['9999900002'],
            gstin: gstin('DEMOB1234D'),
            tehsilId: tehsil._id,
            address: '1 Demo Market Road, Mhow',
            deliveryLocation: 'Mhow bus stand',
            stateCode: '23',
            tradePosition: 'DEALER',
            traderFlag: false,
            manufacturerIds: [],
            classifiedAt: new Date(), // "Classify now", so his rates are not indicative
            createdBy,
        });
    }
    // 3. The listing: a live FOR offer. Skipped while the demo seller still has a live offer for this pack.
    const now = new Date();
    const live = await ListingModel.exists({
        sellerId: seller._id,
        skuId: pack._id,
        status: 'ACTIVE',
        expiresAt: { $gt: now },
    });
    note('listing ₹500.00 per unit, 100 boxes, MOQ 5', !live);
    if (!live) {
        const offer = {
            rateType: 'FOR',
            ratePaisePerUnit: 50_000,
            expiryBand: 'M9_TO_12',
            moqBoxes: 5,
            provenance: 'OWN_STOCK',
        };
        const lifeDays = await numberSetting('LISTING_LIFE_DAYS', 45);
        await ListingModel.create({
            sellerId: seller._id,
            skuId: pack._id,
            ...offer,
            unitsPerBoxSnapshot: pack.unitsPerBox,
            quantityBoxes: 100,
            expiresAt: new Date(now.getTime() + lifeDays * DAY_MS),
            dedupeKey: dedupeKeyOf({ sellerId: seller.id, skuId: pack.id, ...offer }),
            createdBy,
        });
    }
    return done;
}
//# sourceMappingURL=demoBoard.seed.js.map