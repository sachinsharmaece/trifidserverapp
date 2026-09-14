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
import { ListingLine } from '../models/ListingLine.js';
import { Pile } from '../models/Pile.js';
import { PileRequest } from '../models/PileRequest.js';
import { So } from '../models/So.js';
import { Po } from '../models/Po.js';
import { Ask } from '../models/Ask.js';
import { Quote } from '../models/Quote.js';
import * as territoryService from '../modules/territory/territory.service.js';
import * as catalogService from '../modules/catalog/catalog.service.js';
import * as pricingService from '../modules/pricing/pricing.service.js';
import * as onboardingService from '../modules/onboarding/onboarding.service.js';
import * as listingService from '../modules/listing/listing.service.js';
import * as demandService from '../modules/demand/demand.service.js';
import * as chainService from '../modules/chain/chain.service.js';
import * as ordersService from '../modules/orders/orders.service.js';
import * as paymentService from '../modules/payment/payment.service.js';
import { runConfirmPileFanout } from '../modules/demand/pileFanout.job.js';

/**
 * Dummy data for manually exercising the M5 buyer/seller apps against the
 * real dev database — two buyers (a Dealer and a Retailer), two sellers (a
 * Verified and a Trusted tier), two products across two SKU classes, a
 * margin matrix for both classes, several listings (direct-buy and
 * pool-opening), one order carried all the way through pile confirmation,
 * payment and leg-1 dispatch, one pile left pending for the Seller
 * Confirmations screen, and one ask with two competing live quotes for the
 * buyer's Asks screen.
 *
 * Every step goes through the real service layer (registerBuyer/
 * approveBuyer, createListing, confirmPile, postDispatchLeg1, and so on)
 * rather than raw model inserts, so the seeded data is exactly what those
 * code paths would have produced through the real API — the resolver, the
 * frozen-tehsil snapshot, the pool-opening side effect and the pile fan-out
 * all run for real. The fan-out itself is invoked directly
 * (`runConfirmPileFanout`) rather than waiting on the real 5-second BR-137
 * undo window a background worker would normally wait out.
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
const BUYER2_MOBILE = '9990000003';
const SELLER2_MOBILE = '9990000004';

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
  const existingAsks = await Ask.countDocuments({ buyerId: buyer!._id, skuId: sku5!._id });
  if (existingAsks === 0) {
    await demandService.raiseAsk((buyerCounterparty!._id as { toString(): string }).toString(), {
      skuId: (sku5!._id as { toString(): string }).toString(),
      allPacks: false,
      qty: 20,
      conditionRequirement: { expiryBand: 'over12', deliveryBand: '2-5d' },
    });
    console.log('Ask raised: buyer wants 20 boxes of CropShield 5L');
  }

  // =========================================================================
  // Round two — a second buyer, a second seller, a second product, and a
  // handful of orders/piles/quotes so the pipeline screens (Orders,
  // Confirmations, Asks, Quotes) are not just empty states.
  // =========================================================================

  // --- Second buyer (Retailer tier) ---------------------------------------
  let buyer2Counterparty = await Counterparty.findOne({ mobile: BUYER2_MOBILE });
  if (!buyer2Counterparty) {
    const { registrationId } = await onboardingService.registerBuyer({
      mobile: BUYER2_MOBILE,
      firm: 'Krishna Agro Retailers (Demo Buyer 2)',
      gstin: gstinFor('23', 'DEMOB5678B'),
      ownerName: 'Anita Verma',
      licenceNo: 'LIC-DEMO-BUYER-2',
      gstPpobAddress: '22 Rajwada Chowk, Indore, MP 452002',
      bankDetail: {
        accountNumber: '000900023456789',
        ifsc: 'SBIN0001234',
        accountName: 'Anita Verma',
      },
      consent: { noticeVersion: 'v1', marketingOptIn: false },
    });
    await onboardingService.approveBuyer(
      registrationId,
      {
        tehsilId: (tehsil!._id as { toString(): string }).toString(),
        tradePosition: 'retailer',
        isTrader: false,
      },
      actor,
    );
    buyer2Counterparty = await Counterparty.findOne({ mobile: BUYER2_MOBILE });
    console.log(`Buyer registered and approved: ${BUYER2_MOBILE} (Retailer)`);
  } else {
    console.log(`Buyer already exists: ${BUYER2_MOBILE}`);
  }
  const buyer2 = await Buyer.findOne({ counterpartyId: buyer2Counterparty!._id });

  let buyer2Location = await BuyerLocation.findOne({ buyerId: buyer2!._id });
  if (!buyer2Location) {
    buyer2Location = await BuyerLocation.create({
      buyerId: buyer2!._id,
      label: 'Retail Shop',
      address: '22 Rajwada Chowk, Indore, MP',
      pin: '452002',
      licenceNo: 'LIC-DEMO-BUYER-2',
      approvedBy: anyEmployee._id,
      approvedAt: new Date(),
      isPrimary: true,
    });
    console.log('Buyer 2 delivery location added: Retail Shop');
  }

  // --- Second seller (Trusted tier) ----------------------------------------
  let seller2Counterparty = await Counterparty.findOne({ mobile: SELLER2_MOBILE });
  if (!seller2Counterparty) {
    const { registrationId } = await onboardingService.registerSeller({
      mobile: SELLER2_MOBILE,
      firm: 'Malwa Crop Sciences (Demo Seller 2)',
      gstin: gstinFor('23', 'DEMOS5678S'),
      ownerName: 'Deepak Rathore',
      licenceNo: 'LIC-DEMO-SELLER-2',
      references: [
        {
          firm: 'Ref Traders Three',
          phone: '9000000013',
          relationship: 'Supplier',
          whatTheySaid: 'Consistent quality, quick dispatch.',
        },
        {
          firm: 'Ref Traders Four',
          phone: '9000000014',
          relationship: 'Supplier',
          whatTheySaid: 'Long-standing, trustworthy.',
        },
      ],
      bankDetail: {
        accountNumber: '000900087654321',
        ifsc: 'PUNB0001234',
        accountName: 'Deepak Rathore',
      },
      consent: { noticeVersion: 'v1', marketingOptIn: false },
    });
    await onboardingService.approveSeller(
      registrationId,
      {
        tehsilIds: [(tehsil!._id as { toString(): string }).toString()],
        dispatchCutoffTime: '17:00',
        trustTier: 'Trusted', // so this seller also gets the demand-board head start.
        seedReason: 'M5 demo data — seeded as a head-start-eligible seller.',
      },
      actor,
    );
    seller2Counterparty = await Counterparty.findOne({ mobile: SELLER2_MOBILE });
    console.log(`Seller registered and approved: ${SELLER2_MOBILE} (Trusted)`);
  } else {
    console.log(`Seller already exists: ${SELLER2_MOBILE}`);
  }
  const seller2 = await Seller.findOne({ counterpartyId: seller2Counterparty!._id });

  // --- Second product, class A ----------------------------------------------
  let manufacturer2 = await Manufacturer.findOne({ name: 'Malwa Bio Sciences' });
  if (!manufacturer2) {
    await catalogService.createManufacturer('Malwa Bio Sciences');
    manufacturer2 = await Manufacturer.findOne({ name: 'Malwa Bio Sciences' });
  }

  let product2 = await Product.findOne({ brand: 'NeemGuard', manufacturerId: manufacturer2!._id });
  if (!product2) {
    await catalogService.createProduct({
      brand: 'NeemGuard',
      technical: 'Azadirachtin 1% EC',
      manufacturerId: (manufacturer2!._id as { toString(): string }).toString(),
      hsn: '38089940',
      class: 'A',
    });
    product2 = await Product.findOne({ brand: 'NeemGuard', manufacturerId: manufacturer2!._id });
  }
  console.log(`Product: NeemGuard / Azadirachtin 1% EC, class A (${product2!._id})`);

  const existingSkus2 = await Sku.find({ productId: product2!._id });
  let sku2 = existingSkus2.find((s) => s.packLabel === '500ml');
  if (!sku2) {
    await catalogService.importSkus((product2!._id as { toString(): string }).toString(), [
      { packLabel: '500ml', packSize: 0.5, baseUnit: 'LTR', unitsPerBox: 24 },
    ]);
    const refreshed2 = await Sku.find({ productId: product2!._id });
    sku2 = refreshed2.find((s) => s.packLabel === '500ml');
  }
  console.log(`SKU: 500ml (${sku2!._id})`);

  // --- Margin matrix, class A, all four tiers --------------------------------
  const classACells = await MarginMatrix.find({ class: 'A' });
  if (classACells.length === 0) {
    const effectiveFrom = new Date('2026-01-01T00:00:00.000Z');
    for (const [tier, pct] of [
      ['Distributor', 0.018],
      ['Dealer', 0.03],
      ['Retailer', 0.045],
      ['Trader', 0.012],
    ] as const) {
      await pricingService.setMarginMatrixCell({ class: 'A', tier, pct, effectiveFrom }, actor);
    }
    console.log(
      'Margin matrix: class A seeded (Distributor 1.8%, Dealer 3%, Retailer 4.5%, Trader 1.2%)',
    );
  } else {
    console.log('Margin matrix: class A already has cells, left as-is');
  }

  // --- More listings, for feed variety ---------------------------------------
  const seller1Product2Count = await Listing.countDocuments({
    sellerId: seller!._id,
    productId: product2!._id,
  });
  if (seller1Product2Count === 0) {
    await listingService.createListing(
      (sellerCounterparty!._id as { toString(): string }).toString(),
      {
        productId: (product2!._id as { toString(): string }).toString(),
        scopeType: 'my_area',
        lines: [
          {
            skuId: (sku2!._id as { toString(): string }).toString(),
            ratePaise: 8500, // seller's net rate — ₹85/unit.
            expiryBand: 'over12',
            moqExact: 5,
            deliveryBand: '2-5d',
            provenance: 'company',
            qty: 300,
          },
        ],
      },
    );
    console.log('Listing created: NeemGuard 500ml by Seller 1 (moq 5)');
  } else {
    console.log('Seller 1 already lists NeemGuard, left as-is');
  }

  const seller2Product1Count = await Listing.countDocuments({
    sellerId: seller2!._id,
    productId: product!._id,
  });
  if (seller2Product1Count === 0) {
    await listingService.createListing(
      (seller2Counterparty!._id as { toString(): string }).toString(),
      {
        productId: (product!._id as { toString(): string }).toString(),
        scopeType: 'my_area',
        lines: [
          {
            skuId: (sku5!._id as { toString(): string }).toString(),
            ratePaise: 192000, // slightly cheaper than Seller 1's 5L rate.
            expiryBand: 'over12',
            moqExact: 10,
            deliveryBand: '2-5d',
            provenance: 'company',
            qty: 400,
          },
        ],
      },
    );
    console.log('Listing created: CropShield 5L (moq 10) by Seller 2');
  } else {
    console.log('Seller 2 already lists CropShield, left as-is');
  }

  const seller2Product2Count = await Listing.countDocuments({
    sellerId: seller2!._id,
    productId: product2!._id,
  });
  if (seller2Product2Count === 0) {
    await listingService.createListing(
      (seller2Counterparty!._id as { toString(): string }).toString(),
      {
        productId: (product2!._id as { toString(): string }).toString(),
        scopeType: 'my_area',
        lines: [
          {
            skuId: (sku2!._id as { toString(): string }).toString(),
            ratePaise: 8300,
            expiryBand: 'over12',
            moqExact: 1,
            deliveryBand: '48h',
            provenance: 'auth',
            batch: 'DEMO-BATCH-S2-500ML',
            qty: 150,
          },
        ],
      },
    );
    console.log('Listing created: NeemGuard 500ml (direct buy) by Seller 2');
  } else {
    console.log('Seller 2 already lists NeemGuard, left as-is');
  }

  // --- Buyer 1 completes a purchase: pile -> confirm -> SO/PO -> payment ---
  // -> dispatch (leg 1), so Buyer/Seller Orders are not empty states. Uses
  // the NeemGuard 500ml line rather than CropShield 1L because the latter
  // has picked up real pile requests from manual app testing in earlier
  // sessions — piling onto it here risks a BR-134 shortfall against demand
  // this script does not know about. Each step below is individually
  // guarded so a script run interrupted partway through (e.g. mid
  // pile-confirm) resumes cleanly on the next run instead of re-attempting
  // a step that already happened.
  let buyer1So = await So.findOne({ buyerId: buyer!._id }).sort({ createdAt: -1 });
  if (!buyer1So) {
    const seller1Product2Listings = await Listing.find({
      sellerId: seller!._id,
      productId: product2!._id,
    });
    const seller1Product2Lines = await ListingLine.find({
      listingId: { $in: seller1Product2Listings.map((l) => l._id) },
    });
    const neemGuardLine = seller1Product2Lines.find((l) => String(l.skuId) === String(sku2!._id));
    if (!neemGuardLine) {
      throw new Error('Expected the NeemGuard 500ml line to exist by now.');
    }

    let pile = await Pile.findOne({ listingLineId: neemGuardLine._id });
    if (!pile) {
      const { pileId } = await listingService.createPileRequest(
        (buyerCounterparty!._id as { toString(): string }).toString(),
        (neemGuardLine._id as { toString(): string }).toString(),
        {
          qty: 20,
          deliveryLocationId: (buyerLocation!._id as { toString(): string }).toString(),
        },
      );
      pile = await Pile.findById(pileId);
      console.log('Pile request raised: Buyer 1 wants 20 boxes of NeemGuard 500ml');
    }

    if (!pile!.decision) {
      // Confirm the pile's *actual* total demand, not a hardcoded number —
      // BR-134's shortfall path silently executes with no SO if the
      // confirmed quantity comes in under what was actually requested.
      const requests = await PileRequest.find({ pileId: pile!._id });
      const totalAsked = requests.reduce((sum, r) => sum + r.qty, 0);
      await demandService.confirmPile(
        (sellerCounterparty!._id as { toString(): string }).toString(),
        (pile!._id as { toString(): string }).toString(),
        { canSendBoxes: totalAsked, expiryExact: '11/2027', batch: undefined },
        'seed-m5-demo',
      );
      console.log(`Pile confirmed: Seller 1 can send all ${totalAsked} boxes`);
    }

    if (!pile!.executedAt) {
      // Runs WF-05's fan-out inline instead of waiting on the real 5-second
      // BR-137 undo window a background worker would otherwise wait out.
      await runConfirmPileFanout((pile!._id as { toString(): string }).toString());
    }

    buyer1So = await So.findOne({ buyerId: buyer!._id }).sort({ createdAt: -1 });
    if (!buyer1So) throw new Error('Expected the pile fan-out to have created an SO.');
    console.log(`Order placed: SO ${buyer1So.soNo} for NeemGuard 500ml`);
  } else {
    console.log('Buyer 1 already has an order, left as-is');
  }

  // Gated on real DB facts (posted receipts, PO existence/state) rather
  // than the in-memory `so` object's `state` field, which never refreshes
  // across these steps as the SO's real state moves — awaiting_payment ->
  // po_released -> dispatched_leg1.
  const so = buyer1So;
  const postedSoFar = await paymentService.getPostedReceiptsPaiseForSo(
    (so._id as { toString(): string }).toString(),
  );
  if (postedSoFar < so.totalPaise) {
    const { upcomingReceiptId } = await paymentService.createUpcomingReceipt(
      (buyer!._id as { toString(): string }).toString(),
      { amountPaise: so.totalPaise - postedSoFar, method: 'utr', utr: 'DEMOUTR000001' },
    );
    await paymentService.allocateUpcomingReceipt(
      upcomingReceiptId,
      [(so._id as { toString(): string }).toString()],
      actor,
    );
    await paymentService.postBankCredit(
      upcomingReceiptId,
      {
        utr: 'DEMOUTR000001',
        remitterAccountNumber: '000900012345678',
        remitterIfsc: 'HDFC0001234',
      },
      actor,
    );
    console.log(`Payment posted in full against SO ${so.soNo}`);
  }

  let po = await Po.findOne({ soId: so._id });
  if (!po) {
    const { poId } = await chainService.createPo(
      (so._id as { toString(): string }).toString(),
      actor,
    );
    po = await Po.findById(poId);
    console.log(`PO released against SO ${so.soNo}`);
  }

  if (po && po.state === 'released') {
    await ordersService.postDispatchLeg1(
      (sellerCounterparty!._id as { toString(): string }).toString(),
      (po._id as { toString(): string }).toString(),
      {
        mode: 'bus',
        busNo: 'MP09 DEMO 1234',
        driver: 'Ramlal',
        driverMobile: '9000000099',
        photoRef: 'demo-photo-ref',
        freightTerms: 'to_pay',
        freightAmountPaise: 150000,
      },
      { correlationId: 'seed-m5-demo' },
    );
    console.log(`PO ${po.poNo} dispatched (leg 1) — buyer 1's order is now trackable end to end`);
  }

  // --- Buyer 2 raises a pile request against Seller 2's pool line, left ---
  // pending — so the Seller Confirmations screen has something to act on.
  const buyer2HasPileRequest = (await PileRequest.countDocuments({ buyerId: buyer2!._id })) > 0;
  if (!buyer2HasPileRequest) {
    const seller2Product1Listings = await Listing.find({
      sellerId: seller2!._id,
      productId: product!._id,
    });
    const seller2Product1Lines = await ListingLine.find({
      listingId: { $in: seller2Product1Listings.map((l) => l._id) },
    });
    const poolLine = seller2Product1Lines.find(
      (l) => String(l.skuId) === String(sku5!._id) && l.moqExact > 1,
    );
    if (!poolLine) {
      throw new Error("Expected Seller 2's CropShield 5L pool line to exist by now.");
    }

    await listingService.createPileRequest(
      (buyer2Counterparty!._id as { toString(): string }).toString(),
      (poolLine._id as { toString(): string }).toString(),
      {
        qty: 15,
        deliveryLocationId: (buyer2Location!._id as { toString(): string }).toString(),
      },
    );
    console.log(
      'Pile request raised: Buyer 2 wants 15 boxes of CropShield 5L from Seller 2 ' +
        '(pending confirmation — try the Seller Confirmations screen)',
    );
  } else {
    console.log('Buyer 2 already has a pile request, left as-is');
  }

  // --- An ask with two competing quotes, left open for the buyer to choose --
  let ask2Id: string;
  const existingAsk2 = await Ask.findOne({ buyerId: buyer!._id, skuId: sku2!._id });
  if (!existingAsk2) {
    const { askId } = await demandService.raiseAsk(
      (buyerCounterparty!._id as { toString(): string }).toString(),
      {
        skuId: (sku2!._id as { toString(): string }).toString(),
        allPacks: false,
        qty: 40,
        conditionRequirement: { expiryBand: 'over12', deliveryBand: '2-5d' },
      },
    );
    ask2Id = askId;
    console.log('Ask raised: buyer wants 40 boxes of NeemGuard 500ml');
  } else {
    ask2Id = (existingAsk2._id as { toString(): string }).toString();
  }

  const existingQuotesForAsk2 = await Quote.countDocuments({ askId: ask2Id });
  if (existingQuotesForAsk2 === 0) {
    await demandService.postQuote(
      (sellerCounterparty!._id as { toString(): string }).toString(),
      ask2Id,
      {
        ratePaiseForIndore: 8600,
        qtyAvailable: 40,
        expiryBand: 'over12',
        expiryExact: '11/2027',
        deliveryBand: '2-5d',
        provenance: 'company',
        daysToIndore: 2,
      },
    );
    await demandService.postQuote(
      (seller2Counterparty!._id as { toString(): string }).toString(),
      ask2Id,
      {
        ratePaiseForIndore: 8400,
        qtyAvailable: 40,
        expiryBand: 'over12',
        expiryExact: '10/2027',
        deliveryBand: '2-5d',
        provenance: 'company',
        daysToIndore: 1,
      },
    );
    console.log(
      'Quotes submitted: Seller 1 (₹86/unit) and Seller 2 (₹84/unit) both quoted the NeemGuard ask',
    );
  }

  console.log(
    '\nDone. Sign in with any mobile number below and OTP',
    env.otpDevFixedCode ?? '111111',
    '(dev-fixed code):',
  );
  console.log(`  Buyer 1:  ${BUYER_MOBILE}  (Sharma Traders, Dealer tier)`);
  console.log(`  Buyer 2:  ${BUYER2_MOBILE}  (Krishna Agro Retailers, Retailer tier)`);
  console.log(`  Seller 1: ${SELLER_MOBILE}  (Madhya Bharat Agro Suppliers, Verified tier)`);
  console.log(`  Seller 2: ${SELLER2_MOBILE}  (Malwa Crop Sciences, Trusted tier)`);
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
