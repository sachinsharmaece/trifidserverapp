import { Router } from 'express';
import { authRouter } from '../modules/auth/auth.routes.js';
import { listingsRouter } from '../modules/listings/listings.routes.js';
import { boardRouter } from '../modules/pricing/board.routes.js';
import { booksRouter } from '../modules/books/books.routes.js';
import { billingRouter } from '../modules/billing/billing.routes.js';
import { clocksRouter } from '../modules/clocks/clocks.routes.js';
import { complaintsRouter } from '../modules/complaints/complaints.routes.js';
import { dockRouter } from '../modules/dock/dock.routes.js';
import { payoutsRouter } from '../modules/payouts/payouts.routes.js';
import { todayRouter } from '../modules/today/today.routes.js';
import { tripsRouter } from '../modules/trips/trips.routes.js';
import { paymentsRouter } from '../modules/payments/payments.routes.js';
import { purchaseOrdersRouter } from '../modules/purchaseOrders/purchaseOrders.routes.js';
import { salesOrdersRouter } from '../modules/salesOrders/salesOrders.routes.js';
import { tradesRouter } from '../modules/trades/trades.routes.js';
import { buyersRouter } from '../modules/parties/buyers.routes.js';
import { companyRouter } from '../modules/masters/company.routes.js';
import { hsnCodesRouter } from '../modules/masters/hsnCodes.routes.js';
import { manufacturersRouter } from '../modules/masters/manufacturers.routes.js';
import { marginCellsRouter } from '../modules/masters/marginCells.routes.js';
import { productsRouter } from '../modules/masters/products.routes.js';
import { reasonCodesRouter } from '../modules/masters/reasonCodes.routes.js';
import { skusRouter } from '../modules/masters/skus.routes.js';
import { technicalsRouter } from '../modules/masters/technicals.routes.js';
import { sellersRouter } from '../modules/parties/sellers.routes.js';
import { tehsilsRouter } from '../modules/masters/tehsils.routes.js';
import { usersRouter } from '../modules/users/users.routes.js';
import { healthRouter } from '../modules/health/health.routes.js';

/**
 * Everything the admin app calls lives under /api/v1 (app.ts mounts this router there).
 * Add one line per feature module as it is built, for example:
 *   apiRouter.use('/orders', ordersRouter);
 */
export const apiRouter: Router = Router();

// /api/v1/health and /api/v1/ready: the same probes as at the root, reachable through the admin app's proxy.
apiRouter.use(healthRouter);

// /api/v1/auth/login, /auth/logout and /me.
apiRouter.use(authRouter);

// /api/v1/users: staff accounts (Founder and Admin only).
apiRouter.use(usersRouter);

// /api/v1/company, /manufacturers, /technicals, /hsn-codes, /products, /skus, /tehsils and /reason-codes: the masters.
// Everyone signed in can read them; only Founder and Admin can change them.
apiRouter.use(companyRouter);
apiRouter.use(manufacturersRouter);
apiRouter.use(technicalsRouter);
apiRouter.use(hsnCodesRouter);
apiRouter.use(productsRouter);
apiRouter.use(skusRouter);
apiRouter.use(tehsilsRouter);
apiRouter.use(reasonCodesRouter);
// /api/v1/margin-cells: TriFid's margin. Read by Controller, Founder and Admin only; changed with a password check.
apiRouter.use(marginCellsRouter);
// Parties: each is visible to its own desk only (modules/parties/permissions.ts).
apiRouter.use(sellersRouter);
apiRouter.use(buyersRouter);
// Listings hold the seller's rate: same wall as sellers.
apiRouter.use(listingsRouter);
// The Sales rate board: buyer rates worked out from live listings and the margin matrix. Buyer side of the wall.
apiRouter.use(boardRouter);
// Trades: deal cards and funnel lists. Every change goes through the one trade engine (Q-WF-01).
apiRouter.use(tradesRouter);
// Sales orders: read only. The trade engine raises and cancels them (buyer says yes / drops the order).
apiRouter.use(salesOrdersRouter);
// Payments to confirm (the Accounts queue: the same engine actions as the deal card), POs and the books.
apiRouter.use(paymentsRouter);
apiRouter.use(purchaseOrdersRouter);
apiRouter.use(booksRouter);
// The Logistics dock (arrival and check: the same engine actions) and return notes. No firm names or money.
apiRouter.use(dockRouter);
// Build 4: To be billed (the Accounts queue: the Marg bill) and Trips (Logistics: POD). Same engine actions.
apiRouter.use(billingRouter);
apiRouter.use(tripsRouter);
apiRouter.use(payoutsRouter);
// Build 6: complaints after dispatch (the Controller's queue; the engine actions raise and resolve them) and the
// "Run now" button for the clocks.
apiRouter.use(complaintsRouter);
apiRouter.use(clocksRouter);
// Build 7: the Controller's Today page (what ran past its time, lost-in-transit candidates, held payouts).
apiRouter.use(todayRouter);
