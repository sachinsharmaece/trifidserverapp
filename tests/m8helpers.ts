import request from 'supertest';
import type { Express } from 'express';
import { expect } from 'vitest';
import { Buyer } from '../src/models/Buyer.js';
import { Seller } from '../src/models/Seller.js';
import { Sku } from '../src/models/Sku.js';
import { BuyerLocation } from '../src/models/BuyerLocation.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { NotificationOutbox } from '../src/models/NotificationOutbox.js';
import { signAccessToken } from '../src/shared/tokens.js';
import {
  setWhatsAppTransport,
  setSmsSender,
  type WhatsAppSendRequest,
  type MetaTemplateStatus,
  type SmsSendRequest,
} from '../src/modules/notification/notification.transport.js';
import { staffToken, createTestSku, seedMarginCell } from './m4helpers.js';
import {
  createTehsil,
  createApprovedBuyerAtTehsil,
  createApprovedSellerAtTehsils,
} from './m5helpers.js';

/** A buyer or seller's two ids: the sub-document's own, and the shared Counterparty. */
export interface Party {
  docId: string;
  counterpartyId: string;
}

export async function partyOf(kind: 'buyer' | 'seller', docId: string): Promise<Party> {
  const doc = kind === 'buyer' ? await Buyer.findById(docId) : await Seller.findById(docId);
  return { docId, counterpartyId: String(doc!.counterpartyId) };
}

export async function tokenFor(party: Party): Promise<string> {
  return signAccessToken({
    sub: party.counterpartyId,
    actorType: 'counterparty',
    counterpartyId: party.counterpartyId,
    roles: [],
    permissions: [],
    status: 'active',
  });
}

/**
 * Approval itself queues a `registration_invite` and so uses up a counterparty's
 * weekly WhatsApp slot. Tests that care about the cap or the ladder start from a
 * clean slate with this.
 */
export async function resetOutbox(counterpartyId: string): Promise<void> {
  await NotificationOutbox.deleteMany({ counterpartyId });
  await Counterparty.updateOne({ _id: counterpartyId }, { $set: { lastWhatsAppQueuedAt: null } });
}

export async function outboxRows(counterpartyId: string, templateKey?: string) {
  return NotificationOutbox.find({
    counterpartyId,
    ...(templateKey ? { templateKey } : {}),
  }).sort({ _id: 1 });
}

export async function newBuyer(app: Express): Promise<Party> {
  const sales = await staffToken(app, 'sales');
  const tehsilId = await createTehsil();
  return partyOf('buyer', await createApprovedBuyerAtTehsil(app, sales.token, tehsilId, 'dealer'));
}

export async function newSeller(app: Express): Promise<Party> {
  const purchase = await staffToken(app, 'purchase');
  const tehsilId = await createTehsil();
  return partyOf('seller', await createApprovedSellerAtTehsils(app, purchase.token, [tehsilId]));
}

export async function productIdForSku(skuId: string): Promise<string> {
  const sku = await Sku.findById(skuId);
  return String(sku!.productId);
}

export async function createLocationFor(buyerDocId: string, employeeId: string): Promise<string> {
  const buyer = await Buyer.findById(buyerDocId);
  const location = await BuyerLocation.create({
    buyerId: buyer!._id,
    label: 'Warehouse',
    address: 'Test address',
    pin: '452001',
    licenceNo: 'LIC-X',
    approvedBy: employeeId,
    approvedAt: new Date(),
    isPrimary: true,
  });
  return String(location._id);
}

export async function createListingViaApi(
  app: Express,
  sellerToken: string,
  input: { productId: string; skuId: string; ratePaise: number; moqExact?: number },
): Promise<{ listingId: string; lineIds: string[] }> {
  const res = await request(app)
    .post('/api/v1/listings')
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({
      productId: input.productId,
      scopeType: 'my_area',
      lines: [
        {
          skuId: input.skuId,
          ratePaise: input.ratePaise,
          expiryBand: 'over12',
          moqExact: input.moqExact ?? 1,
          deliveryBand: '48h',
          provenance: 'auth',
          batch: 'BATCH-1',
          qty: 100,
        },
      ],
    });
  expect(res.status).toBe(201);
  return res.body.data as { listingId: string; lineIds: string[] };
}

/** One seller, three buyers in that seller's tehsil (dealer / retailer / distributor), one SKU, a margin matrix. */
export async function seedTradeFixture(app: Express) {
  const admin = await staffToken(app, 'admin');
  const sales = await staffToken(app, 'sales');
  const purchase = await staffToken(app, 'purchase');
  const tehsilA = await createTehsil();

  const seller = await partyOf(
    'seller',
    await createApprovedSellerAtTehsils(app, purchase.token, [tehsilA]),
  );
  // BR-153 — a pool's supplier cannot be `New` tier.
  await Seller.updateOne({ _id: seller.docId }, { $set: { trustTier: 'Verified' } });

  const buyerDealer = await partyOf(
    'buyer',
    await createApprovedBuyerAtTehsil(app, sales.token, tehsilA, 'dealer'),
  );
  const buyerRetailer = await partyOf(
    'buyer',
    await createApprovedBuyerAtTehsil(app, sales.token, tehsilA, 'retailer'),
  );
  const buyerDistributor = await partyOf(
    'buyer',
    await createApprovedBuyerAtTehsil(app, sales.token, tehsilA, 'distributor'),
  );

  const skuId = await createTestSku('B');
  await seedMarginCell('B', 'Distributor', 0.02, admin.employeeId);
  await seedMarginCell('B', 'Dealer', 0.035, admin.employeeId);
  await seedMarginCell('B', 'Retailer', 0.05, admin.employeeId);
  await seedMarginCell('B', 'Trader', 0.015, admin.employeeId);

  return { admin, sales, purchase, seller, buyerDealer, buyerRetailer, buyerDistributor, skuId };
}

/**
 * Recording doubles for the two outside systems — nothing in the suite ever
 * touches the network. `statuses` is what the fake Meta reports on a template poll.
 */
export function installFakeTransports(options?: { failSends?: boolean }) {
  const sent: WhatsAppSendRequest[] = [];
  const smsSent: SmsSendRequest[] = [];
  const state: { statuses: MetaTemplateStatus[] | null } = { statuses: [] };

  setWhatsAppTransport({
    async send(req) {
      sent.push(req);
      if (options?.failSends) {
        return {
          outcome: 'api_error',
          httpStatus: 500,
          providerMessageId: null,
          providerErrorCode: '131000',
        };
      }
      return {
        outcome: 'accepted',
        httpStatus: 200,
        providerMessageId: `wamid.${Date.now()}.${Math.random()}`,
        providerErrorCode: null,
      };
    },
    async fetchTemplateStatuses() {
      return state.statuses;
    },
  });
  setSmsSender({
    async send(req) {
      smsSent.push(req);
      return { outcome: 'stub_not_sent', providerErrorCode: null };
    },
  });

  return { sent, smsSent, state };
}

export function restoreRealTransports(): void {
  setWhatsAppTransport(null);
  setSmsSender(null);
}
