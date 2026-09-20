import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { So } from '../src/models/So.js';
import { Buyer } from '../src/models/Buyer.js';
import { Seller } from '../src/models/Seller.js';
import { Counterparty } from '../src/models/Counterparty.js';
import * as paymentService from '../src/modules/payment/payment.service.js';
import { signAccessToken } from '../src/shared/tokens.js';
import {
  staffToken,
  createApprovedBuyer,
  createApprovedSeller,
  createTestSku,
  seedMarginCell,
} from './m4helpers.js';
import { findWallViolations, type Audience, type Identity } from './wallSweepRules.js';

/**
 * Milestone 9 — the comprehensive wall sweep (ARCHITECTURE.md §6.4, CH §25.6).
 *
 * It discovers EVERY router under src/modules by itself, calls EVERY GET route
 * as EVERY audience against a fully-built trade chain, and applies
 * `wallSweepRules.ts` to what actually comes back — by key AND by the real
 * seeded identity values, so a renamed field cannot slip past. A new endpoint
 * is swept the moment it exists; there is no list to forget to update.
 */
const app = createApp();
const API = '/api/v1';
const BLANK_ID = '000000000000000000000000';

interface RouteDef {
  path: string;
  params: string[];
}

async function discoverGetRoutes(): Promise<RouteDef[]> {
  const modulesDir = join(process.cwd(), 'src', 'modules');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.routes.ts')) files.push(full);
    }
  };
  walk(modulesDir);

  const found = new Map<string, RouteDef>();
  for (const file of files) {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      const stack = (exported as { stack?: unknown[] } | undefined)?.stack;
      if (!Array.isArray(stack)) continue;
      for (const layer of stack as Array<{ route?: { path: string; methods: object } }>) {
        if (!layer.route || !(layer.route.methods as Record<string, boolean>).get) continue;
        const path = layer.route.path;
        found.set(path, { path, params: [...path.matchAll(/:(\w+)/g)].map((m) => m[1]!) });
      }
    }
  }
  return [...found.values()];
}

interface World {
  ids: Record<string, string[]>; // param name -> candidate ids to try
  identities: { buyer: Identity; seller: Identity };
  soTotalPaise: number;
  tokens: Record<Audience, string>;
}
let world: World;
let routes: RouteDef[] = [];

async function identityOf(kind: 'buyer' | 'seller', docId: string): Promise<Identity> {
  const doc = kind === 'buyer' ? await Buyer.findById(docId) : await Seller.findById(docId);
  const cp = await Counterparty.findById(doc!.counterpartyId);
  return {
    ids: [docId, String(cp!._id)],
    strings: [cp!.firm, cp!.gstin, cp!.mobile].filter((s): s is string => !!s),
  };
}

function counterpartyToken(counterpartyId: string): string {
  return signAccessToken({
    sub: counterpartyId,
    actorType: 'counterparty',
    counterpartyId,
    roles: [],
    permissions: [],
    status: 'active',
  });
}

const key = (): string => `m9w-${Date.now()}-${Math.random()}`;

