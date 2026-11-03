import { writeFileSync } from 'node:fs';
import { Buyer } from '../models/Buyer.js';
import { Counterparty } from '../models/Counterparty.js';
import { isPlaceholderMobile } from '../shared/placeholders.js';
export function arg(name) {
    const at = process.argv.indexOf(name);
    return at > -1 ? process.argv[at + 1] : undefined;
}
export function flag(name) {
    return process.argv.includes(name);
}
/** Local databases, and the one named in LOCK34_TEST_DB_MARKER (part of the test cluster's URI), count as test. */
export function assertTestDatabase(uri) {
    const local = /^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri);
    const marker = process.env.LOCK34_TEST_DB_MARKER;
    if (local || (marker && uri.includes(marker)) || flag('--i-know-this-is-prod'))
        return;
    throw new Error('This is not the test database. Set LOCK34_TEST_DB_MARKER to part of the test database URI, ' +
        'or pass --i-know-this-is-prod if you really mean it.');
}
/** RFC 4180 enough for a spreadsheet CSV export: quotes, doubled quotes, newlines in a cell. */
export function parseCsv(text) {
    const records = [];
    let field = '';
    let record = [];
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') {
                field += '"';
                i += 1;
            }
            else if (c === '"')
                quoted = false;
            else
                field += c;
        }
        else if (c === '"')
            quoted = true;
        else if (c === ',') {
            record.push(field);
            field = '';
        }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n')
                i += 1;
            record.push(field);
            records.push(record);
            record = [];
            field = '';
        }
        else
            field += c;
    }
    if (field || record.length)
        records.push([...record, field]);
    const [header, ...body] = records.filter((r) => r.some((cell) => cell.trim()));
    if (!header)
        return [];
    const keys = header.map((h) => (h.charCodeAt(0) === 0xfeff ? h.slice(1) : h).trim());
    return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}
export function writeReport(path, outcomes) {
    const count = (s) => outcomes.filter((o) => o.status === s).length;
    console.log(`${flag('--apply') ? 'Applied' : 'Dry run — nothing written'}. Rows: ${outcomes.length} — ` +
        `ok: ${count('ok')}, skipped: ${count('skip')}, failed: ${count('fail')}.`);
    for (const o of outcomes.filter((x) => x.status !== 'ok')) {
        console.log(`  ${o.status}  row ${o.line}  ${o.detail} — ${o.why}`);
    }
    if (!path)
        return;
    const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
    writeFileSync(path, [
        'Row,Detail,Outcome,Why',
        ...outcomes.map((o) => [o.line, o.detail, o.status, o.why].map(cell).join(',')),
    ].join('\n'));
    console.log(`Report: ${path}`);
}
/**
 * The buyer a row means: by GSTIN, then by a real mobile. A placeholder mobile
 * never matches anything. Two buyers on one mobile is ambiguous, not a match.
 */
export async function matchParty(gstin, mobile) {
    const g = gstin?.trim().toUpperCase();
    if (g) {
        const cp = await Counterparty.findOne({ gstin: g }, { _id: 1 }).lean();
        const buyer = cp ? await Buyer.findOne({ counterpartyId: cp._id }, { _id: 1 }).lean() : null;
        if (buyer)
            return { buyerId: String(buyer._id) };
    }
    const m = mobile?.trim();
    if (m && !isPlaceholderMobile(m)) {
        const cps = await Counterparty.find({ $or: [{ mobile: m }, { contactMobile: m }] }, { _id: 1 }).lean();
        const buyers = cps.length
            ? await Buyer.find({ counterpartyId: { $in: cps.map((c) => c._id) } }, { _id: 1 }).lean()
            : [];
        if (buyers.length === 1)
            return { buyerId: String(buyers[0]._id) };
        if (buyers.length > 1)
            return { reason: 'more than one buyer uses that mobile' };
    }
    return { reason: 'no buyer with that GSTIN or mobile (this script never creates one)' };
}
