import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { Pile } from '../models/Pile.js';
/**
 * 2 Nov — BR-136 (sequential piles): a listing line can now take a new group of requests once the
 * last was confirmed and its orders made, so the old UNIQUE index on `pile.listingLineId` has to go.
 * The one-open-group-per-line rule moves to the partial unique index `one_open_pile_per_line`.
 *
 *   npm run migrate:pileIndex                 dry run: shows the indexes and what would change, writes nothing
 *   npm run migrate:pileIndex -- --apply      drops the old unique index and builds the two new ones
 *
 * Safe to run BEFORE the new code is deployed: the old code never opens a second group, so it is
 * unaffected by the unique rule being gone. Idempotent. Touches indexes only, never documents.
 * To go back (only while no line has two groups): recreate the unique index on `{ listingLineId: 1 }`.
 */
const apply = process.argv.includes('--apply');
const isOldUnique = (i) => i.unique === true && Object.keys(i.key).length === 1 && i.key.listingLineId === 1;
async function run() {
    if (!apply) {
        // A dry run must not create anything, not even the new indexes at start-up.
        mongoose.set('autoIndex', false);
        mongoose.set('autoCreate', false);
    }
    await connectToDatabase(env.mongodbUri);
    const collection = Pile.collection;
    const indexes = await collection.indexes();
    console.log('Indexes on pile now:');
    for (const i of indexes) {
        console.log(`  ${i.name}  ${JSON.stringify(i.key)}${i.unique ? '  UNIQUE' : ''}` +
            (i.partialFilterExpression ? `  partial ${JSON.stringify(i.partialFilterExpression)}` : ''));
    }
    const old = indexes.find(isOldUnique);
    const hasOneOpen = indexes.some((i) => i.name === 'one_open_pile_per_line');
    const hasByLine = indexes.some((i) => i.name === 'piles_by_line');
    const total = await collection.countDocuments({});
    const multi = await collection
        .aggregate([
        { $group: { _id: '$listingLineId', n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
        { $count: 'lines' },
    ])
        .toArray();
    const open = await collection
        .aggregate([
        { $match: { decision: null } },
        { $group: { _id: '$listingLineId', n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
        { $count: 'lines' },
    ])
        .toArray();
    console.log(`\nPiles: ${total}. Lines with more than one group today: ${multi[0]?.lines ?? 0}.`);
    const dupOpen = open[0]?.lines ?? 0;
    if (dupOpen > 0) {
        throw new Error(`${dupOpen} line(s) already have more than one OPEN group — the new unique index cannot be built. Fix them first.`);
    }
    console.log('\nPlan:');
    console.log(old ? `  drop the old unique index ${old.name}` : '  old unique index: already gone');
    console.log(hasOneOpen ? '  one_open_pile_per_line: present' : '  create one_open_pile_per_line');
    console.log(hasByLine ? '  piles_by_line: present' : '  create piles_by_line');
    if (!apply) {
        console.log('\nDry run — nothing written. Run with -- --apply to make the change.');
        return;
    }
    if (old?.name)
        await collection.dropIndex(old.name);
    await Pile.createIndexes();
    console.log('\nDone. Indexes on pile now:');
    for (const i of await collection.indexes())
        console.log(`  ${i.name}  ${JSON.stringify(i.key)}`);
}
run()
    .then(async () => {
    await disconnectFromDatabase();
})
    .catch(async (error) => {
    console.error('Migration failed:', error);
    await disconnectFromDatabase();
    process.exitCode = 1;
});
