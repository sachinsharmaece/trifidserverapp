import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { Product } from '../models/Product.js';
import { SellerCatalogueEntry } from '../models/SellerCatalogueEntry.js';
import { SellerDealership } from '../models/SellerDealership.js';

/**
 * Seeds `seller_dealership` from what each seller already carries: a seller
 * with a catalogue entry for any product of company X is recorded as dealing
 * in X. Run once on a database that predates seller dealerships:
 * `npm run backfill:sellerDealerships` (dry run, prints what it would add) or
 * `npm run backfill:sellerDealerships -- --apply`.
 *
 * Read the dry run before applying: ticking a company makes ALL of its
 * products count as carried for that seller (Carries, open demand, supply
 * matrix), not only the one he was recorded for. Idempotent — a second run
 * finds nothing left to add. Existing catalogue entries are never touched.
 */
async function run(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await connectToDatabase(env.mongodbUri);

  const entries = await SellerCatalogueEntry.find({}, { sellerId: 1, productId: 1 });
  const products = await Product.find(
    { _id: { $in: entries.map((e) => e.productId) } },
    { manufacturerId: 1 },
  );
  const manufacturerByProduct = new Map(
    products.map((p) => [p._id.toString(), p.manufacturerId.toString()]),
  );

  const wanted = new Set<string>();
  for (const e of entries) {
    const manufacturerId = manufacturerByProduct.get(e.productId.toString());
    if (manufacturerId) wanted.add(`${e.sellerId.toString()}:${manufacturerId}`);
  }

  const existing = new Set(
    (await SellerDealership.find({}, { sellerId: 1, manufacturerId: 1 })).map(
      (d) => `${d.sellerId.toString()}:${d.manufacturerId.toString()}`,
    ),
  );
  const toAdd = [...wanted].filter((key) => !existing.has(key));

  if (apply && toAdd.length > 0) {
    await SellerDealership.insertMany(
      toAdd.map((key) => {
        const [sellerId, manufacturerId] = key.split(':');
        return { sellerId, manufacturerId, setBy: null };
      }),
    );
  }
  console.log(
    `${apply ? 'Added' : 'Would add (dry run — pass --apply)'} ${toAdd.length} seller dealership(s); ` +
      `${existing.size} already present.`,
  );
}

run()
  .then(async () => {
    await disconnectFromDatabase();
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await disconnectFromDatabase();
    process.exit(1);
  });
