import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MarginMatrix } from '../src/models/MarginMatrix.js';
import { staffToken } from './m4helpers.js';

const app = createApp();

describe('Margin matrix — bulk save and history (API-132/133)', () => {
  it('saves several cells under one date, shows them as current, and keeps history', async () => {
    const admin = await staffToken(app, 'admin');
    const effectiveFrom = new Date(Date.now() - 60_000).toISOString();

    const save = await request(app)
      .put('/api/v1/admin/margin-matrix/bulk')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        effectiveFrom,
        cells: [
          { class: 'High', tier: 'Retailer', pct: 0.04 },
          { class: 'Low', tier: 'Trader', pct: 0.04 },
        ],
      });
    expect(save.status).toBe(201);
    expect(save.body.data).toHaveLength(2);

    // A later edit adds a row; it never rewrites the first.
    await request(app)
      .put('/api/v1/admin/margin-matrix/bulk')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        effectiveFrom: new Date(Date.now() - 1000).toISOString(),
        cells: [{ class: 'High', tier: 'Retailer', pct: 0.05 }],
      })
      .expect(201);

    const current = await request(app)
      .get('/api/v1/admin/margin-matrix')
      .set('Authorization', `Bearer ${admin.token}`);
    const highRetailer = (
      current.body.data as Array<{ class: string; tier: string; pct: number }>
    ).filter((c) => c.class === 'High' && c.tier === 'Retailer');
    expect(highRetailer).toHaveLength(1);
    expect(highRetailer[0]!.pct).toBe(0.05);

    const history = await request(app)
      .get('/api/v1/admin/margin-matrix/history')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(history.status).toBe(200);
    expect(history.body.data).toHaveLength(3);
    expect(await MarginMatrix.countDocuments()).toBe(3);
  });

  it('rejects the whole batch when one cell is bad, or a cell repeats', async () => {
    const admin = await staffToken(app, 'admin');
    const before = await MarginMatrix.countDocuments();
    const effectiveFrom = new Date().toISOString();

    await request(app)
      .put('/api/v1/admin/margin-matrix/bulk')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        effectiveFrom,
        cells: [
          { class: 'High', tier: 'Dealer', pct: 0.03 },
          { class: 'Low', tier: 'Dealer', pct: 4 },
        ],
      })
      .expect(400);

    await request(app)
      .put('/api/v1/admin/margin-matrix/bulk')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        effectiveFrom,
        cells: [
          { class: 'High', tier: 'Dealer', pct: 0.03 },
          { class: 'High', tier: 'Dealer', pct: 0.04 },
        ],
      })
      .expect(400);

    expect(await MarginMatrix.countDocuments()).toBe(before);
  });

  it('refuses writes to a role without margin_matrix:write', async () => {
    const sales = await staffToken(app, 'sales');
    await request(app)
      .put('/api/v1/admin/margin-matrix/bulk')
      .set('Authorization', `Bearer ${sales.token}`)
      .send({
        effectiveFrom: new Date().toISOString(),
        cells: [{ class: 'High', tier: 'Dealer', pct: 0.03 }],
      })
      .expect(403);
  });
});
