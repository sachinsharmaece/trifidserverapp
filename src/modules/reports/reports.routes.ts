import { Router, type Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { PurchaseOrderModel, SalesOrderModel } from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { conflict, notFound } from '../../shared/errors.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
import { PO_READER_ROLES } from '../purchaseOrders/purchaseOrders.js';
import { ORDER_READER_ROLES } from '../salesOrders/salesOrders.js';
import { dashboardView } from './dashboard.js';
import { proformaPdf, purchaseOrderPdf } from './documents.js';
import {
  CSV_ROW_LIMIT,
  purchaseRegister,
  purchaseRegisterCsv,
  registerQuery,
  salesRegister,
  salesRegisterCsv,
  trialBalance,
  trialBalanceCsv,
  trialBalanceQuery,
} from './registers.js';

/**
 * Reports (Build 8). All of them only read.
 *   GET /reports/sales-register     Accounts, Controller, Founder, Admin   (?from=&to=&q=&page=&pageSize=&format=csv)
 *   GET /reports/purchase-register  Purchase, Accounts, Controller, Founder, Admin
 *   GET /reports/trial-balance      Accounts, Controller, Founder, Admin   (?asOn=&format=csv)
 *   GET /reports/dashboard          everyone signed in: the numbers for the person's own desk
 *   GET /sales-orders/:id/proforma  the PDF for the buyer: whoever may read sales orders
 *   GET /purchase-orders/:id/document  the PDF for the seller: whoever may read purchase orders
 * The two registers are separate, so no row shows a buyer and a seller together (SRS-ACC-07).
 */
export const reportsRouter: Router = Router();

const salesRegisterRoles = requireRole('ACCOUNTS', 'CONTROLLER', 'FOUNDER', 'ADMIN');
const purchaseRegisterRoles = requireRole('PURCHASE', 'ACCOUNTS', 'CONTROLLER', 'FOUNDER', 'ADMIN');
const booksRoles = requireRole('ACCOUNTS', 'CONTROLLER', 'FOUNDER', 'ADMIN');

/** Sends a CSV as a download. The file name says which report and which dates. */
function sendCsv(res: Response, name: string, text: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(text);
}

const rangeName = (from?: string, to?: string) =>
  from || to ? `${from ?? 'start'}_to_${to ?? 'today'}` : 'all';

/** A download is a copy of the books leaving the system, so it is written to the audit log. */
async function auditExport(
  req: Parameters<typeof writeAudit>[0],
  report: string,
  details: Record<string, unknown>,
) {
  await writeAudit(req, {
    action: 'report.export',
    entityType: 'Report',
    entityId: report,
    after: details,
  });
}

function tooManyRows(total: number) {
  return total > CSV_ROW_LIMIT
    ? conflict(
        `This range has ${total} rows. A download holds up to ${CSV_ROW_LIMIT}: choose a shorter date range.`,
        'TOO_MANY_ROWS',
      )
    : null;
}

reportsRouter.get('/reports/sales-register', requireAuth, salesRegisterRoles, async (req, res) => {
  const query = registerQuery.parse(req.query);
  const report = await salesRegister(query);
  if (query.format !== 'csv') {
    res.json(report);
    return;
  }
  const tooMany = tooManyRows(report.total);
  if (tooMany) throw tooMany;
  await auditExport(req, 'sales-register', {
    from: query.from,
    to: query.to,
    q: query.q,
    rows: report.total,
  });
  sendCsv(
    res,
    `sales-register_${rangeName(query.from, query.to)}.csv`,
    salesRegisterCsv(report.rows),
  );
});

reportsRouter.get(
  '/reports/purchase-register',
  requireAuth,
  purchaseRegisterRoles,
  async (req, res) => {
    const query = registerQuery.parse(req.query);
    const report = await purchaseRegister(query);
    if (query.format !== 'csv') {
      res.json(report);
      return;
    }
    const tooMany = tooManyRows(report.total);
    if (tooMany) throw tooMany;
    await auditExport(req, 'purchase-register', {
      from: query.from,
      to: query.to,
      q: query.q,
      rows: report.total,
    });
    sendCsv(
      res,
      `purchase-register_${rangeName(query.from, query.to)}.csv`,
      purchaseRegisterCsv(report.rows),
    );
  },
);

reportsRouter.get('/reports/trial-balance', requireAuth, booksRoles, async (req, res) => {
  const { asOn, format } = trialBalanceQuery.parse(req.query);
  const report = await trialBalance(asOn);
  if (format !== 'csv') {
    res.json(report);
    return;
  }
  await auditExport(req, 'trial-balance', { asOn, ledgers: report.rows.length });
  sendCsv(res, `trial-balance_${asOn ?? 'today'}.csv`, trialBalanceCsv(report));
});

reportsRouter.get('/reports/dashboard', requireAuth, async (req, res) => {
  res.json(await dashboardView(req.user!.role));
});

/** Sends a PDF for the browser to show or download. */
function sendPdf(res: Response, name: string, bytes: Uint8Array) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  res.send(Buffer.from(bytes));
}

reportsRouter.get(
  '/sales-orders/:id/proforma',
  requireAuth,
  requireRole(...ORDER_READER_ROLES),
  async (req, res) => {
    const order = isValidObjectId(req.params.id)
      ? await SalesOrderModel.findById(req.params.id)
      : null;
    if (!order) throw notFound('Sales order not found.');
    if (order.status === 'CANCELLED') {
      throw conflict('This order was cancelled, so there is no proforma.', 'ORDER_CANCELLED');
    }
    sendPdf(res, `${order.number}-proforma.pdf`, await proformaPdf(order));
  },
);

reportsRouter.get(
  '/purchase-orders/:id/document',
  requireAuth,
  requireRole(...PO_READER_ROLES),
  async (req, res) => {
    const po = isValidObjectId(req.params.id)
      ? await PurchaseOrderModel.findById(req.params.id)
      : null;
    if (!po) throw notFound('Purchase order not found.');
    sendPdf(res, `${po.number}.pdf`, await purchaseOrderPdf(po));
  },
);
