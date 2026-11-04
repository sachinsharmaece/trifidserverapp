import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { Buyer } from '../models/Buyer.js';
import { BookAssignment } from '../models/BookAssignment.js';
import { Counterparty } from '../models/Counterparty.js';
import { Employee } from '../models/Employee.js';
import { Role } from '../models/Role.js';
import { Tehsil } from '../models/Tehsil.js';
import { writeAuditLog } from '../shared/audit.js';
/**
 * 4 Nov — load each buyer's last Marg bill date (the PARTIES sheet of
 * PARTIES_BILLED_LAST_90_DAYS.xlsx, saved as CSV) onto the buyer as `lastBilledOn`, so the
 * Buyers list's "Last order" shows it. Nothing else on the buyer is touched.
 *
 * - A Marg party is matched to a buyer by firm name, ignoring case, spaces and punctuation.
 *   Only an exact one-to-one match is written; a name two buyers share, or none, is listed and
 *   left alone. Nothing is guessed from a similar name.
 * - A date only ever moves forward: a buyer already holding a later date keeps it, so a re-run
 *   (or an older sheet) changes nothing it should not.
 * - The sheet's CSV needs two columns, "PARTY (Marg name)" and "LAST BILL DATE" (yyyy-mm-dd or
 *   dd-mm-yyyy). The date is stored as noon UTC, which is the same calendar day in IST.
 * - Each change writes an audit entry, and the whole apply is one transaction preceded by a
 *   backup of the dates it replaces.
 *
 *   npm run import:margLastBills -- <parties.csv>                  dry run: the plan, nothing written
 *   ... --report <out.csv>                                         one line per Marg party with its outcome
 *   ... --apply                                                    backs up, then writes
 *   npm run import:margLastBills -- --restore <backup file>        puts the old dates back
 */
