import request from 'supertest';
import type { Express } from 'express';
import { Tehsil } from '../src/models/Tehsil.js';
import { randomGstin, randomMobile } from './helpers.js';

function bankDetail() {
  return {
    accountNumber: `${Math.floor(1000000000 + Math.random() * 8999999999)}`,
    ifsc: 'HDFC0001234',
    accountName: 'Test Account',
  };
}
function consent() {
  return { noticeVersion: 'v1', marketingOptIn: false };
}

export async function createTehsil(): Promise<string> {
  const tehsil = await Tehsil.create({
    name: `Tehsil ${Date.now()}-${Math.random()}`,
    district: 'D',
    state: 'MP',
  });
  return (tehsil._id as unknown as string).toString();
}

/** Like m4helpers' createApprovedBuyer, but at a caller-chosen tehsil — needed to control resolver scope precisely. */
export async function createApprovedBuyerAtTehsil(
  app: Express,
  salesToken: string,
  tehsilId: string,
  tradePosition: 'distributor' | 'dealer' | 'retailer' = 'dealer',
): Promise<string> {
  const registerRes = await request(app)
    .post('/api/v1/registrations/buyer')
    .send({
      mobile: randomMobile(),
      firm: `Test Buyer ${Date.now()}-${Math.random()}`,
      gstin: await randomGstin(),
      ownerName: 'Owner Name',
      licenceNo: 'LIC-1',
      gstPpobAddress: 'Some address',
      bankDetail: bankDetail(),
      consent: consent(),
    });
  const registrationId = registerRes.body.data.registrationId as string;

  const approveRes = await request(app)
    .post(`/api/v1/staff/registrations/${registrationId}/approve`)
    .set('Authorization', `Bearer ${salesToken}`)
    .send({ tehsilId, tradePosition, isTrader: false });
  if (approveRes.status !== 200) {
    throw new Error(`Buyer approval failed: ${JSON.stringify(approveRes.body)}`);
  }

  const { Buyer } = await import('../src/models/Buyer.js');
  const buyer = await Buyer.findOne({ counterpartyId: registrationId });
  return (buyer!._id as unknown as string).toString();
}

/** Like m4helpers' createApprovedSeller, but at caller-chosen tehsils. */
export async function createApprovedSellerAtTehsils(
  app: Express,
  purchaseToken: string,
  tehsilIds: string[],
): Promise<string> {
  const registerRes = await request(app)
    .post('/api/v1/registrations/seller')
    .send({
      mobile: randomMobile(),
      firm: `Test Seller ${Date.now()}-${Math.random()}`,
      gstin: await randomGstin(),
      ownerName: 'Owner Name',
      licenceNo: 'LIC-2',
      references: [
        {
          firm: 'Ref One',
          phone: '9000000001',
          relationship: 'Supplier',
          whatTheySaid: 'Reliable',
        },
        {
          firm: 'Ref Two',
          phone: '9000000002',
          relationship: 'Supplier',
          whatTheySaid: 'Reliable',
        },
      ],
      bankDetail: bankDetail(),
      consent: consent(),
    });
  const registrationId = registerRes.body.data.registrationId as string;

  const approveRes = await request(app)
    .post(`/api/v1/staff/registrations/${registrationId}/approve`)
    .set('Authorization', `Bearer ${purchaseToken}`)
    .send({ tehsilIds, dispatchCutoffTime: '16:00' });
  if (approveRes.status !== 200) {
    throw new Error(`Seller approval failed: ${JSON.stringify(approveRes.body)}`);
  }

  const { Seller } = await import('../src/models/Seller.js');
  const { BankDetail } = await import('../src/models/BankDetail.js');
  const seller = await Seller.findOne({ counterpartyId: registrationId });
  const detail = await BankDetail.findOne({ counterpartyId: registrationId }).sort({
    createdAt: -1,
  });
  detail!.verifiedAt = new Date();
  detail!.effectiveFrom = new Date(Date.now() - 1000);
  await detail!.save();

  return (seller!._id as unknown as string).toString();
}
