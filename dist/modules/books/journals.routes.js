import { Router } from 'express';
import { z } from 'zod';
import { currentUserOf, requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
import { requireStepUp } from '../auth/stepUp.js';
import { approveJournal, cancelJournal, createJournal, findJournal, journalInput, journalViews, ledgerChoices, listJournals, listQuery, rejectInput, rejectJournal, } from './journals.js';
import { listVouchers, reverseInput, reverseVoucher, voucherDetail, voucherListQuery, } from './reversals.js';
/**
 * Hand-made entries in the books (Build 9). Everything here is Accounts-desk work, so only Accounts and the
 * supervisors see it; the Controller only looks, except for reversing a voucher.
 *
 *   GET  /journals?status=&kind=&q=            journals and opening balances, newest first
 *   GET  /journals/:id
 *   POST /journals                             type one (kind JOURNAL or OPENING): { kind, date, narration, lines[] }
 *   POST /journals/:id/approve                 { version }: a DIFFERENT person; posts the JV voucher
 *   POST /journals/:id/reject                  { version, note }: a different person
 *   POST /journals/:id/cancel                  { version }: the person who typed it, while it is pending
 *   GET  /ledger-choices?q=                    the lines' picker: ledgers, and buyers / sellers without a ledger yet
 *   GET  /vouchers?type=&from=&to=&q=          the day book, newest first, with "can this be reversed?"
 *   GET  /vouchers/:id                         one voucher with its lines
 *   POST /vouchers/:id/reverse                 { reason }: Controller, Founder or Admin, after a password re-check
 */
export const journalsRouter = Router();
const READERS = ['ACCOUNTS', 'CONTROLLER', 'FOUNDER', 'ADMIN'];
const WRITERS = ['ACCOUNTS', 'FOUNDER', 'ADMIN'];
journalsRouter.use(['/journals', '/ledger-choices', '/vouchers'], requireAuth, requireRole(...READERS));
journalsRouter.get('/journals', async (req, res) => {
    res.json(await listJournals(listQuery.parse(req.query), currentUserOf(req).id));
});
journalsRouter.get('/journals/:id', async (req, res) => {
    const journal = await findJournal(req.params.id);
    const [view] = await journalViews([journal], currentUserOf(req).id);
    res.json({ journal: view });
});
journalsRouter.post('/journals', requireRole(...WRITERS), async (req, res) => {
    const journal = await createJournal(req, journalInput.parse(req.body));
    const [view] = await journalViews([journal], currentUserOf(req).id);
    res.status(201).json({ journal: view });
});
const versionBody = z.object({ version: z.number().int().min(0) });
journalsRouter.post('/journals/:id/approve', requireRole(...WRITERS), async (req, res) => {
    await approveJournal(req, await findJournal(req.params.id), versionBody.parse(req.body).version);
    const [view] = await journalViews([await findJournal(req.params.id)], currentUserOf(req).id);
    res.json({ journal: view });
});
journalsRouter.post('/journals/:id/reject', requireRole(...WRITERS), async (req, res) => {
    await rejectJournal(req, await findJournal(req.params.id), rejectInput.parse(req.body));
    const [view] = await journalViews([await findJournal(req.params.id)], currentUserOf(req).id);
    res.json({ journal: view });
});
journalsRouter.post('/journals/:id/cancel', requireRole(...WRITERS), async (req, res) => {
    await cancelJournal(req, await findJournal(req.params.id), versionBody.parse(req.body).version);
    const [view] = await journalViews([await findJournal(req.params.id)], currentUserOf(req).id);
    res.json({ journal: view });
});
journalsRouter.get('/ledger-choices', async (req, res) => {
    const { q } = z.object({ q: z.string().trim().max(100).default('') }).parse(req.query);
    res.json({ choices: await ledgerChoices(q) });
});
journalsRouter.get('/vouchers', async (req, res) => {
    res.json(await listVouchers(voucherListQuery.parse(req.query)));
});
journalsRouter.get('/vouchers/:id', async (req, res) => {
    res.json({ voucher: await voucherDetail(String(req.params.id)) });
});
journalsRouter.post('/vouchers/:id/reverse', requireRole('CONTROLLER', 'FOUNDER', 'ADMIN'), requireStepUp, async (req, res) => {
    const reversal = await reverseVoucher(req, String(req.params.id), reverseInput.parse(req.body).reason);
    res.status(201).json({
        reversal: await voucherDetail(reversal.id),
        voucher: await voucherDetail(String(req.params.id)),
    });
});
//# sourceMappingURL=journals.routes.js.map