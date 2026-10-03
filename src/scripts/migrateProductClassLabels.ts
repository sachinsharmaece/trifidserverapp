import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { Product } from '../models/Product.js';
import { Sku } from '../models/Sku.js';
import { MarginMatrix } from '../models/MarginMatrix.js';
import { SoLine } from '../models/SoLine.js';

/**
 * 2026-10-03 — product class was renamed from the letter grades A/B/C to
 * High/Medium/Low (client decision: letter-order mapping, A→High, B→Medium,
 * C→Low — this is the literal order, not a reflection of which class
 * carries the thinner or wider margin; see BUSINESS_RULES.md BR-041's own
 * note). Run once on any database created before this rename:
 * `npm run migrate:productClassLabels`. Idempotent; a second run finds
 * nothing left to update.
 */
const MAPPING: Record<string, 'High' | 'Medium' | 'Low'> = {
  A: 'High',
  B: 'Medium',
  C: 'Low',
};

async function run(): Promise<void> {
  await connectToDatabase(env.mongodbUri);

  const counts = { product: 0, sku: 0, marginMatrix: 0, soLine: 0 };
  for (const [from, to] of Object.entries(MAPPING)) {
    counts.product += (
      await Product.updateMany({ class: from }, { $set: { class: to } })
    ).modifiedCount;
    counts.sku += (await Sku.updateMany({ class: from }, { $set: { class: to } })).modifiedCount;
    counts.marginMatrix += (
      await MarginMatrix.updateMany({ class: from }, { $set: { class: to } })
    ).modifiedCount;
    counts.soLine += (
      await SoLine.updateMany({ classAtOrder: from }, { $set: { classAtOrder: to } })
    ).modifiedCount;
  }

  console.log(
    `Migrated — product: ${counts.product}, sku: ${counts.sku}, ` +
      `margin_matrix: ${counts.marginMatrix}, so_line: ${counts.soLine}.`,
  );
}

run()
  .then(async () => {
    await disconnectFromDatabase();
  })
  .catch(async (error: unknown) => {
    console.error('Migration failed:', error);
    await disconnectFromDatabase();
    process.exitCode = 1;
  });
