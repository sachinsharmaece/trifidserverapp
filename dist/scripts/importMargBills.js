import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { MargBillImport } from '../models/MargBillImport.js';
import { invoiceKey } from '../modules/holding/holding.bills.js';
import { arg, assertTestDatabase, flag, matchParty, parseCsv, writeReport, } from './lock34Common.js';
/**
 * LOCK-34 step 3 — loads Marg's bill history so a party's billing clock knows
 * what he bought before go-live. Columns: gstin, invoice_no, bill_date
 * (DD/MM/YYYY), net_amount (₹). Parties are matched by GSTIN; a row with no
 * matching buyer goes to the report and is never created.
 *
 *   npm run import:margBills -- <file.csv> --report out.csv           dry run
 *   npm run import:margBills -- <file.csv> --apply --report out.csv   writes
 *
 * A bill already loaded (same invoice number and date) is skipped, so a re-run
 * adds nothing twice. Run this BEFORE import:callerLists.
 */
function parseDate(text) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
    if (!m)
        return null;
    const [, d, mo, y] = m;
    const date = new Date(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T00:00:00+05:30`);
    return Number.isNaN(date.getTime()) ? null : date;
}
/** ₹ with commas and the rupee sign allowed → whole paise. */
function parseRupees(text) {
    const cleaned = text.replace(/[₹,\s]/g, '');
    if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned))
        return null;
    return Math.round(Number(cleaned) * 100);
}
async function run() {
    const file = process.argv[2];
    if (!file || file.startsWith('--'))
        throw new Error('Usage: <file.csv> [--apply] [--report out.csv]');
    const apply = flag('--apply');
    assertTestDatabase(env.mongodbUri);
    if (!apply) {
        mongoose.set('autoIndex', false);
        mongoose.set('autoCreate', false);
    }
    await connectToDatabase(env.mongodbUri);
    if (apply)
        await MargBillImport.createIndexes();
    const rows = parseCsv(readFileSync(file, 'utf8'));
    const outcomes = [];
    const seen = new Set();
    let line = 0;
    for (const row of rows) {
        line += 1;
        const detail = `${row.gstin ?? ''} ${row.invoice_no ?? ''}`.trim();
        const done = (status, why) => outcomes.push({ line, detail, status, why });
        const date = parseDate(row.bill_date ?? '');
        const netPaise = parseRupees(row.net_amount ?? '');
        if (!row.gstin || !row.invoice_no) {
            done('fail', 'gstin and invoice_no are both needed');
            continue;
        }
        if (!date) {
            done('fail', `bill_date "${row.bill_date}" is not DD/MM/YYYY`);
            continue;
        }
        if (netPaise === null) {
            done('fail', `net_amount "${row.net_amount}" is not an amount in rupees`);
            continue;
        }
        const key = invoiceKey(row.invoice_no);
        const dedupe = `${key}|${date.getTime()}`;
        if (seen.has(dedupe) || (await MargBillImport.exists({ invoiceKey: key, billDate: date }))) {
            done('skip', 'this invoice is already loaded');
            continue;
        }
        seen.add(dedupe);
        const match = await matchParty(row.gstin, undefined);
        if (!('buyerId' in match)) {
            done('fail', match.reason);
            continue;
        }
        if (apply) {
            await MargBillImport.create({
                gstin: row.gstin.trim().toUpperCase(),
                partyId: match.buyerId,
                invoiceNo: row.invoice_no,
                invoiceKey: key,
                billDate: date,
                netPaise,
            });
        }
        done('ok', apply ? 'loaded' : 'would load');
    }
    writeReport(arg('--report'), outcomes);
    await disconnectFromDatabase();
}
run().catch(async (error) => {
    console.error('import:margBills failed:', error);
    await disconnectFromDatabase();
    process.exitCode = 1;
});
