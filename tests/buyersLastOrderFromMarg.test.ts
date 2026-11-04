import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Buyer } from '../src/models/Buyer.js';
import { staffToken, createApprovedBuyer } from './m4helpers.js';

const app = createApp();

type Row = { buyerId: string; lastOrderAt: string | null; orderCount: number };

describe('Buyers list — Last order from a Marg bill', () => {
  it('shows the Marg bill date as the last order, and sorts by it', async () => {
    const sales = await staffToken(app, 'sales');
    const billedEarlier = await createApprovedBuyer(app, sales.token);
    const billedLater = await createApprovedBuyer(app, sales.token);
    const neverBilled = await createApprovedBuyer(app, sales.token);
    await Buyer.updateOne(
      { _id: billedEarlier },
      { lastBilledOn: new Date('2026-08-05T12:00:00Z') },
    );
    await Buyer.updateOne({ _id: billedLater }, { lastBilledOn: new Date('2026-10-31T12:00:00Z') });

    const list = async (dir: 'asc' | 'desc') => {
      const res = await request(app)
        .get(`/api/v1/staff/sales/buyers?sort=lastOrder&dir=${dir}`)
        .set('Authorization', `Bearer ${sales.token}`);
      expect(res.status).toBe(200);
      return res.body.data as Row[];
    };

    const newestFirst = await list('desc');
    const row = (id: string) => newestFirst.find((b) => b.buyerId === id)!;
    expect(row(billedLater).lastOrderAt).toBe('2026-10-31T12:00:00.000Z');
    expect(row(billedEarlier).lastOrderAt).toBe('2026-08-05T12:00:00.000Z');
    expect(row(neverBilled).lastOrderAt).toBeNull();
    // Orders counts only orders made in the app; a Marg bill is not one of them.
    expect(row(billedLater).orderCount).toBe(0);

    const order = newestFirst.map((b) => b.buyerId);
    expect(order.indexOf(billedLater)).toBeLessThan(order.indexOf(billedEarlier));
    // Never billed goes last either way.
    expect(order.indexOf(billedEarlier)).toBeLessThan(order.indexOf(neverBilled));
    const oldestFirst = (await list('asc')).map((b) => b.buyerId);
    expect(oldestFirst.indexOf(billedEarlier)).toBeLessThan(oldestFirst.indexOf(billedLater));
    expect(oldestFirst.indexOf(billedLater)).toBeLessThan(oldestFirst.indexOf(neverBilled));
  });
});
