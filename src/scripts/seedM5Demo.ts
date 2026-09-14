import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { computeGstinChecksum } from '../shared/validators.js';
import { Employee } from '../models/Employee.js';
import { Counterparty } from '../models/Counterparty.js';
import { Buyer } from '../models/Buyer.js';
import { Seller } from '../models/Seller.js';
import { BuyerLocation } from '../models/BuyerLocation.js';
import { Tehsil } from '../models/Tehsil.js';
import { Manufacturer } from '../models/Manufacturer.js';
import { Product } from '../models/Product.js';
import { Sku } from '../models/Sku.js';
import { MarginMatrix } from '../models/MarginMatrix.js';
import { Listing } from '../models/Listing.js';
import * as territoryService from '../modules/territory/territory.service.js';
import * as catalogService from '../modules/catalog/catalog.service.js';
import * as pricingService from '../modules/pricing/pricing.service.js';
import * as onboardingService from '../modules/onboarding/onboarding.service.js';
import * as listingService from '../modules/listing/listing.service.js';
import * as demandService from '../modules/demand/demand.service.js';

/**
 * Dummy data for manually exercising the M5 buyer/seller apps against the
 * real dev database — one approved buyer, one approved seller, a product
 * with two packs, a margin matrix for it, a direct-buy listing and a
 * pool-opening listing.
 *
 * Every step goes through the real service layer (registerBuyer/
 * approveBuyer, createListing, and so on) rather than raw model inserts, so
 * the seeded data is exactly what those code paths would have produced
 * through the real API — the resolver, the frozen-tehsil snapshot and the
 * pool-opening side effect all run for real.
 *
 * Safe to re-run: every step checks for what it needs before creating it,
 * so a second run tops up what is missing rather than erroring or
 * duplicating.
 *
 * Run once: `npm run seed:m5-demo`. Requires `npm run seed:admin` to have
 * been run first (needs at least one Employee to act as the approving/
 * pricing staff member).
 */

const BUYER_MOBILE = '9990000001';
const SELLER_MOBILE = '9990000002';

// GSTIN shape: 2-digit state code + 10-char PAN (5 letters, 4 digits, 1
// letter) + 1-char entity code + 'Z' + a computed checksum — 15 characters.
function gstinFor(stateCode: string, pan: string): string {
  const first14 = `${stateCode}${pan}1Z`;
  return `${first14}${computeGstinChecksum(first14)}`;
}