const BACKUP_DIR = fileURLToPath(new URL('../../../trifid data/backups/', import.meta.url));
function arg(name) {
    const at = process.argv.indexOf(name);
    return at > -1 ? process.argv[at + 1] : undefined;
}
/** RFC 4180 enough for a spreadsheet's CSV export: quotes, doubled quotes, newlines in a cell. */
function parseCsv(text) {
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
const nameKey = (name) => name.toUpperCase().replace(/[^A-Z0-9]/g, '');
/** `2026-10-31` or `31-10-2026` (also `/` and `.`) → noon UTC that day; null if it is not a real date. */
function parseBillDate(raw) {
    const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(raw) ??
        /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(raw);
    if (!m)
        return null;
    const [y, mo, d] = m[1].length === 4 ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]];
    const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), 12));
    return date.getUTCDate() === Number(d) && date.getUTCMonth() === Number(mo) - 1 ? date : null;
}
const day = (d) => (d ? d.toISOString().slice(0, 10) : '—');
async function adminActor() {
    const adminRole = await Role.findOne({ key: 'admin' }, { _id: 1 });
    const admin = await Employee.findOne({ roleIds: adminRole?._id, active: true }).sort({ _id: 1 });
    if (!admin)
        throw new Error('No active Admin to record this as.');
    return admin;
}
async function plan(file) {
    const rows = parseCsv(readFileSync(file, 'utf8'));
    if (!rows.length || !('PARTY (Marg name)' in rows[0]) || !('LAST BILL DATE' in rows[0])) {
        throw new Error('The CSV needs the columns "PARTY (Marg name)" and "LAST BILL DATE".');
    }
    const buyers = await Buyer.find({}, { counterpartyId: 1, tehsilId: 1, lastBilledOn: 1 }).lean();
    const counterparties = await Counterparty.find({ _id: { $in: buyers.map((b) => b.counterpartyId) }, deletedAt: null }, { firm: 1 }).lean();
    const firmById = new Map(counterparties.map((c) => [String(c._id), c.firm ?? '']));
    const byName = new Map();
    for (const b of buyers) {
        const firm = firmById.get(String(b.counterpartyId));
        if (firm)
            byName.set(nameKey(firm), [...(byName.get(nameKey(firm)) ?? []), b]);
    }
    // A party listed twice keeps its later date.
    const latest = new Map();
    for (const r of rows) {
        const party = r['PARTY (Marg name)'];
        const raw = r['LAST BILL DATE'];
        if (!party)
            continue;
        const date = parseBillDate(raw);
        const seen = latest.get(nameKey(party));
        if (!seen || (date && (!seen.date || date > seen.date)))
            latest.set(nameKey(party), { party, raw, date });
    }
    const outcomes = [];
    for (const { party, raw, date } of latest.values()) {
        const base = { party, billDate: raw };
        if (!date) {
            outcomes.push({ ...base, status: 'none', why: `"${raw}" is not a date` });
            continue;
        }
        const hits = byName.get(nameKey(party)) ?? [];
        if (hits.length === 0) {
            outcomes.push({ ...base, status: 'none', why: 'no buyer with this firm name' });
        }
        else if (hits.length > 1) {
            const where = await Promise.all(hits.map(async (b) => {
                const t = b.tehsilId ? await Tehsil.findById(b.tehsilId, { name: 1 }).lean() : null;
                const owner = await BookAssignment.findOne({ buyerId: b._id }, { ownerEmployeeId: 1 }).lean();
                const who = owner
                    ? await Employee.findById(owner.ownerEmployeeId, { person: 1 }).lean()
                    : null;
                return `${String(b._id)} (${t?.name ?? 'no tehsil'}, ${who?.person ?? 'Queue'})`;
            }));
            outcomes.push({
                ...base,
                status: 'ambiguous',
                why: `${hits.length} buyers share this name: ${where.join('; ')}`,
            });
        }
        else {
            const b = hits[0];
            const before = b.lastBilledOn ?? null;
            const buyer = { buyerId: b._id, firm: firmById.get(String(b.counterpartyId)), before };
            if (before && before > date) {
                outcomes.push({
                    ...base,
                    ...buyer,
                    status: 'newer',
                    why: `already ${day(before)}, which is later`,
                });
            }
            else if (before && before.getTime() === date.getTime()) {
                outcomes.push({ ...base, ...buyer, status: 'same', why: 'already this date' });
            }
            else {
                outcomes.push({
                    ...base,
                    ...buyer,
                    status: 'set',
                    why: `${day(before)} → ${day(date)}`,
                    to: date,
                });
            }
        }
    }
    return outcomes;
}
async function run() {
    const file = process.argv[2];
    const apply = process.argv.includes('--apply');
    const reportPath = arg('--report');
    if (!file || file.startsWith('--')) {
        throw new Error('Usage: <parties.csv> [--report <out.csv>] [--apply]   |   --restore <backup>');
    }
    if (!apply) {
        mongoose.set('autoIndex', false);
        mongoose.set('autoCreate', false);
    }
    await connectToDatabase(env.mongodbUri);
    const outcomes = await plan(file);
    const count = (s) => outcomes.filter((o) => o.status === s).length;
    console.log(`${apply ? 'Applying' : 'Dry run — nothing written'}. Marg parties: ${outcomes.length} — ` +
        `to set: ${count('set')}, already set: ${count('same')}, buyer has later: ${count('newer')}, ` +
        `ambiguous: ${count('ambiguous')}, no buyer: ${count('none')}.`);
    for (const o of outcomes.filter((x) => x.status === 'ambiguous' || x.status === 'newer')) {
        console.log(`  ${o.status.padEnd(9)} ${o.party} — ${o.why}`);
    }
    if (reportPath) {
        const cell = (v) => `"${v.replace(/"/g, '""')}"`;
        writeFileSync(reportPath, [
            'Marg party,Last bill date,Outcome,Why,Buyer firm',
            ...outcomes.map((o) => [o.party, o.billDate, o.status, o.why, o.firm ?? ''].map(cell).join(',')),
        ].join('\n'));
        console.log(`Report: ${reportPath}`);
    }
    const todo = outcomes.filter((o) => o.status === 'set');
    if (!apply) {
        console.log(`Run with -- --apply to write ${todo.length} dates.`);
        await disconnectFromDatabase();
        return;
    }
    const admin = await adminActor();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = `${BACKUP_DIR}marg-last-bills-before-${stamp}.json`;
    mkdirSync(BACKUP_DIR, { recursive: true });
    // Backup first: if it cannot be written, nothing is changed.
    writeFileSync(backupFile, JSON.stringify({
        savedAt: new Date().toISOString(),
        source: basename(file),
        buyers: todo.map((o) => ({
            buyerId: String(o.buyerId),
            firm: o.firm,
            lastBilledOn: o.before ? o.before.toISOString() : null,
        })),
    }, undefined, 2));
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            for (const o of todo) {
                const to = o.to;
                await Buyer.updateOne({ _id: o.buyerId }, { $set: { lastBilledOn: to } }, { session, timestamps: false });
                await writeAuditLog({
                    actorId: admin._id,
                    actorType: 'staff',
                    entity: 'buyer',
                    entityId: o.buyerId,
                    field: 'lastBilledOn',
                    oldValue: o.before ?? null,
                    newValue: to,
                    reason: `Last Marg bill date from ${basename(file)} (import:margLastBills)`,
                    correlationId: `marg-last-bills-${stamp}`,
                }, session);
            }
        });
    }
    finally {
        await session.endSession();
    }
    console.log(`Wrote ${todo.length} dates as ${admin.person}. Backup: ${backupFile}`);
    await disconnectFromDatabase();
}
async function restore(backupFile) {
    const backup = JSON.parse(readFileSync(backupFile, 'utf8'));
    await connectToDatabase(env.mongodbUri);
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            for (const b of backup.buyers) {
                await Buyer.updateOne({ _id: b.buyerId }, { $set: { lastBilledOn: b.lastBilledOn ? new Date(b.lastBilledOn) : null } }, { session, timestamps: false });
            }
        });
    }
    finally {
        await session.endSession();
    }
    console.log(`Restored ${backup.buyers.length} buyers' lastBilledOn from ${backupFile}.`);
    await disconnectFromDatabase();
}
const restoreAt = process.argv.indexOf('--restore');
(restoreAt >= 0 ? restore(process.argv[restoreAt + 1] ?? '') : run()).catch(async (error) => {
    console.error('Marg last-bill import failed:', error);
    await disconnectFromDatabase();
    process.exitCode = 1;
});