beforeAll(async () => {
  const admin = await staffToken(app, 'admin');
  const sales = await staffToken(app, 'sales');
  const purchase = await staffToken(app, 'purchase');
  const accounts = await staffToken(app, 'accounts');
  const controller = await staffToken(app, 'controller');
  const logistics = await staffToken(app, 'transport_logistics');
  const founder = await staffToken(app, 'founder');

  const buyerId = await createApprovedBuyer(app, sales.token);
  const sellerId = await createApprovedSeller(app, purchase.token);
  const skuId = await createTestSku();
  await seedMarginCell('B', 'Dealer', 0.05, admin.employeeId);

  // A trade chain walked as far as it goes, so every desk has real rows to leak.
  const soRes = await request(app)
    .post(`${API}/staff/so`)
    .set('Authorization', `Bearer ${sales.token}`)
    .set('Idempotency-Key', key())
    .send({
      buyerId,
      sellerId,
      skuId,
      boxes: 10,
      sellerNetPaise: 40000,
      placeOfSupply: 'intra_state',
    });
  const soId = soRes.body.data.soId as string;
  const so = (await So.findById(soId))!;
  const { upcomingReceiptId } = await paymentService.createUpcomingReceipt(buyerId, {
    amountPaise: so.totalPaise,
    method: 'utr',
    utr: `UTR-${Math.random()}`,
  });
  await paymentService.allocateUpcomingReceipt(upcomingReceiptId, [soId], {
    employeeId: sales.employeeId,
    correlationId: 'sweep',
  });
  await paymentService.postBankCredit(
    upcomingReceiptId,
    {
      utr: `STMT-${Math.random()}`,
      remitterAccountNumber: '99988877766',
      remitterIfsc: 'HDFC0001234',
    },
    { employeeId: accounts.employeeId, correlationId: 'sweep' },
  );
  const poRes = await request(app)
    .post(`${API}/staff/so/${soId}/po`)
    .set('Authorization', `Bearer ${purchase.token}`)
    .set('Idempotency-Key', key())
    .send({});
  const poId = poRes.body.data.poId as string;
  const chainId = String(so.chainId);
  const movement = {
    mode: 'bus',
    busNo: 'MP09AB1234',
    driver: 'Ramu',
    driverMobile: '9000000000',
    freightTerms: 'to_pay',
    freightAmountPaise: 0,
  };
  await request(app)
    .post(`${API}/staff/chains/${chainId}/movements`)
    .set('Authorization', `Bearer ${logistics.token}`)
    .set('Idempotency-Key', key())
    .send({ leg: 1, ...movement });
  await request(app)
    .post(`${API}/staff/pos/${poId}/inspections`)
    .set('Authorization', `Bearer ${logistics.token}`)
    .set('Idempotency-Key', key())
    .send({ casesAccepted: 10, casesRejected: 0, reasons: [], photoRefs: ['p1'] });
  await request(app)
    .post(`${API}/staff/pos/${poId}/inspections/apply`)
    .set('Authorization', `Bearer ${purchase.token}`)
    .set('Idempotency-Key', key())
    .send({});
  await request(app)
    .post(`${API}/staff/marg/${soId}`)
    .set('Authorization', `Bearer ${accounts.token}`)
    .set('Idempotency-Key', key())
    .send({
      margInvoiceNo: `MARG-${Math.random()}`,
      date: new Date().toISOString(),
      valuePaise: (await So.findById(soId))!.totalPaise,
      ewayNo: 'E1',
    });
  await request(app)
    .post(`${API}/staff/chains/${chainId}/movements`)
    .set('Authorization', `Bearer ${logistics.token}`)
    .set('Idempotency-Key', key())
    .send({ leg: 2, ...movement });

  // A second, UNPAID order for the same buyer: it is what fills the Sales worklist. An empty
  // list cannot leak, so a sweep over empty lists proves nothing — this exact gap once hid
  // a buyer-id leak that only showed up when other suites had left data behind.
  await request(app)
    .post(`${API}/staff/so`)
    .set('Authorization', `Bearer ${sales.token}`)
    .set('Idempotency-Key', key())
    .send({
      buyerId,
      sellerId,
      skuId,
      boxes: 5,
      sellerNetPaise: 40000,
      placeOfSupply: 'intra_state',
    });

  const buyerDoc = (await Buyer.findById(buyerId))!;
  const sellerDoc = (await Seller.findById(sellerId))!;
  const buyerCp = String(buyerDoc.counterpartyId);
  const sellerCp = String(sellerDoc.counterpartyId);

  world = {
    ids: {
      soId: [soId],
      poId: [poId],
      chainId: [chainId],
      buyerId: [buyerId],
      sellerId: [sellerId],
      counterpartyId: [buyerCp, sellerCp],
      // `:id` is the resource's own id in most routes — try every real id we hold.
      id: [chainId, poId, soId, buyerId, sellerId, buyerCp, sellerCp, upcomingReceiptId],
    },
    identities: {
      buyer: await identityOf('buyer', buyerId),
      seller: await identityOf('seller', sellerId),
    },
    soTotalPaise: (await So.findById(soId))!.totalPaise,
    tokens: {
      purchase: purchase.token,
      sales: sales.token,
      logistics: logistics.token,
      accounts: accounts.token,
      controller: controller.token,
      founder: founder.token,
      admin: admin.token,
      buyer: counterpartyToken(buyerCp),
      seller: counterpartyToken(sellerCp),
    },
  };
  routes = await discoverGetRoutes();
}, 120000);

