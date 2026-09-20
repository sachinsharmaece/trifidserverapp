/**
 * CH §24.5–§24.7 / ARCHITECTURE.md §8 — "restore tested by actually restoring
 * before launch". This is that test, as a repeatable script.
 *
 *   npm run drill:restore -- [--source-uri URI] [--target-uri URI] [--out DIR] [--keep]
 *
 * 1. BACKUP  — reads every collection of the source database (read-only; it never
 *              writes to the source) into one canonical-EJSON file per collection,
 *              plus a manifest of counts, content hashes and index definitions.
 * 2. RESTORE — loads those files into the TARGET database and recreates its indexes.
 * 3. VERIFY  — for every collection: same document count, same content hash (a
 *              SHA-256 over every document in `_id` order, so a single changed
 *              field anywhere fails it), and the same index key sets.
 *
 * The source defaults to MONGODB_URI. The target defaults to a throw-away
 * in-memory replica set, so nothing is ever written to a shared cluster unless
 * `--target-uri` is given on purpose. Exits non-zero on any mismatch.
 *
 * What this does NOT prove, and no script can: that the hosting provider's own
 * snapshots exist, that point-in-time recovery reaches back "to within minutes",
 * or that the off-site copy at a second provider is readable. Those are provider
 * settings the owner must exercise — see docs/backup-restore.md.
 */
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { env } from '../config/env.js';

const { MongoClient, BSON } = mongoose.mongo;
const { EJSON } = BSON;
const BATCH = 1000;

interface IndexDef {
  key: Record<string, number | string>;
  name: string;
  options: Record<string, unknown>;
}
interface CollectionEntry {
  name: string;
  count: number;
  sha256: string;
  bytes: number;
  indexes: IndexDef[];
}
interface Manifest {
  takenAt: string;
  sourceDb: string;
  collections: CollectionEntry[];
}

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const INDEX_OPTION_KEYS = [
  'unique',
  'sparse',
  'partialFilterExpression',
  'expireAfterSeconds',
  'collation',
  'weights',
  'default_language',
] as const;

function toIndexDef(raw: Record<string, unknown>): IndexDef {
  const options: Record<string, unknown> = {};
  for (const key of INDEX_OPTION_KEYS) if (raw[key] !== undefined) options[key] = raw[key];
  return { key: raw.key as IndexDef['key'], name: raw.name as string, options };
}

const line = (doc: unknown): string => EJSON.stringify(doc, { relaxed: false });

async function backup(sourceUri: string, outDir: string): Promise<Manifest> {
  const client = new MongoClient(sourceUri);
  await client.connect();
  try {
    const db = client.db(); // the database named in the URI
    const collections: CollectionEntry[] = [];
    const infos = await db.listCollections({}, { nameOnly: true }).toArray();
    for (const info of infos
      .filter((c) => !c.name.startsWith('system.'))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const collection = db.collection(info.name);
      const hash = createHash('sha256');
      const file = join(outDir, `${info.name}.jsonl`);
      const out = createWriteStream(file);
      let count = 0;
      for await (const doc of collection.find({}).sort({ _id: 1 })) {
        const text = line(doc);
        hash.update(text + '\n');
        if (!out.write(text + '\n')) await once(out, 'drain');
        count += 1;
      }
      out.end();
      await once(out, 'finish');
      const indexes = (await collection.indexes()).filter((i) => i.name !== '_id_').map(toIndexDef);
      collections.push({
        name: info.name,
        count,
        sha256: hash.digest('hex'),
        bytes: statSync(file).size,
        indexes,
      });
    }
    return { takenAt: new Date().toISOString(), sourceDb: db.databaseName, collections };
  } finally {
    await client.close();
  }
}

