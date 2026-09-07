import { describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Employee } from '../src/models/Employee.js';
import { Role } from '../src/models/Role.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { Buyer } from '../src/models/Buyer.js';
import { randomEmail, randomMobile } from './helpers.js';

const app = createApp();

describe('POST /admin/book-assignments (BR-261, BR-276)', () => {
  it('assigns a buyer to a named owner', async () => {
    const salesEmail = randomEmail();
    const password = 'CorrectHorse123';
    const salesRole = await Role.findOne({ key: 'sales' });
    const salesEmployee = await Employee.create({
      person: 'Book Owner',
      email: salesEmail,
      passwordHash: await bcrypt.hash(password, 10),
      roleIds: [salesRole!._id],
      mfaEnabled: false,
      active: true,
    });

    const loginRes = await request(app)
      .post('/api/v1/auth/staff/login')
      .send({ email: salesEmail, password });
    const token = loginRes.body.data.accessToken as string;

    const counterparty = await Counterparty.create({
      mobile: randomMobile(),
      kind: 'buyer',
      status: 'active',
    });
    const buyer = await Buyer.create({ counterpartyId: counterparty._id });

    const res = await request(app)
      .post('/api/v1/admin/book-assignments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        buyerId: (buyer._id as unknown as string).toString(),
        ownerEmployeeId: (salesEmployee._id as unknown as string).toString(),
      });

    expect(res.status).toBe(201);
    expect(res.body.data.bookAssignmentId).toBeTruthy();
  });

  it('rejects an unknown buyer', async () => {
    const email = randomEmail();
    const password = 'CorrectHorse123';
    const salesRole = await Role.findOne({ key: 'sales' });
    await Employee.create({
      person: 'Another Owner',
      email,
      passwordHash: await bcrypt.hash(password, 10),
      roleIds: [salesRole!._id],
      mfaEnabled: false,
      active: true,
    });
    const loginRes = await request(app).post('/api/v1/auth/staff/login').send({ email, password });
    const token = loginRes.body.data.accessToken as string;

    const res = await request(app)
      .post('/api/v1/admin/book-assignments')
      .set('Authorization', `Bearer ${token}`)
      .send({ buyerId: '6a9e187e70030e7ede2070b0', ownerEmployeeId: '6a9e187e70030e7ede2070b0' });

    expect(res.status).toBe(400);
  });
});
