import request from 'supertest';
import type { Express } from 'express';
import bcrypt from 'bcryptjs';
import { Employee } from '../src/models/Employee.js';
import { Role } from '../src/models/Role.js';
import { Tehsil } from '../src/models/Tehsil.js';
import { Manufacturer } from '../src/models/Manufacturer.js';
import { Product } from '../src/models/Product.js';
import { Sku } from '../src/models/Sku.js';
import { MarginMatrix } from '../src/models/MarginMatrix.js';
import { loginStaff, mfaSecretFor, randomEmail, randomGstin, randomMobile } from './helpers.js';

export async function staffToken(
  app: Express,
  roleKey: string,
): Promise<{ token: string; employeeId: string }> {
  const email = randomEmail();
  const password = 'CorrectHorse123';
  const role = await Role.findOne({ key: roleKey });
  const mfaSecret = mfaSecretFor([roleKey]); // Controller / Admin / Founder must enrol (CH §24.3).
  const employee = await Employee.create({
    person: `Test ${roleKey}`,
    email,
    passwordHash: await bcrypt.hash(password, 10),
    roleIds: [role!._id],
    mfaSecret: mfaSecret ?? null,
    mfaEnabled: mfaSecret !== undefined,
    active: true,
  });
  return {
    token: await loginStaff(app, email, password, mfaSecret),
    employeeId: (employee._id as unknown as string).toString(),
  };
}

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

/** Registers and approves a real buyer, dealer tier by default, in a fresh tehsil. */
export async function createApprovedBuyer(
  app: Express,
  salesToken: string,
  tradePosition: 'distributor' | 'dealer' | 'retailer' = 'dealer',
): Promise<string> {
  const registerRes = await request(app)
    .post('/api/v1/registrations/buyer')
    .send({
      mobile: randomMobile(),
      firm: `Test Buyer ${Date.now()}`,
      gstin: await randomGstin(),
      ownerName: 'Owner Name',
      licenceNo: 'LIC-1',
      gstPpobAddress: 'Some address',
      bankDetail: bankDetail(),
      consent: consent(),
    });
  const registrationId = registerRes.body.data.registrationId as string;

  const tehsil = await Tehsil.create({
    name: `Tehsil ${Date.now()}-${Math.random()}`,
    district: 'D',
    state: 'MP',
  });

  const approveRes = await request(app)
    .post(`/api/v1/staff/registrations/${registrationId}/approve`)
    .set('Authorization', `Bearer ${salesToken}`)
    .send({
      tehsilId: (tehsil._id as unknown as string).toString(),
      tradePosition,
      isTrader: false,
    });
  if (approveRes.status !== 200) {
    throw new Error(`Buyer approval failed: ${JSON.stringify(approveRes.body)}`);
  }

  // The counterparty id is the registrationId; the Buyer document's own id is separate.
  const { Buyer } = await import('../src/models/Buyer.js');
  const buyer = await Buyer.findOne({ counterpartyId: registrationId });
  return (buyer!._id as unknown as string).toString();
}

/** Registers and approves a real seller with a verified, non-cooling bank detail. */
export async function createApprovedSeller(app: Express, purchaseToken: string): Promise<string> {
  const registerRes = await request(app)
    .post('/api/v1/registrations/seller')
    .send({
      mobile: randomMobile(),
      firm: `Test Seller ${Date.now()}`,
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

  const tehsil = await Tehsil.create({
    name: `Tehsil ${Date.now()}-${Math.random()}`,
    district: 'D',
    state: 'MP',
  });

  const approveRes = await request(app)
    .post(`/api/v1/staff/registrations/${registrationId}/approve`)
    .set('Authorization', `Bearer ${purchaseToken}`)
    .send({
      tehsilIds: [(tehsil._id as unknown as string).toString()],
      dispatchCutoffTime: '16:00',
    });
  if (approveRes.status !== 200) {
    throw new Error(`Seller approval failed: ${JSON.stringify(approveRes.body)}`);
  }

  const { Seller } = await import('../src/models/Seller.js');
  const { BankDetail } = await import('../src/models/BankDetail.js');
  const seller = await Seller.findOne({ counterpartyId: registrationId });

  // BR-017 — verify + start (and immediately clear) the 24h cooling clock so
  // this fixture is payable-to in tests without waiting a day.
  const detail = await BankDetail.findOne({ counterpartyId: registrationId }).sort({
    createdAt: -1,
  });
  detail!.verifiedAt = new Date();
  detail!.effectiveFrom = new Date(Date.now() - 1000); // already past cooling.
  await detail!.save();

  return (seller!._id as unknown as string).toString();
}

/** A single SKU under a fresh product/manufacturer, class B by default, 20 base units per box. */
export async function createTestSku(skuClass: 'A' | 'B' | 'C' = 'B'): Promise<string> {
  const manufacturer = await Manufacturer.create({ name: `Mfr ${Date.now()}-${Math.random()}` });
  const product = await Product.create({
    brand: `Brand ${Date.now()}`,
    technical: 'Glyphosate',
    manufacturerId: manufacturer._id,
    hsn: '38089110',
    class: skuClass,
  });
  const sku = await Sku.create({
    productId: product._id,
    packLabel: '1 LTR',
    packSize: 1,
    baseUnit: 'LTR',
    unitsPerBox: 20,
  });
  return (sku._id as unknown as string).toString();
}

/** Seeds a margin matrix cell effective immediately, for the given class/tier. */
export async function seedMarginCell(
  skuClass: 'A' | 'B' | 'C',
  tier: 'Distributor' | 'Dealer' | 'Retailer' | 'Trader',
  pct: number,
  createdBy: string,
): Promise<void> {
  await MarginMatrix.create({
    class: skuClass,
    tier,
    pct,
    effectiveFrom: new Date(Date.now() - 1000),
    createdBy,
  });
}