async function restore(targetUri: string, outDir: string, manifest: Manifest): Promise<string> {
  const client = new MongoClient(targetUri);
  await client.connect();
  try {
    const db = client.db();
    await db.dropDatabase(); // the target is a scratch database by contract
    for (const entry of manifest.collections) {
      const collection = db.collection(entry.name);
      let batch: Record<string, unknown>[] = [];
      const reader = createInterface({
        input: createReadStream(join(outDir, `${entry.name}.jsonl`)),
      });
      for await (const text of reader) {
        if (!text) continue;
        batch.push(EJSON.parse(text, { relaxed: false }) as Record<string, unknown>);
        if (batch.length === BATCH) {
          await collection.insertMany(batch, { ordered: true });
          batch = [];
        }
      }
      if (batch.length > 0) await collection.insertMany(batch, { ordered: true });
      if (entry.count === 0) await db.createCollection(entry.name).catch(() => undefined);
      for (const index of entry.indexes) {
        await collection.createIndex(index.key as never, { name: index.name, ...index.options });
      }
    }
    return db.databaseName;
  } finally {
    await client.close();
  }
}

async function verify(targetUri: string, manifest: Manifest): Promise<string[]> {
  const client = new MongoClient(targetUri);
  await client.connect();
  const problems: string[] = [];
  try {
    const db = client.db();
    for (const entry of manifest.collections) {
      const collection = db.collection(entry.name);
      const hash = createHash('sha256');
      let count = 0;
      for await (const doc of collection.find({}).sort({ _id: 1 })) {
        hash.update(line(doc) + '\n');
        count += 1;
      }
      if (count !== entry.count)
        problems.push(`${entry.name}: ${count} documents restored, ${entry.count} backed up`);
      else if (hash.digest('hex') !== entry.sha256)
        problems.push(`${entry.name}: content differs from the backup`);
      const restored = (await collection.indexes())
        .filter((i) => i.name !== '_id_')
        .map((i) => JSON.stringify(i.key));
      for (const index of entry.indexes) {
        if (!restored.includes(JSON.stringify(index.key)))
          problems.push(`${entry.name}: index ${index.name} missing after restore`);
      }
    }
    const restoredNames = (await db.listCollections({}, { nameOnly: true }).toArray()).map(
      (c) => c.name,
    );
    for (const entry of manifest.collections) {
      if (!restoredNames.includes(entry.name))
        problems.push(`${entry.name}: collection missing after restore`);
    }
  } finally {
    await client.close();
  }
  return problems;
}

async function main(): Promise<void> {
  const sourceUri = arg('source-uri') ?? env.mongodbUri;
  const outDir = arg('out') ?? join(process.cwd(), '.restore-drill', `run-${Date.now()}`);
  const keep = process.argv.includes('--keep');
  mkdirSync(outDir, { recursive: true });

  let scratch: MongoMemoryReplSet | null = null;
  let targetUri = arg('target-uri');
  if (!targetUri) {
    scratch = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    targetUri = scratch.getUri('trifid_restore_drill');
  }
  if (targetUri === sourceUri) throw new Error('Refusing to restore onto the source database.');

  try {
    const t0 = performance.now();
    const manifest = await backup(sourceUri, outDir);
    const backupMs = performance.now() - t0;
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const t1 = performance.now();
    const restoredDb = await restore(targetUri, outDir, manifest);
    const restoreMs = performance.now() - t1;

    const t2 = performance.now();
    const problems = await verify(targetUri, manifest);
    const verifyMs = performance.now() - t2;

    const docs = manifest.collections.reduce((n, c) => n + c.count, 0);
    const bytes = manifest.collections.reduce((n, c) => n + c.bytes, 0);
    const report = {
      sourceDb: manifest.sourceDb,
      restoredInto: restoredDb,
      collections: manifest.collections.length,
      documents: docs,
      backupBytes: bytes,
      backupSeconds: +(backupMs / 1000).toFixed(2),
      restoreSeconds: +(restoreMs / 1000).toFixed(2),
      verifySeconds: +(verifyMs / 1000).toFixed(2),
      problems,
      perCollection: manifest.collections.map((c) => ({
        name: c.name,
        count: c.count,
        indexes: c.indexes.length,
      })),
    };
    writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    console.info(JSON.stringify(report, null, 2));
    if (problems.length > 0) process.exitCode = 1;
  } finally {
    if (scratch) await scratch.stop();
    if (!keep) {
      // Nothing personal should linger on a developer disk: the dump holds real documents.
      rmSync(outDir, { recursive: true, force: true });
    } else {
      console.info(`Backup kept at ${outDir} (it contains real documents — delete it when done).`);
    }
  }
}

void main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(String(error));
    process.exit(1);
  },
);
