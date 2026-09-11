import type { Request, Response } from 'express';
import * as paymentService from './payment.service.js';
import {
  allocateUpcomingReceiptSchema,
  buildPaymentRunSchema,
  createUpcomingReceiptSchema,
  dayCloseSchema,
  postBankCreditSchema,
  releasePaymentRunSchema,
  repostBankEntrySchema,
} from './payment.validation.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

function staffActor(req: Request): { employeeId: string; correlationId: string } {
  return { employeeId: req.auth!.employeeId!, correlationId: req.correlationId };
}

// API-072 — 👤B.
export async function postPaymentClaim(req: Request, res: Response): Promise<void> {
  const buyerId = req.auth!.counterpartyId!;
  const input = createUpcomingReceiptSchema.parse(req.body);
  const result = await paymentService.createUpcomingReceipt(buyerId, input);
  ok(res, req, result, 201);
}

// API-080 — 🏢 receipt:read.
export async function getUpcomingReceipts(req: Request, res: Response): Promise<void> {
  ok(res, req, await paymentService.listWaitingUpcomingReceipts());
}

// API-081 — 🏢 receipt:allocate (Sales).
export async function postAllocateReceipt(req: Request, res: Response): Promise<void> {
  const { soIds } = allocateUpcomingReceiptSchema.parse(req.body);
  await paymentService.allocateUpcomingReceipt(req.params.id as string, soIds, staffActor(req));
  ok(res, req, { allocated: true });
}

// API-082 — 🏢 bank:post (Accounts).
export async function postBankCredit(req: Request, res: Response): Promise<void> {
  const input = postBankCreditSchema.parse(req.body);
  const result = await paymentService.postBankCredit(
    req.params.id as string,
    input,
    staffActor(req),
  );
  ok(res, req, result, 201);
}

// API-083 — 🎛 bank:repost, Controller only, requires reauth.
export async function postRepostBankEntry(req: Request, res: Response): Promise<void> {
  const { reason, corrected } = repostBankEntrySchema.parse(req.body);
  const result = await paymentService.repostBankEntry(
    req.params.id as string,
    corrected,
    reason,
    staffActor(req),
  );
  ok(res, req, result, 201);
}

// API-086 — 🏢 payout:read.
export async function getPoPayable(req: Request, res: Response): Promise<void> {
  const payable = await paymentService.isPoPayable(req.params.id as string);
  ok(res, req, { payable });
}

// API-085 build — 🏢 payout:build.
export async function postBuildPaymentRun(req: Request, res: Response): Promise<void> {
  const { items } = buildPaymentRunSchema.parse(req.body);
  const result = await paymentService.buildPaymentRun(items, staffActor(req));
  ok(res, req, result, 201);
}

// API-085 release — 🏢 payout:release, requires reauth. INV-16.
export async function postReleasePaymentRun(req: Request, res: Response): Promise<void> {
  const input = releasePaymentRunSchema.parse(req.body);
  await paymentService.releasePaymentRun(req.params.id as string, input, staffActor(req));
  ok(res, req, { released: true });
}

// New — BR-308 day close. 🏢 day_close:run (Accounts).
export async function postDayClose(req: Request, res: Response): Promise<void> {
  const { statementClosingPaise } = dayCloseSchema.parse(req.body);
  const result = await paymentService.runDayClose(statementClosingPaise, staffActor(req));
  ok(res, req, result);
}

// New — sales/purchase registers. 🏢 register:read.
export async function getSalesRegister(req: Request, res: Response): Promise<void> {
  ok(res, req, await paymentService.getSalesRegister());
}

export async function getPurchaseRegister(req: Request, res: Response): Promise<void> {
  ok(res, req, await paymentService.getPurchaseRegister());
}

// New — ledgers, read-only. 🏢 register:read.
export async function getBuyerLedger(req: Request, res: Response): Promise<void> {
  const ledgerPaise = await paymentService.computeBuyerLedgerPaise(req.params.buyerId as string);
  ok(res, req, { ledgerPaise });
}

export async function getSellerLedger(req: Request, res: Response): Promise<void> {
  const ledgerPaise = await paymentService.computeSellerLedgerPaise(req.params.sellerId as string);
  ok(res, req, { ledgerPaise });
}
