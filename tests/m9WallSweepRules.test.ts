import { describe, expect, it } from 'vitest';
import { findWallViolations, type WallWorld } from './wallSweepRules.js';

/**
 * The proof pattern M5/M6 used for their sweeps, applied to every rule in the
 * larger M9 sweep: a deliberately PLANTED violation must turn the sweep red.
 * A sweep that has never been seen to fail proves nothing.
 *
 * Each case is a response body an endpoint could plausibly return if someone
 * widened its type, built from the same seeded identities the live sweep uses.
 * A clean body for the same audience must come back with no violations.
 */
const world: WallWorld = {
  identities: {
    buyer: {
      ids: ['b0b0b0b0b0b0b0b0b0b0b0b0'],
      strings: ['Acme Traders Pvt Ltd', '23AAAAA0000A1Z5'],
    },
    seller: { ids: ['5e115e115e115e115e115e11'], strings: ['Zenith Pharma', '9876543210'] },
  },
  soTotalPaise: 4_956_000,
};

const clean = { chainNo: 'CH-1', stage: 'po', so: { soNo: 'SO-1', state: 'po_released' } };

describe('wall sweep rules — a clean body passes, a planted violation fails (every rule, every audience)', () => {
  it('a clean body passes for every restricted audience', () => {
    for (const audience of ['purchase', 'sales', 'logistics', 'buyer', 'seller'] as const) {
      expect(findWallViolations(audience, clean, world)).toEqual([]);
    }
  });

  it('Purchase sweep — buyer identity (by key, by id, by firm name), buyer value, margin', () => {
    expect(findWallViolations('purchase', { buyerId: 'x' }, world).length).toBeGreaterThan(0);
    expect(
      findWallViolations('purchase', { party: 'b0b0b0b0b0b0b0b0b0b0b0b0' }, world).length,
    ).toBeGreaterThan(0); // a renamed key still carrying the id
    expect(
      findWallViolations('purchase', { note: 'ship to acme traders pvt ltd' }, world).length,
    ).toBeGreaterThan(0); // the firm name in free text, any case
    expect(
      findWallViolations('purchase', { x: { total: 4_956_000 } }, world).length,
    ).toBeGreaterThan(0);
    expect(findWallViolations('purchase', { marginPct: 0.05 }, world).length).toBeGreaterThan(0);
    expect(findWallViolations('purchase', { pct: 0.05, creditPct: 0.01 }, world).length).toBe(2);
  });

  it('Sales sweep — seller identity (key, id, firm), seller net, margin', () => {
    expect(findWallViolations('sales', { sellerId: 'x' }, world).length).toBeGreaterThan(0);
    expect(
      findWallViolations('sales', { from: '5e115e115e115e115e115e11' }, world).length,
    ).toBeGreaterThan(0);
    expect(findWallViolations('sales', { firm: 'Zenith Pharma' }, world).length).toBeGreaterThan(0);
    expect(findWallViolations('sales', { sellerNetPaise: 40000 }, world).length).toBeGreaterThan(0);
    expect(findWallViolations('sales', { margin: 1 }, world).length).toBeGreaterThan(0);
  });

  it('Logistics sweep — no firm on either side, and no money in any spelling', () => {
    expect(findWallViolations('logistics', { buyerId: 'x' }, world).length).toBeGreaterThan(0);
    expect(findWallViolations('logistics', { sellerId: 'x' }, world).length).toBeGreaterThan(0);
    expect(
      findWallViolations('logistics', { firm: 'Zenith Pharma' }, world).length,
    ).toBeGreaterThan(0);
    for (const moneyKey of [
      'totalPaise',
      'ratePaise',
      'amount',
      'price',
      'freightAmount',
      'ledgerPaise',
    ]) {
      expect(findWallViolations('logistics', { [moneyKey]: 1 }, world).length).toBeGreaterThan(0);
    }
  });

  it('Buyer and seller apps — the other counterparty never appears; seller net and margin never appear', () => {
    expect(findWallViolations('buyer', { sellerId: 'x' }, world).length).toBeGreaterThan(0);
    expect(findWallViolations('buyer', { sellerNetPaise: 1 }, world).length).toBeGreaterThan(0);
    expect(findWallViolations('buyer', { margin: 1 }, world).length).toBeGreaterThan(0);
    expect(findWallViolations('seller', { buyerId: 'x' }, world).length).toBeGreaterThan(0);
    expect(findWallViolations('seller', { note: '23AAAAA0000A1Z5' }, world).length).toBeGreaterThan(
      0,
    );
    expect(findWallViolations('seller', { margin: 1 }, world).length).toBeGreaterThan(0);
  });

  it('the Accounts-widening boundary — one object naming both a buyer and a seller fails for every non-sanctioned audience', () => {
    // A type that resembles the Accounts chain shape (DEC-032 / ARCHITECTURE §6.3).
    const accountsShaped = { chainNo: 'CH-1', buyerId: 'x', sellerId: 'y', totalPaise: 1 };
    for (const audience of ['purchase', 'sales', 'logistics', 'buyer', 'seller'] as const) {
      const found = findWallViolations(audience, { data: [accountsShaped] }, world);
      expect(found.some((v) => v.includes('both a buyer and a seller'))).toBe(true);
    }
    // ...while the sanctioned audiences may receive it.
    for (const audience of ['accounts', 'controller', 'founder', 'admin'] as const) {
      expect(findWallViolations(audience, { data: [accountsShaped] }, world)).toEqual([]);
    }
  });
});
