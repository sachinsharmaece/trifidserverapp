import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Phase 7 — acceptance check 22 ("every new or changed form sends an
 * Idempotency-Key"), held by the server: every POST/PUT/PATCH/DELETE route
 * runs `requireIdempotencyKey()`, except the frozen list below, each with its
 * reason. Like the lead-scope inventory, routes are discovered from the
 * routers, so a new write route without the key fails here; the list can
 * only shrink (a listed route that gains the key fails too, until it is
 * taken off).
 */
const AUTH =
  'Sign-in and session calls: no session to key yet, and each is already single-use (OTP, refresh rotation).';
const REVEAL =
  'Returns a full PAN/Aadhaar — the idempotency store keeps the response, which would copy the plaintext there.';
const NOTICE = 'Marking a notice read is idempotent by itself.';
const APP =
  'Buyer/seller app endpoint, outside this round (the app is unchanged except for PAN and duplicate messages).';
const LEGACY =
  'Staff route that predates the form kit and was not changed this round; the admin app keys the forms it changed.';

const WITHOUT_KEY: Record<string, string> = {
  'POST /auth/otp/request': AUTH,
  'POST /auth/otp/verify': AUTH,
  'POST /auth/staff/login': AUTH,
  'POST /auth/staff/mfa/verify': AUTH,
  'POST /auth/refresh': AUTH,
  'POST /auth/logout': AUTH,
  'POST /auth/reauth': AUTH,
  'POST /webhooks/whatsapp': AUTH,
  'POST /admin/employees/:id/mfa': AUTH,
  'POST /admin/employees/:id/reveal': REVEAL,
  'POST /staff/notices/read-all': NOTICE,
  'POST /staff/notices/:noticeId/read': NOTICE,
  'POST /conduct/:id/disagree': APP,
  'POST /asks': APP,
  'POST /asks/:id/decline': APP,
  'POST /asks/:id/quotes': APP,
  'POST /confirmations/:id/undo': APP,
  'POST /confirmations/:id/requote': APP,
  'POST /confirmations/:id/decline': APP,
  'POST /claims/:id/claim': APP,
  'POST /claims/:id/undo': APP,
  'POST /me/msp-requests': APP,
  'POST /exclusions/lookup': APP,
  'POST /exclusions': APP,
  'DELETE /exclusions/:id': APP,
  'POST /files': APP,
  'POST /listings': APP,
  'PATCH /listings/lines/:id/rate': APP,
  'POST /listings/:id/pause': APP,
  'POST /listings/:id/relist': APP,
  'POST /registrations/buyer': APP,
  'POST /registrations/seller': APP,
  'POST /seller/orders/:id/extension-request': APP,
  'POST /orders/:id/confirm-receipt': APP,
  'POST /orders/:id/complaints': APP,
  'POST /orders/:id/requote/reject': APP,
  'POST /orders/payment-claims': APP,
  'POST /pools/:id/reconfirm': APP,
  'POST /pools/:id/withdraw': APP,
  'PUT /admin/config/:key': LEGACY,
  'POST /admin/absences': LEGACY,
  'POST /admin/manufacturers': LEGACY,
  'PATCH /admin/manufacturers/:id': LEGACY,
  'POST /admin/products': LEGACY,
  'PATCH /admin/products/:id': LEGACY,
  'POST /admin/skus/import': LEGACY,
  'PATCH /admin/skus/:id': LEGACY,
  'POST /admin/technicals': LEGACY,
  'POST /admin/hsn': LEGACY,
  'POST /staff/po/:poId/edit': LEGACY,
  'POST /staff/conduct/failures': LEGACY,
  'POST /staff/conduct/failures/:id/advance': LEGACY,
  'POST /staff/controller/disputes/:complaintId/decide': LEGACY,
  'POST /staff/controller/lifeline/bulk': LEGACY,
  'POST /staff/purchase/asks/:askId/chase': LEGACY,
  'POST /staff/purchase/non-order-reasons': LEGACY,
  'POST /staff/purchase/catalogue': LEGACY,
  'PUT /staff/purchase/sellers/:sellerId/dealerships': LEGACY,
  'POST /staff/purchase/piles/:pileId/chase': LEGACY,
  'POST /staff/purchase/stock/:soId/hold': LEGACY,
  'POST /staff/purchase/stock/:soId/hold/adjust': LEGACY,
  'POST /staff/purchase/stock/:soId/hold/confirm': LEGACY,
  'POST /staff/purchase/pos/:poId/invoice': LEGACY,
  'POST /staff/purchase/pos/:poId/hand-to-dispatch': LEGACY,
  'POST /staff/purchase/dispatch/:poId/chase': LEGACY,
  'POST /staff/purchase/masters/manufacturers': LEGACY,
  'POST /staff/purchase/masters/products': LEGACY,
  'POST /staff/purchase/masters/skus': LEGACY,
  'POST /staff/sales/msp/:id/respond': LEGACY,
  'POST /staff/sales/calls': LEGACY,
  'POST /staff/sales/asks/:askId/give-rate': LEGACY,
  'POST /staff/sales/quotes/:quoteId/give': LEGACY,
  'POST /staff/sales/orders/:soId/cancel': LEGACY,
  'POST /staff/pos/:poId/inspections': LEGACY,
  'POST /staff/enquiries': LEGACY,
  'POST /staff/enquiries/:id/edit': LEGACY,
  'POST /staff/enquiries/:id/convert': LEGACY,
  'POST /staff/enquiries/:id/drop': LEGACY,
  'POST /staff/enquiries/:id/mark-listed': LEGACY,
  'POST /staff/enquiries/:id/owner': LEGACY,
  'POST /staff/enquiries/:id/follow-up': LEGACY,
  'POST /staff/enquiries/:id/notes': LEGACY,
  'POST /staff/logistics/transporters': LEGACY,
  'POST /staff/logistics/pos/:poId/goods-in': LEGACY,
  'POST /staff/logistics/consolidations': LEGACY,
  'POST /staff/logistics/return-notes/:returnNoteId/arrange-collection': LEGACY,
  'POST /staff/logistics/return-notes/:returnNoteId/close': LEGACY,
  'POST /staff/counterparties/:id/bank-detail/change': LEGACY,
  'POST /staff/bank-details/:bankDetailId/callback': LEGACY,
  'POST /staff/upcoming-receipts/:id/allocate': LEGACY,
  'POST /staff/pos/:poId/receipt-confirmation': LEGACY,
  'POST /staff/day-close': LEGACY,
  'POST /staff/accounts/seller-bills/:sellerBillId/mark-filed': LEGACY,
  'POST /staff/pools/:id/resolve-shortfall': LEGACY,
  'PUT /admin/margin-matrix/bulk': LEGACY,
  'PUT /admin/margin-matrix': LEGACY,
  'POST /staff/proxy/buyer/asks': LEGACY,
  'POST /staff/proxy/buyer/asks/batch': LEGACY,
  'POST /staff/proxy/buyer/asks/:id/decline': LEGACY,
  'POST /staff/proxy/buyer/orders/:id/promotion/reject': LEGACY,
  'POST /staff/proxy/seller/listings': LEGACY,
  'POST /staff/proxy/seller/asks/:id/quotes': LEGACY,
  'POST /staff/proxy/seller/confirmations/:id/requote': LEGACY,
  'POST /staff/proxy/seller/confirmations/:id/decline': LEGACY,
};

interface Layer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: unknown }>;
  };
}