function urlsFor(route: RouteDef): string[] {
  // Every combination is overkill; vary ONE param at a time over its candidates.
  const first = (name: string): string => world.ids[name]?.[0] ?? BLANK_ID;
  if (route.params.length === 0) return [`${API}${route.path}`];
  const urls = new Set<string>();
  for (const varying of route.params) {
    for (const candidate of world.ids[varying] ?? [BLANK_ID]) {
      let path = route.path;
      for (const p of route.params) {
        path = path.replace(`:${p}`, p === varying ? candidate : first(p));
      }
      urls.add(`${API}${path}`);
    }
  }
  return [...urls];
}

const AUDIENCES: Audience[] = ['purchase', 'sales', 'logistics', 'buyer', 'seller'];

/**
 * Two kinds of accepted exception — both explicit, both justified, neither silent.
 *
 * SANCTIONED: not a leak. Each entry says why.
 * KNOWN_GAPS: a real breach we could not fix under a confirmed rule this session.
 *   Each names its open question, and the sweep FAILS if the gap has stopped
 *   occurring — so a fix forces this entry to be deleted, and a stale exception
 *   cannot outlive the thing it excuses.
 */
const SANCTIONED: Array<{ url: RegExp; message: RegExp; why: string }> = [
  {
    url: /\/registrations\/[0-9a-f]{24}$/,
    message: /identity value present/,
    why: 'status lookup: echoes only the id the caller asked for, plus kind and status. No firm data.',
  },
];
const KNOWN_GAPS: Array<{
  id: string;
  audience: Audience;
  url: RegExp;
  message: RegExp;
  qr: string;
}> = [
  {
    id: 'registration-list-buyer-firms-to-purchase',
    audience: 'purchase',
    url: /\/staff\/registrations$/,
    message: /buyer identity value present/,
    qr: 'QR-060',
  },
  {
    id: 'registration-list-seller-firms-to-sales',
    audience: 'sales',
    url: /\/staff\/registrations$/,
    message: /seller identity value present/,
    qr: 'QR-060',
  },
];
const observedGaps = new Set<string>();

function classify(
  audience: Audience,
  url: string,
  violation: string,
): 'sanctioned' | 'gap' | 'leak' {
  if (SANCTIONED.some((s) => s.url.test(url) && s.message.test(violation))) return 'sanctioned';
  const gap = KNOWN_GAPS.find(
    (g) => g.audience === audience && g.url.test(url) && g.message.test(violation),
  );
  if (gap) {
    observedGaps.add(gap.id);
    return 'gap';
  }
  return 'leak';
}

describe('M9 wall sweep — every GET route, every restricted audience, real data', () => {
  it('discovers the routes it sweeps (a sanity floor, so an empty sweep cannot pass)', () => {
    expect(routes.length).toBeGreaterThan(60);
    const paths = routes.map((r) => r.path);
    // M7/M8 surfaces named in the M9 brief are inside the sweep.
    expect(paths.some((p) => p.startsWith('/staff/logistics'))).toBe(true);
    expect(paths.some((p) => p.includes('controller'))).toBe(true);
    expect(paths.some((p) => p.includes('notification'))).toBe(true);
    expect(paths.some((p) => p.includes('founder'))).toBe(true);
  });

  for (const audience of AUDIENCES) {
    it(`${audience} — nothing it can read carries what its side of the wall forbids`, async () => {
      const violations: string[] = [];
      let ok = 0;
      for (const route of routes) {
        for (const url of urlsFor(route)) {
          const res = await request(app)
            .get(url)
            .set('Authorization', `Bearer ${world.tokens[audience]}`);
          if (res.status !== 200) continue;
          ok += 1;
          for (const v of findWallViolations(audience, res.body, world)) {
            if (classify(audience, url, v) === 'leak') {
              violations.push(`${audience} GET ${url} -> ${v}`);
            }
          }
        }
      }
      // Coverage is printed, so a sweep that quietly reaches nothing is visible.
      console.info(`wall sweep: ${audience} reached ${ok} 200-responses`);
      expect(violations).toEqual([]);
    }, 240000);
  }
});

describe('M9 wall sweep — the known gaps are still the known gaps', () => {
  it('every KNOWN_GAP was actually observed — a fixed gap must be deleted from the list', () => {
    const stale = KNOWN_GAPS.filter((g) => !observedGaps.has(g.id)).map((g) => `${g.id} (${g.qr})`);
    expect(stale).toEqual([]);
  });
});
