import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose, { type ClientSession, type Types } from 'mongoose';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { Employee } from '../models/Employee.js';
import { Role } from '../models/Role.js';
import { writeAuditLog } from '../shared/audit.js';

/**
 * 4 Nov — remove the demo and dummy products from the database for good, with
 * everything that exists only because of them: their packs, listings, asks,
 * quotes, piles, pools, and every order made on them (its chain, PO,
 * inspection, bills, receipts and bank-book entries). This is NOT the soft
 * delete on Manage → Products — nothing is left to Restore from the app.
 *
 * What it will not do:
 *  - touch `audit_log` (append-only, CH §17.6): the history of these rows stays,
 *    and one `purge` entry per product is added to it;
 *  - touch a manufacturer, seller, buyer or any other master — only products
 *    and what hangs off them;
 *  - delete anything shared with a product it is not purging. A listing, order,
 *    receipt or bank-book entry that mixes the two, or any row outside the plan
 *    that still points at a purged id, stops the run before a single write.
 *
 * The whole delete is one transaction, and a backup of every row it removes is
 * written first (extended JSON, so ids, dates and amounts come back exactly).
 *
 *   npm run purge:demoProducts                        dry run: the plan, nothing written
 *   npm run purge:demoProducts -- --apply             backs up, then deletes
 *   npm run purge:demoProducts -- --restore <file>    puts a backup's rows back
 */
const TARGETS: ReadonlyArray<readonly [brand: string, manufacturer: string]> = [
  // Seeded by `npm run seed:m5-demo`.
  ['CropShield', 'Bharat Agro Chemicals'],
  ['NeemGuard', 'Malwa Bio Sciences'],
  // Made by hand while trying the app out.
  ['ayurved', 'Malwa Bio Sciences'],
  ['kem', 'MBF'],
  ['marshal-t1', 'fmc1-t'],
  ['Organic Vermicompost', 'Bharat Aurved'],
  // The 25 Sep "DEMO …" batch.
  ['DEMO BadHSN Test', 'DEMO UPL Ltd'],
  ['DEMO GrassOut', 'DEMO Dhanuka Agritech'],
  ['DEMO ThiaMax', 'DEMO Dhanuka Agritech'],
  ['DEMO FungiClear', 'DEMO UPL Ltd'],
  ['DEMO AphidStop', 'DEMO UPL Ltd'],
  ['DEMO LarvaKill', 'DEMO Coromandel'],
  ['DEMO HexaGuard', 'DEMO Coromandel'],
  ['DEMO ImidaPro', 'Syngenta'],
  ['DEMO WeedZero', 'Bharat Agro Chemicals'],
  ['DEMO MancoPlus', 'Malwa Bio Sciences'],
  ['DEMO BioNeem', 'Malwa Bio Sciences'],
];

const BACKUP_DIR = fileURLToPath(new URL('../../../trifid data/backups/', import.meta.url));
const { EJSON } = mongoose.mongo.BSON;

type Id = Types.ObjectId;
type Db = NonNullable<typeof mongoose.connection.db>;
/** Collection name → the `_id`s to delete, in the order they are removed. */
type Plan = Map<string, Id[]>;
type Dangling = Map<string, { count: number; example: string }>;

function dbHandle(): Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database connection is not established.');
  return db;
}

function unique(list: Id[]): Id[] {
  return [...new Map(list.map((id) => [String(id), id])).values()];
}

