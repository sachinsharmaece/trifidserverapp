import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { Hsn } from '../models/Hsn.js';
import { Product } from '../models/Product.js';
import { Technical } from '../models/Technical.js';
/**
 * Seeds the Technical and HSN masters from the products already on file, and
 * gives pre-existing products the `category`/`taxPercent` they did not have
 * (every existing product is a pesticide at the flat 18%). Run once on any
 * database created before the masters existed: `npm run backfill:catalogMasters`.
 * Idempotent; a second run finds nothing left to add or update.
 */
async function run() {
    await connectToDatabase(env.mongodbUri);
    let technicals = 0;
    for (const name of (await Product.distinct('technical'))) {
        const exists = await Technical.findOne({ name }).collation({ locale: 'en', strength: 2 });
        if (!exists) {
            await Technical.create({ name });
            technicals += 1;
        }
    }
    let hsns = 0;
    for (const code of (await Product.distinct('hsn'))) {
        if (!(await Hsn.exists({ code }))) {
            await Hsn.create({ code, taxPercent: 18 });
            hsns += 1;
        }
    }
    const category = (await Product.collection.updateMany({ category: { $exists: false } }, { $set: { category: 'pesticide' } })).modifiedCount;
    const taxPercent = (await Product.collection.updateMany({ taxPercent: { $exists: false } }, { $set: { taxPercent: 18 } })).modifiedCount;
    console.log(`Backfilled — technicals: ${technicals}, hsn: ${hsns}, ` +
        `product category: ${category}, product taxPercent: ${taxPercent}.`);
}
run()
    .then(async () => {
    await disconnectFromDatabase();
})
    .catch(async (error) => {
    console.error(error);
    await disconnectFromDatabase();
    process.exit(1);
});
