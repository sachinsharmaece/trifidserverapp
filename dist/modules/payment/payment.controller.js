import * as paymentService from './payment.service.js';
import { allocateUpcomingReceiptSchema, buildPaymentRunSchema, createUpcomingReceiptSchema, dayCloseSchema, postBankCreditSchema, recordReceiptConfirmationSchema, releasePaymentRunSchema, repostBankEntrySchema, sendBackPaymentRunSchema, } from './payment.validation.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
function staffActor(req) {
    return { employeeId: req.auth.employeeId, correlationId: req.correlationId };
}
// API-072 — 👤B.
export async function postPaymentClaim(req, res) {
    const buyerId = req.auth.counterpartyId;
    const input = createUpcomingReceiptSchema.parse(req.body);
    const result = await paymentService.createUpcomingReceipt(buyerId, input);
    ok(res, req, result, 201);
}
// API-080 — 🏢 receipt:read.
export async function getUpcomingReceipts(req, res) {
    ok(res, req, await paymentService.listWaitingUpcomingReceipts());
}
// API-081 — 🏢 receipt:allocate (Sales).
export async function postAllocateReceipt(req, res) {
    const { soIds } = allocateUpcomingReceiptSchema.parse(req.body);
    await paymentService.allocateUpcomingReceipt(req.params.id, soIds, staffActor(req));
    ok(res, req, { allocated: true });
}
// API-082 — 🏢 bank:post (Accounts).
export async function postBankCredit(req, res) {
    const input = postBankCreditSchema.parse(req.body);
    const result = await paymentService.postBankCredit(req.params.id, input, staffActor(req));
    ok(res, req, result, 201);
}
// API-083 — 🎛 bank:repost, Controller only, requires reauth.
export async function postRepostBankEntry(req, res) {
    const { reason, corrected } = repostBankEntrySchema.parse(req.body);
    const result = await paymentService.repostBankEntry(req.params.id, corrected, reason, staffActor(req));
    ok(res, req, result, 201);
}
// API-086 — 🏢 payout:read. B-59 — now carries which gate is blocking, not
// just a bare boolean.
export async function getPoPayable(req, res) {
    const result = await paymentService.getPoPayabilityDetail(req.params.id);
    ok(res, req, result);
}
// Staff-assisted enquiries, decision (B) — 🏢 accounts:confirm_receipt.
export async function postReceiptConfirmation(req, res) {
    const input = recordReceiptConfirmationSchema.parse(req.body);
    const result = await paymentService.recordReceiptConfirmation(req.params.poId, input, staffActor(req));
    ok(res, req, result, 201);
}
// API-085 build — 🏢 payout:build.
export async function postBuildPaymentRun(req, res) {
    const { items } = buildPaymentRunSchema.parse(req.body);
    const result = await paymentService.buildPaymentRun(items, staffActor(req));
    ok(res, req, result, 201);
}
// API-085 release — 🏢 payout:release, requires reauth. INV-16.
export async function postReleasePaymentRun(req, res) {
    const input = releasePaymentRunSchema.parse(req.body);
    await paymentService.releasePaymentRun(req.params.id, input, staffActor(req));
    ok(res, req, { released: true });
}
// New — 🎛 payout:release. The checker declines a built batch; nothing moves.
export async function postSendBackPaymentRun(req, res) {
    const { reason } = sendBackPaymentRunSchema.parse(req.body);
    await paymentService.sendBackPaymentRun(req.params.id, reason, staffActor(req));
    ok(res, req, { sentBack: true });
}
// New — BR-308 day close. 🏢 day_close:run (Accounts).
export async function postDayClose(req, res) {
    const { statementClosingPaise } = dayCloseSchema.parse(req.body);
    const result = await paymentService.runDayClose(statementClosingPaise, staffActor(req));
    ok(res, req, result);
}
// New — sales/purchase registers. 🏢 register:read.
export async function getSalesRegister(req, res) {
    ok(res, req, await paymentService.getSalesRegister());
}
export async function getPurchaseRegister(req, res) {
    ok(res, req, await paymentService.getPurchaseRegister());
}
// New — ledgers, read-only. 🏢 register:read.
export async function getBuyerLedger(req, res) {
    const ledgerPaise = await paymentService.computeBuyerLedgerPaise(req.params.buyerId);
    ok(res, req, { ledgerPaise });
}
export async function getSellerLedger(req, res) {
    const ledgerPaise = await paymentService.computeSellerLedgerPaise(req.params.sellerId);
    ok(res, req, { ledgerPaise });
}
// New — M7, BR-023. 🏢 Accounts.
export async function getGstUnfiledQueue(req, res) {
    ok(res, req, await paymentService.getGstUnfiledQueue());
}
export async function postMarkSellerBillFiled(req, res) {
    const result = await paymentService.markSellerBillFiled(req.params.sellerBillId, staffActor(req));
    ok(res, req, result, 201);
}