/** Everything that exists only because of these products, collection by collection. */
async function buildPlan(
  db: Db,
  productIds: Id[],
  session?: ClientSession,
): Promise<{ plan: Plan; problems: string[] }> {
  const problems: string[] = [];
  const within = (list: Id[]) => ({ $in: list });
  const ids = async (name: string, filter: Record<string, unknown>): Promise<Id[]> =>
    (
      await db
        .collection(name)
        .find(filter, { projection: { _id: 1 }, session })
        .toArray()
    ).map((d) => d._id as Id);
  const distinct = async (name: string, field: string, filter: Record<string, unknown>) =>
    (await db.collection(name).distinct(field, filter, { session })) as Id[];
  const stray = async (what: string, name: string, filter: Record<string, unknown>) => {
    const n = (await ids(name, filter)).length;
    if (n) problems.push(`${n} ${what}`);
  };

  // Packs, listings and what sits on a listing line.
  const skus = await ids('sku', { productId: within(productIds) });
  const byProduct = await ids('listing', { productId: within(productIds) });
  const listings = unique([
    ...byProduct,
    ...(await distinct('listing_line', 'listingId', { skuId: within(skus) })),
  ]);
  const lines = await ids('listing_line', {
    $or: [{ skuId: within(skus) }, { listingId: within(listings) }],
  });
  await stray('listing line(s) of other products inside these listings', 'listing_line', {
    listingId: within(listings),
    skuId: { $nin: skus },
  });
  const piles = await ids('pile', { listingLineId: within(lines) });
  const pileRequests = await ids('pile_request', { pileId: within(piles) });
  const claims = await ids('claim', { pileId: within(piles) });

  // Demand.
  const asks = await ids('ask', {
    $or: [{ productId: within(productIds) }, { skuId: within(skus) }],
  });
  const quotes = await ids('quote', {
    $or: [{ askId: within(asks) }, { skuId: within(skus) }, { listingLineId: within(lines) }],
  });
  const pools = await ids('pool', { skuId: within(skus) });

  // Orders made on these packs, and the whole chain behind each.
  const soLines = await ids('so_line', { skuId: within(skus) });
  const orders = await distinct('so_line', 'soId', { skuId: within(skus) });
  await stray('order line(s) of other products inside these orders', 'so_line', {
    soId: within(orders),
    skuId: { $nin: skus },
  });
  const chains = await distinct('so', 'chainId', { _id: within(orders) });
  await stray('order(s) outside the plan on these chains', 'so', {
    chainId: within(chains),
    _id: { $nin: orders },
  });
  await stray('order(s) outside the plan raised from these asks or pile requests', 'so', {
    $or: [{ askId: within(asks) }, { pileRequestId: within(pileRequests) }],
    _id: { $nin: orders },
  });
  const pos = await ids('po', { $or: [{ soId: within(orders) }, { chainId: within(chains) }] });
  await stray('PO line(s) of other products inside these POs', 'po_line', {
    poId: within(pos),
    skuId: { $nin: skus },
  });
  const poLines = await ids('po_line', { $or: [{ poId: within(pos) }, { skuId: within(skus) }] });
  const sellerBills = await ids('seller_bill', { poId: within(pos) });
  const complaints = await ids('complaint', { soId: within(orders) });
  const movements = await ids('movement', { chainId: within(chains) });
  await stray('consolidation(s) over these movements (not handled)', 'consolidation', {
    movementIds: within(movements),
  });
  const poolCommitments = await ids('pool_commitment', {
    $or: [{ poolId: within(pools) }, { soId: within(orders) }],
  });

  // Money: a receipt or bank-book entry goes only if every order on it goes.
  const gone = new Set(orders.map(String));
  const wholly = async (name: string, filter: Record<string, unknown>): Promise<Id[]> => {
    const rows = await db
      .collection(name)
      .find(filter, { projection: { soIds: 1 }, session })
      .toArray();
    const mixed = rows.filter((r) => ((r.soIds ?? []) as Id[]).some((s) => !gone.has(String(s))));
    if (mixed.length) problems.push(`${mixed.length} ${name} row(s) also settle other orders`);
    return rows.map((r) => r._id as Id);
  };
  const receipts = await wholly('upcoming_receipt', { soIds: within(orders) });
  const bankbook0 = await wholly('bankbook', { soIds: within(orders) });
  const bankbook = unique([
    ...bankbook0,
    ...(await ids('bankbook', { reversalOf: within(bankbook0) })),
  ]);

  // Queued messages and jobs that name these asks, piles, listings or orders. The ids sit in
  // loosely typed fields (`params`, `data`), so match them as ObjectIds and as strings.
  const loose = (list: Id[]) => ({ $in: [...list, ...list.map(String)] });
  const named = [...piles, ...orders, ...pos, ...chains, ...asks].map(String);
  const outbox = await ids('notification_outbox', {
    $or: [
      { 'params.askId': loose(asks) },
      { 'params.pileId': loose(piles) },
      { 'params.listingId': loose(listings) },
      ...(named.length ? [{ correlationId: new RegExp(named.join('|')) }] : []),
    ],
  });
  const jobs = await db
    .collection('agenda_jobs')
    .find({ 'data.pileId': loose(piles) }, { projection: { lastFinishedAt: 1 }, session })
    .toArray();
  const unfinished = jobs.filter((j) => !j.lastFinishedAt).length;
  if (unfinished) problems.push(`${unfinished} background job(s) on these piles have not finished`);

  const plan: Plan = new Map<string, Id[]>([
    ['notification_log', await ids('notification_log', { outboxId: within(outbox) })],
    ['notification_outbox', outbox],
    ['agenda_jobs', jobs.map((j) => j._id as Id)],
    [
      'product_margin_matrix',
      await ids('product_margin_matrix', { productId: within(productIds) }),
    ],
    ['pool_commitment', poolCommitments],
    ['pool', pools],
    ['quote', quotes],
    [
      'non_order_reason',
      await ids('non_order_reason', { $or: [{ askId: within(asks) }, { pileId: within(piles) }] }),
    ],
    [
      'call_log',
      await ids('call_log', {
        $or: [{ listingLineId: within(lines) }, { producedAskId: within(asks) }],
      }),
    ],
    [
      'enquiry',
      await ids('enquiry', {
        $or: [
          { productId: within(productIds) },
          { skuId: within(skus) },
          { askId: within(asks) },
          { pileRequestId: within(pileRequests) },
        ],
      }),
    ],
    ['ask', asks],
    ['claim', claims],
    ['pile_request', pileRequests],
    ['pile', piles],
    ['listing_line', lines],
    ['listing', listings],
    ['bankbook', bankbook],
    ['upcoming_receipt', receipts],
    ['rate_override', await ids('rate_override', { soLineId: within(soLines) })],
    [
      'promotion_offer',
      await ids('promotion_offer', {
        $or: [{ soId: within(orders) }, { poId: within(pos) }, { chainId: within(chains) }],
      }),
    ],
    [
      'debit_note',
      await ids('debit_note', {
        $or: [
          { poId: within(pos) },
          { sellerBillId: within(sellerBills) },
          { complaintId: within(complaints) },
        ],
      }),
    ],
    ['return_note', await ids('return_note', { poId: within(pos) })],
    ['refund', await ids('refund', { chainId: within(chains) })],
    ['complaint', complaints],
    ['receipt_confirmation', await ids('receipt_confirmation', { poId: within(pos) })],
    ['inspection', await ids('inspection', { poId: within(pos) })],
    ['seller_bill', sellerBills],
    ['marg_bill', await ids('marg_bill', { soId: within(orders) })],
    ['po_edit', await ids('po_edit', { poId: within(pos) })],
    ['po_line', poLines],
    ['po', pos],
    ['movement', movements],
    ['stock_hold', await ids('stock_hold', { soId: within(orders) })],
    ['failure_event', await ids('failure_event', { chainId: within(chains) })],
    ['chain_event', await ids('chain_event', { chainId: within(chains) })],
    ['so_line', soLines],
    ['so', orders],
    ['chain', chains],
    ['pulse_event', await ids('pulse_event', { productId: within(productIds) })],
    ['msp_request', await ids('msp_request', { skuId: within(skus) })],
    [
      'seller_catalogue_entry',
      await ids('seller_catalogue_entry', { productId: within(productIds) }),
    ],
    ['sku', skus],
    ['product', productIds],
  ]);
  return { plan, problems };
}

