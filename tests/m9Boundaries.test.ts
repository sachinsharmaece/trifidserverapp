import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Counterparty } from '../src/models/Counterparty.js';
import { NotificationLog } from '../src/models/NotificationLog.js';
import { NotificationOutbox } from '../src/models/NotificationOutbox.js';
import { runOutboxDrain } from '../src/modules/notification/notification.drain.js';
import { enqueueNotification } from '../src/modules/notification/notification.outbox.js';
import { getExceptionView } from '../src/modules/controller/controller.service.js';
import { getBuyerMoneyHeld } from '../src/modules/payment/payment.service.js';
import { getFunnelReport } from '../src/modules/desk/purchase/purchase.funnel.js';
import { staffToken } from './m4helpers.js';
import {
  installFakeTransports,
  newBuyer,
  resetOutbox,
  restoreRealTransports,
} from './m8helpers.js';

/**
 * Milestone 9 — the three remaining structural boundaries (ARCHITECTURE.md §6.3, §6.4):
 * response types that name both counterparties, the notification log, and the
 * Founder module's "owns no query" claim — each verified independently of M8's own tests.
 */
const app = createApp();
const SRC = join(process.cwd(), 'src');

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) tsFilesUnder(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. The Accounts-widening boundary, statically (ARCHITECTURE.md §6.3, DEC-032)
// ---------------------------------------------------------------------------

const BUYER_PROP = /^(buyer|buyerId|buyerName|buyerFirm|buyerGstin|buyerMobile)$/i;
const SELLER_PROP = /^(seller|sellerId|sellerName|sellerFirm|sellerGstin|sellerMobile)$/i;

/** Every exported interface/type literal in `source`, with its property names. */
export function exportedShapes(source: string): Array<{ name: string; props: string[] }> {
  const shapes: Array<{ name: string; props: string[] }> = [];
  const declaration = /export\s+(?:interface\s+(\w+)[^{=]*|type\s+(\w+)\s*=)\s*\{([\s\S]*?)\n\}/g;
  for (const match of source.matchAll(declaration)) {
    const name = (match[1] ?? match[2])!;
    const props = [...match[3]!.matchAll(/^\s{2}(\w+)\??\s*:/gm)].map((m) => m[1]!);
    shapes.push({ name, props });
  }
  return shapes;
}

export function shapesNamingBothSides(source: string): string[] {
  return exportedShapes(source)
    .filter(
      (s) => s.props.some((p) => BUYER_PROP.test(p)) && s.props.some((p) => SELLER_PROP.test(p)),
    )
    .map((s) => s.name);
}

/**
 * Response/DTO types that may name a buyer AND a seller on one object, because
 * the audience is one the wall sanctions to see both (Accounts widened by
 * DEC-032; Controller sees all) or because the type is internal to a service
 * and never serialised to a restricted audience. Every entry says why.
 */
const SANCTIONED_TYPES: Record<string, string> = {};

describe('the Accounts-widening boundary — no restricted response type resembles the Accounts chain shape', () => {
  it('finds no exported type outside the sanctioned list naming both a buyer and a seller', () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(SRC)) {
      const rel = relative(SRC, file).replaceAll('\\', '/');
      if (rel.startsWith('models/') || rel.startsWith('scripts/')) continue; // storage, not responses
      for (const name of shapesNamingBothSides(readFileSync(file, 'utf8'))) {
        if (!(name in SANCTIONED_TYPES)) offenders.push(`${rel}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every sanctioned entry still exists and still names both sides (no stale exceptions)', () => {
    const stillThere = new Set<string>();
    for (const file of tsFilesUnder(SRC)) {
      for (const name of shapesNamingBothSides(readFileSync(file, 'utf8'))) stillThere.add(name);
    }
    expect(Object.keys(SANCTIONED_TYPES).filter((n) => !stillThere.has(n))).toEqual([]);
  });

  it('the scanner itself: a planted Accounts-shaped type is caught, a one-sided one is not', () => {
    const planted = `export interface SalesSoDto {\n  soNo: string;\n  buyerId: string;\n  sellerId: string;\n}\n`;
    expect(shapesNamingBothSides(planted)).toEqual(['SalesSoDto']);
    const renamedAsType = `export type PurchasePoDto = {\n  poNo: string;\n  sellerName: string;\n  buyerFirm: string;\n};\n`;
    expect(shapesNamingBothSides(renamedAsType)).toEqual(['PurchasePoDto']);
    const oneSided = `export interface BuyerSoDto {\n  soNo: string;\n  buyerId: string;\n}\n`;
    expect(shapesNamingBothSides(oneSided)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The notification log never exposes an unmasked mobile number
// ---------------------------------------------------------------------------

describe('notification log sweep — no unmasked mobile, at rest or on any read', () => {
  it('at rest: neither the log nor the outbox schema has any field that could hold a mobile', () => {
    for (const model of [NotificationLog, NotificationOutbox]) {
      const paths = Object.keys(model.schema.paths);
      expect(paths.filter((p) => /mobile|phone|msisdn/i.test(p))).toEqual([]);
    }
  });

  it('on read: every notification endpoint, for every role that may call it, carries only the masked form', async () => {
    installFakeTransports();
    try {
      const buyer = await newBuyer(app);
      await resetOutbox(buyer.counterpartyId);
      const mobile = (await Counterparty.findById(buyer.counterpartyId))!.mobile!;
      await enqueueNotification({
        counterpartyId: buyer.counterpartyId as never,
        templateKey: 'payment_due',
        params: { soNo: 'SO-9', amountRupees: '1,000', payBy: 'tomorrow' },
        correlationId: 'm9-mask',
      });
      await runOutboxDrain(new Date());

      const paths = [
        '/api/v1/staff/notifications/log?limit=200',
        '/api/v1/staff/notifications/worklist',
      ];
      let reached = 0;
      for (const role of ['controller', 'admin', 'founder']) {
        const who = await staffToken(app, role);
        for (const path of paths) {
          const res = await request(app).get(path).set('Authorization', `Bearer ${who.token}`);
          if (res.status !== 200) continue;
          reached += 1;
          const text = JSON.stringify(res.body);
          expect(text, `${role} ${path}`).not.toContain(mobile);
          expect(text, `${role} ${path}`).not.toMatch(/(?<![0-9a-f])\d{10}(?![0-9a-f])/);
        }
      }
      expect(reached).toBeGreaterThan(0); // the sweep did reach the log view
    } finally {
      restoreRealTransports();
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// 3. The Founder module owns no query and cannot drift from the owners' numbers
// ---------------------------------------------------------------------------

describe('founder sweep — modules/founder owns no query, and matches the owning functions', () => {
  const founderDir = join(SRC, 'modules', 'founder');
  const founderFiles = readdirSync(founderDir).map((f) => join(founderDir, f));

  it('no file in the module imports a model, mongoose, or the db layer, or calls a query method', () => {
    expect(founderFiles.length).toBeGreaterThan(0);
    for (const file of founderFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from\s+['"][^'"]*models\//);
      expect(source, file).not.toMatch(/from\s+['"]mongoose['"]/);
      expect(source, file).not.toMatch(/from\s+['"][^'"]*\/db\//);
      expect(source, file).not.toMatch(
        /\.(find|findOne|findById|countDocuments|aggregate|distinct|updateOne|updateMany|insertMany|create|deleteOne|deleteMany)\s*\(/,
      );
    }
  });

  it('every import in the module is one of the three owning modules (or a type-only/Express import)', () => {
    const allowed = [
      '../controller/controller.service.js',
      '../payment/payment.service.js',
      '../desk/purchase/purchase.funnel.js',
      '../../middleware/auth.js',
      '../../middleware/requirePermission.js',
      '../../config/permissions.js',
      './founder.service.js',
      'express',
    ];
    for (const file of founderFiles) {
      const imports = [...readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
        (m) => m[1]!,
      );
      for (const spec of imports) expect(allowed, `${file}: ${spec}`).toContain(spec);
    }
  });

  it('the overview equals the owners’ own functions, called directly — not merely Controller’s route', async () => {
    const founder = await staffToken(app, 'founder');
    const res = await request(app)
      .get('/api/v1/founder/overview')
      .set('Authorization', `Bearer ${founder.token}`);
    expect(res.status).toBe(200);
    const body = res.body.data;
    expect(body.exceptions).toEqual(JSON.parse(JSON.stringify(await getExceptionView())));
    expect(body.buyerMoneyHeld).toEqual(await getBuyerMoneyHeld());
    // `from`/`to` are stamped at call time, so two calls differ by milliseconds; every metric must match.
    const owned = JSON.parse(JSON.stringify(await getFunnelReport()));
    expect({ ...body.funnel, from: null, to: null }).toEqual({ ...owned, from: null, to: null });
    expect(Object.keys(body).sort()).toEqual(['asOf', 'buyerMoneyHeld', 'exceptions', 'funnel']);
  }, 60000);
});