async function writeRoutes(): Promise<Array<{ route: string; keyed: boolean }>> {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.routes.ts')) files.push(full);
    }
  };
  walk(join(process.cwd(), 'src', 'modules'));
  const found = new Map<string, boolean>();
  for (const file of files) {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      const stack = (exported as { stack?: unknown[] } | undefined)?.stack;
      if (!Array.isArray(stack)) continue;
      for (const layer of stack as Layer[]) {
        const r = layer.route;
        const method = r && ['post', 'put', 'patch', 'delete'].find((m) => r.methods[m]);
        if (!r || !method) continue;
        // requireIdempotencyKey() returns an anonymous middleware; it is the one that reads the header.
        const keyed = r.stack.some((l) =>
          /header\(['"]idempotency-key['"]\)/.test(String(l.handle)),
        );
        found.set(`${method.toUpperCase()} ${r.path}`, keyed);
      }
    }
  }
  return [...found].map(([route, keyed]) => ({ route, keyed }));
}

describe('Phase 7 — Idempotency-Key inventory (check 22)', () => {
  it('every write route requires an Idempotency-Key, or is listed with its reason', async () => {
    const routes = await writeRoutes();
    expect(routes.length).toBeGreaterThan(100);
    const unkeyed = routes.filter((r) => !r.keyed && !(r.route in WITHOUT_KEY)).map((r) => r.route);
    expect(unkeyed).toEqual([]);
  });

  it('the list only shrinks: nothing on it is keyed now, or gone', async () => {
    const routes = new Map((await writeRoutes()).map((r) => [r.route, r.keyed]));
    const stale = Object.keys(WITHOUT_KEY).filter((r) => routes.get(r) !== false);
    expect(stale).toEqual([]);
  });
});