/** Every ObjectId, and every 24-hex string, anywhere inside a value. */
function walk(value: unknown, path: string, hit: (path: string, id: string) => void): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    for (const m of value.match(/[0-9a-f]{24}/g) ?? []) hit(path, m);
    return;
  }
  if (typeof value !== 'object') return;
  const bson = (value as { _bsontype?: string })._bsontype;
  if (bson === 'ObjectId') return hit(path, String(value));
  if (bson || value instanceof Date) return;
  if (Array.isArray(value)) {
    for (const v of value) walk(v, `${path}[]`, hit);
    return;
  }
  for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, hit);
}

/**
 * Rows OUTSIDE the plan that still point at something the plan deletes — the
 * proof that nothing is left dangling. `audit_log` is left out on purpose.
 */
async function findDangling(db: Db, plan: Plan, session?: ClientSession): Promise<Dangling> {
  const gone = new Set<string>();
  const planned = new Map<string, Set<string>>();
  for (const [name, list] of plan) {
    planned.set(name, new Set(list.map(String)));
    for (const id of list) gone.add(String(id));
  }
  const found: Dangling = new Map();
  // No session here: MongoDB does not allow listCollections inside a transaction.
  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.') && n !== 'audit_log');
  for (const name of names) {
    const own = planned.get(name);
    for await (const doc of db.collection(name).find({}, { session })) {
      if (own?.has(String(doc._id))) continue;
      walk(doc, '', (path, id) => {
        if (!gone.has(id)) return;
        const key = `${name}.${path}`;
        const seen = found.get(key);
        if (seen) seen.count += 1;
        else found.set(key, { count: 1, example: String(doc._id) });
      });
    }
  }
  return found;
}

