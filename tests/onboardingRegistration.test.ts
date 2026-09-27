import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { randomGstin, randomMobile } from './helpers.js';

const app = createApp();

function bankDetail(accountName = 'Test Account') {
  return { accountNumber: '123456789012', ifsc: 'HDFC0001234', accountName };
}

function consent() {
  return { noticeVersion: 'v1', marketingOptIn: false };
}

function sellerBody(overrides: Record<string, unknown> = {}) {
  return {
    mobile: randomMobile(),
    firm: 'Test Seller Firm',
    ownerName: 'Test Owner',
    licenceNo: 'LIC-9001',
    references: [
      { firm: 'Ref One', phone: '9000000001', relationship: 'Supplier', whatTheySaid: 'Reliable' },
      { firm: 'Ref Two', phone: '9000000002', relationship: 'Supplier', whatTheySaid: 'Reliable' },
    ],
    bankDetail: bankDetail(),
    consent: consent(),
    ...overrides,
  };
}

describe('Seller registration — QA fixes', () => {
  it('rejects a referee phone that is not a valid 10-digit mobile number', async () => {
    const res = await request(app)
      .post('/api/v1/registrations/seller')
      .send(
        sellerBody({
          gstin: await randomGstin(),
          references: [
            { firm: 'Ref One', phone: '12345', relationship: 'Supplier', whatTheySaid: 'Reliable' },
            {
              firm: 'Ref Two',
              phone: '9000000002',
              relationship: 'Supplier',
              whatTheySaid: 'Reliable',
            },
          ],
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('references.0.phone');
  });

  it('rejects a licence number that is too short to be real', async () => {
    const res = await request(app)
      .post('/api/v1/registrations/seller')
      .send(sellerBody({ gstin: await randomGstin(), licenceNo: 'LIC' }));
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('licenceNo');
  });

  it('returns every simultaneous validation issue, not just the first', async () => {
    const res = await request(app)
      .post('/api/v1/registrations/seller')
      .send(
        sellerBody({
          gstin: await randomGstin(),
          licenceNo: 'LIC',
          references: [
            { firm: 'Ref One', phone: '12345', relationship: 'Supplier', whatTheySaid: 'Reliable' },
            {
              firm: 'Ref Two',
              phone: '9000000002',
              relationship: 'Supplier',
              whatTheySaid: 'Reliable',
            },
          ],
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error.fieldErrors.length).toBeGreaterThanOrEqual(2);
    const fields = res.body.error.fieldErrors.map((f: { field: string }) => f.field);
    expect(fields).toContain('licenceNo');
    expect(fields).toContain('references.0.phone');
  });

  it('flags which field matched an existing account and points at its id', async () => {
    const gstin = await randomGstin();
    const first = await request(app)
      .post('/api/v1/registrations/seller')
      .send(sellerBody({ gstin }));
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/v1/registrations/seller')
      .send(sellerBody({ gstin, mobile: randomMobile() }));
    expect(second.status).toBe(400);
    expect(second.body.error.field).toBe('gstin');
    expect(typeof second.body.error.meta?.existingCounterpartyId).toBe('string');
  });

  it('does not block registration on a mismatched bank account name, but logs it for review', async () => {
    const res = await request(app)
      .post('/api/v1/registrations/seller')
      .send(
        sellerBody({
          gstin: await randomGstin(),
          ownerName: 'Ramesh Kumar',
          firm: 'Ramesh Traders',
          bankDetail: bankDetail('Totally Unrelated Name'),
        }),
      );
    expect(res.status).toBe(201);
    const registrationId = res.body.data.registrationId as string;

    const entry = await AuditLog.findOne({
      entity: 'counterparty',
      entityId: registrationId,
      field: 'bank_account_name_mismatch',
    });
    expect(entry).toBeTruthy();
  });

  it('does not log a mismatch when the account name resembles the owner or firm', async () => {
    const res = await request(app)
      .post('/api/v1/registrations/seller')
      .send(
        sellerBody({
          gstin: await randomGstin(),
          ownerName: 'Ramesh Kumar',
          firm: 'Ramesh Traders',
          bankDetail: bankDetail('Ramesh Kumar'),
        }),
      );
    expect(res.status).toBe(201);
    const registrationId = res.body.data.registrationId as string;

    const entry = await AuditLog.findOne({
      entity: 'counterparty',
      entityId: registrationId,
      field: 'bank_account_name_mismatch',
    });
    expect(entry).toBeNull();
  });
});