async function seed(): Promise<void> {
  await connectToDatabase(env.mongodbUri);

  const anyEmployee = await Employee.findOne({});
  if (!anyEmployee) {
    throw new Error(
      'No staff employee exists yet — run `npm run seed:admin` first, then re-run this script.',
    );
  }
  const actor = {
    employeeId: (anyEmployee._id as { toString(): string }).toString(),
    correlationId: 'seed-m5-demo',
  };

  // --- Tehsil ---------------------------------------------------------
  let tehsil = await Tehsil.findOne({ name: 'Indore', district: 'Indore' });
  if (!tehsil) {
    await territoryService.createTehsil('Indore', 'Indore', 'Madhya Pradesh');
    tehsil = await Tehsil.findOne({ name: 'Indore', district: 'Indore' });
  }
  console.log(`Tehsil: Indore, Indore, MP (${tehsil!._id})`);

  // --- Catalog: manufacturer, product, two SKUs ------------------------
  let manufacturer = await Manufacturer.findOne({ name: 'Bharat Agro Chemicals' });
  if (!manufacturer) {
    await catalogService.createManufacturer('Bharat Agro Chemicals');
    manufacturer = await Manufacturer.findOne({ name: 'Bharat Agro Chemicals' });
  }

  let product = await Product.findOne({ brand: 'CropShield', manufacturerId: manufacturer!._id });
  if (!product) {
    await catalogService.createProduct({
      brand: 'CropShield',
      technical: 'Glyphosate 41% SL',
      manufacturerId: (manufacturer!._id as { toString(): string }).toString(),
      hsn: '38089910',
      class: 'B',
    });
    product = await Product.findOne({ brand: 'CropShield', manufacturerId: manufacturer!._id });
  }
  console.log(`Product: CropShield / Glyphosate 41% SL, class B (${product!._id})`);

  const existingSkus = await Sku.find({ productId: product!._id });
  let sku1 = existingSkus.find((s) => s.packLabel === '1 Litre');
  let sku5 = existingSkus.find((s) => s.packLabel === '5 Litre');
  if (!sku1 || !sku5) {
    await catalogService.importSkus((product!._id as { toString(): string }).toString(), [
      { packLabel: '1 Litre', packSize: 1, baseUnit: 'LTR', unitsPerBox: 12 },
      { packLabel: '5 Litre', packSize: 5, baseUnit: 'LTR', unitsPerBox: 4 },
    ]);
    const refreshed = await Sku.find({ productId: product!._id });
    sku1 = refreshed.find((s) => s.packLabel === '1 Litre');
    sku5 = refreshed.find((s) => s.packLabel === '5 Litre');
  }
  console.log(`SKUs: 1 Litre (${sku1!._id}), 5 Litre (${sku5!._id})`);

  // --- Margin matrix, class B, all four tiers --------------------------
  const classBCells = await MarginMatrix.find({ class: 'B' });
  if (classBCells.length === 0) {
    const effectiveFrom = new Date('2026-01-01T00:00:00.000Z');
    for (const [tier, pct] of [
      ['Distributor', 0.02],
      ['Dealer', 0.035],
      ['Retailer', 0.05],
      ['Trader', 0.015],
    ] as const) {
      await pricingService.setMarginMatrixCell({ class: 'B', tier, pct, effectiveFrom }, actor);
    }
    console.log(
      'Margin matrix: class B seeded (Distributor 2%, Dealer 3.5%, Retailer 5%, Trader 1.5%)',
    );
  } else {
    console.log('Margin matrix: class B already has cells, left as-is');
  }

  // --- Buyer ------------------------------------------------------------
  let buyerCounterparty = await Counterparty.findOne({ mobile: BUYER_MOBILE });
  if (!buyerCounterparty) {
    const { registrationId } = await onboardingService.registerBuyer({
      mobile: BUYER_MOBILE,
      firm: 'Sharma Traders (Demo Buyer)',
      gstin: gstinFor('23', 'DEMOB1234B'),
      ownerName: 'Ramesh Sharma',
      licenceNo: 'LIC-DEMO-BUYER-1',
      gstPpobAddress: '14 Krishi Mandi Road, Indore, MP 452001',
      bankDetail: {
        accountNumber: '000900012345678',
        ifsc: 'HDFC0001234',
        accountName: 'Ramesh Sharma',
      },
      consent: { noticeVersion: 'v1', marketingOptIn: false },
    });
    await onboardingService.approveBuyer(
      registrationId,
      {
        tehsilId: (tehsil!._id as { toString(): string }).toString(),
        tradePosition: 'dealer',
        isTrader: false,
      },
      actor,
    );
    buyerCounterparty = await Counterparty.findOne({ mobile: BUYER_MOBILE });
    console.log(`Buyer registered and approved: ${BUYER_MOBILE} (Dealer)`);
  } else {
    console.log(`Buyer already exists: ${BUYER_MOBILE}`);
  }
  const buyer = await Buyer.findOne({ counterpartyId: buyerCounterparty!._id });

  let buyerLocation = await BuyerLocation.findOne({ buyerId: buyer!._id });
  if (!buyerLocation) {
    buyerLocation = await BuyerLocation.create({
      buyerId: buyer!._id,
      label: 'Main Godown',
      address: '14 Krishi Mandi Road, Indore, MP',
      pin: '452001',
      licenceNo: 'LIC-DEMO-BUYER-1',
      approvedBy: anyEmployee._id,
      approvedAt: new Date(),
      isPrimary: true,
    });
    console.log('Buyer delivery location added: Main Godown');
  }

  // --- Seller -------------------------------------------------------------
  let sellerCounterparty = await Counterparty.findOne({ mobile: SELLER_MOBILE });
  if (!sellerCounterparty) {
    const { registrationId } = await onboardingService.registerSeller({
      mobile: SELLER_MOBILE,
      firm: 'Madhya Bharat Agro Suppliers (Demo Seller)',
      gstin: gstinFor('23', 'DEMOS1234S'),
      ownerName: 'Suresh Patel',
      licenceNo: 'LIC-DEMO-SELLER-1',
      references: [
        {
          firm: 'Ref Traders One',
          phone: '9000000011',
          relationship: 'Supplier',
          whatTheySaid: 'Reliable, pays on time.',
        },
        {
          firm: 'Ref Traders Two',
          phone: '9000000012',
          relationship: 'Supplier',
          whatTheySaid: 'Good quality stock.',
        },
      ],
      bankDetail: {
        accountNumber: '000900098765432',
        ifsc: 'ICIC0001234',
        accountName: 'Suresh Patel',
      },
      consent: { noticeVersion: 'v1', marketingOptIn: false },
    });
    await onboardingService.approveSeller(
      registrationId,
      {
        tehsilIds: [(tehsil!._id as { toString(): string }).toString()],
        dispatchCutoffTime: '16:00',
        trustTier: 'Verified', // so this seller is eligible to supply a pool (BR-153).
        seedReason: 'M5 demo data — seeded eligible for pools.',
      },
      actor,
    );
    sellerCounterparty = await Counterparty.findOne({ mobile: SELLER_MOBILE });
    console.log(`Seller registered and approved: ${SELLER_MOBILE} (Verified)`);
  } else {
    console.log(`Seller already exists: ${SELLER_MOBILE}`);
  }
  const seller = await Seller.findOne({ counterpartyId: sellerCounterparty!._id });

  // --- Listings: one direct-buy line, one pool-opening line ---------------
  const existingListingCount = await Listing.countDocuments({ sellerId: seller!._id });
  if (existingListingCount === 0) {
    await listingService.createListing(
      (sellerCounterparty!._id as { toString(): string }).toString(),
      {
        productId: (product!._id as { toString(): string }).toString(),
        scopeType: 'my_area',
        lines: [
          {
            skuId: (sku1!._id as { toString(): string }).toString(),
            ratePaise: 41500, // seller's net rate — ₹415/L.
            expiryBand: 'over12',
            moqExact: 1,
            deliveryBand: '48h',
            provenance: 'auth',
            batch: 'DEMO-BATCH-1LTR',
            qty: 200,
          },
          {
            skuId: (sku5!._id as { toString(): string }).toString(),
            ratePaise: 195000, // ₹1950/5L pack, opens a pool (moqExact 10 > 1).
            expiryBand: 'over12',
            moqExact: 10,
            deliveryBand: '2-5d',
            provenance: 'company',
            qty: 500,
          },
        ],
      },
    );
    console.log('Listing created: CropShield 1L (direct buy, live) + 5L (moq 10, opens a pool)');
  } else {
    console.log('Seller already has a listing, left as-is');
  }

  // --- A demand-side ask, so the seller's Demand board has something too --
  const existingAsks = await (
    await import('../models/Ask.js')
  ).Ask.countDocuments({ buyerId: buyer!._id });
  if (existingAsks === 0) {
    await demandService.raiseAsk((buyerCounterparty!._id as { toString(): string }).toString(), {
      skuId: (sku5!._id as { toString(): string }).toString(),
      allPacks: false,
      qty: 20,
      conditionRequirement: { expiryBand: 'over12', deliveryBand: '2-5d' },
    });
    console.log('Ask raised: buyer wants 20 boxes of CropShield 5L');
  }

  console.log(
    '\nDone. Sign in with either mobile number below and OTP',
    env.otpDevFixedCode ?? '111111',
    '(dev-fixed code):',
  );
  console.log(`  Buyer:  ${BUYER_MOBILE}  (Sharma Traders, Dealer tier)`);
  console.log(`  Seller: ${SELLER_MOBILE}  (Madhya Bharat Agro Suppliers, Verified tier)`);
}

seed()
  .then(async () => {
    await disconnectFromDatabase();
  })
  .catch(async (error: unknown) => {
    console.error('Seed failed:', error);
    await disconnectFromDatabase();
    process.exitCode = 1;
  });