async function describeOrders(db: Db, orders: Id[], session?: ClientSession): Promise<string[]> {
  const firm = async (collection: string, id: unknown): Promise<string> => {
    const party = await db.collection(collection).findOne({ _id: id as Id }, { session });
    const cp = party
      ? await db
          .collection('counterparty')
          .findOne({ _id: party.counterpartyId as Id }, { session })
      : null;
    return String(cp?.firm ?? '?');
  };
  const rows = await db
    .collection('so')
    .find({ _id: { $in: orders } }, { session })
    .sort({ createdAt: 1 })
    .toArray();
  const out: string[] = [];
  for (const so of rows) {
    out.push(
      `    ${so.soNo} ${so.state} ₹${Math.round(Number(so.totalPaise) / 100)} — ` +
        `${await firm('buyer', so.buyerId)} → ${await firm('seller', so.sellerId)}`,
    );
  }
  return out;
}

function report(plan: Plan, problems: string[], dangling: Dangling): void {
  console.log('Plan — rows to delete, by collection:');
  for (const [name, list] of plan)
    if (list.length) console.log(`  ${String(list.length).padStart(4)}  ${name}`);
  const total = [...plan.values()].reduce((n, l) => n + l.length, 0);
  console.log(`  ${String(total).padStart(4)}  total`);
  for (const p of problems) console.log(`  PROBLEM  ${p}`);
  for (const [key, d] of dangling) {
    console.log(
      `  DANGLING ${key} — ${d.count} row(s) outside the plan still point at it (e.g. ${d.example})`,
    );
  }
}

async function purge(apply: boolean): Promise<void> {
  const db = dbHandle();
  const adminRole = await Role.findOne({ key: 'admin' }, { _id: 1 });
  const admin = await Employee.findOne({ roleIds: adminRole?._id, active: true }).sort({ _id: 1 });
  if (!admin) throw new Error('No active Admin to record the purge as.');

  // Every product by brand AND manufacturer — soft-deleted ones included.
  const products: Array<{ id: Id; brand: string; manufacturer: string }> = [];
  for (const [brand, manufacturer] of TARGETS) {
    const m = await db.collection('manufacturer').findOne({ name: manufacturer });
    const found = m
      ? await db.collection('product').find({ brand, manufacturerId: m._id }).toArray()
      : [];
    if (found.length > 1)
      throw new Error(`${found.length} products match ${brand} (${manufacturer}) — not guessing.`);
    if (found.length === 0) console.log(`  not found  ${brand} (${manufacturer}) — already gone`);
    else products.push({ id: found[0]!._id as Id, brand, manufacturer });
  }
  const productIds = products.map((p) => p.id);
  console.log(`Products: ${products.length} of ${TARGETS.length} targets present.`);
  if (productIds.length === 0) return;

  if (!apply) {
    const { plan, problems } = await buildPlan(db, productIds);
    const dangling = await findDangling(db, plan);
    report(plan, problems, dangling);
    console.log('  Orders that would go:');
    for (const line of await describeOrders(db, plan.get('so') ?? [])) console.log(line);
    console.log(
      problems.length || dangling.size
        ? 'Dry run — nothing written. Resolve the above before --apply: it would refuse.'
        : `Dry run — nothing written. Clean: run with -- --apply to delete as ${admin.person}.`,
    );
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupFile = `${BACKUP_DIR}demo-products-purge-${stamp}.json`;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(
      async () => {
        const { plan, problems } = await buildPlan(db, productIds, session);
        const dangling = await findDangling(db, plan, session);
        report(plan, problems, dangling);
        if (problems.length || dangling.size) {
          throw new Error(
            'Refusing to delete — see PROBLEM / DANGLING above. Nothing was written.',
          );
        }

        // Backup first: if it cannot be written, nothing is deleted.
        const collections: Record<string, unknown[]> = {};
        for (const [name, list] of plan) {
          if (list.length) {
            collections[name] = await db
              .collection(name)
              .find({ _id: { $in: list } }, { session })
              .toArray();
          }
        }
        mkdirSync(BACKUP_DIR, { recursive: true });
        writeFileSync(
          backupFile,
          EJSON.stringify(
            {
              savedAt: new Date().toISOString(),
              products: products.map((p) => `${p.brand} (${p.manufacturer})`),
              collections,
            },
            undefined,
            2,
            { relaxed: false },
          ),
        );
        console.log(`Backup: ${backupFile}`);

        for (const [name, list] of plan) {
          if (!list.length) continue;
          const { deletedCount } = await db
            .collection(name)
            .deleteMany({ _id: { $in: list } }, { session });
          if (deletedCount !== list.length) {
            throw new Error(`${name}: deleted ${deletedCount} of ${list.length} — rolling back.`);
          }
        }
        for (const p of products) {
          await writeAuditLog(
            {
              actorId: admin._id,
              actorType: 'staff',
              entity: 'product',
              entityId: p.id,
              field: 'purge',
              oldValue: { brand: p.brand, manufacturer: p.manufacturer },
              newValue: { purged: true, backup: basename(backupFile) },
              reason: 'Demo/dummy product purge (purge:demoProducts)',
              correlationId: `demo-products-purge-${stamp}`,
            },
            session,
          );
        }
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
  } finally {
    await session.endSession();
  }
  console.log(`Purged ${products.length} products and everything on them, as ${admin.person}.`);
}

/** Puts a backup's rows back, all or nothing; refuses if any of them already exists. */
async function restore(file: string): Promise<void> {
  const db = dbHandle();
  const data = EJSON.parse(readFileSync(file, 'utf8'), { relaxed: false }) as {
    collections: Record<string, Array<Record<string, unknown>>>;
  };
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const [name, docs] of Object.entries(data.collections)) {
        await db.collection(name).insertMany(docs, { session });
        console.log(`  ${String(docs.length).padStart(4)}  ${name}`);
      }
    });
  } finally {
    await session.endSession();
  }
  console.log(`Restored from ${file}.`);
}

async function run(): Promise<void> {
  const at = process.argv.indexOf('--restore');
  const apply = process.argv.includes('--apply');
  if (at >= 0 && !process.argv[at + 1]) throw new Error('Usage: --restore <backup file>');
  if (!apply && at < 0) {
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
  }
  await connectToDatabase(env.mongodbUri);
  if (at >= 0) await restore(process.argv[at + 1]!);
  else await purge(apply);
  await disconnectFromDatabase();
}

run().catch(async (error: unknown) => {
  console.error('Demo product purge failed:', error);
  await disconnectFromDatabase();
  process.exitCode = 1;
});
