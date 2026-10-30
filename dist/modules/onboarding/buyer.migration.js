import mongoose from 'mongoose';
import { Counterparty } from '../../models/Counterparty.js';
import { Buyer } from '../../models/Buyer.js';
import { toRateTier } from '../chain/chain.service.js';
/**
 * Phase 3 — brings an existing database up to the buyer-identity model
 * (DEC-054, DEC-055, DEC-058). Idempotent; a dry run (the default) writes
 * nothing. With `apply`, each value it changes is first copied to
 * `buyer_identity_migration_backup`, which `rollbackBuyerIdentityMigration`
 * restores.
 *
 * 1. **Login mobile index.** The old `mobile_1` (unique on every document)
 *    is replaced by `mobile_login_unique` (unique only where a login mobile
 *    is set), so a second firm on a shared number can be saved without one.
 * 2. **contactMobile** = the login mobile, where it is not set yet.
 * 3. **pan** = GSTIN characters 3–12, where a GSTIN exists and no PAN does.
 * 4. **category** from the old fields: `isTrader` → Trader, otherwise the
 *    trade position carries over. A buyer never classified stays without a
 *    category (he is priced as Retailer, indicative, either way — BR-044).
 *    The margin column every buyer reads is computed before and after and
 *    must be identical; a mismatch stops the run before anything is written.
 * 5. **address** = the GST principal place of business, where not set yet.
 */
export const BUYER_BACKUP_COLLECTION = 'buyer_identity_migration_backup';
async function legacyMobileIndexPresent() {
    const indexes = await Counterparty.collection.indexes();
    return indexes.some((i) => i.name === 'mobile_1' && i.unique === true && !i.partialFilterExpression);
}
export async function migrateBuyerIdentity(options) {
    const report = {
        mode: options.apply ? 'apply' : 'dry-run',
        legacyMobileIndex: (await legacyMobileIndexPresent()) ? 'present' : 'absent',
        contactMobileFilled: 0,
        panFilled: 0,
        categorySet: {},
        unclassified: 0,
        addressFilled: 0,
        marginColumnMismatches: [],
    };
    const backup = mongoose.connection.collection(BUYER_BACKUP_COLLECTION);
    const save = async (collection, docId, field, old) => {
        await backup.updateOne({ collection, docId, field }, { $setOnInsert: { collection, docId, field, old: old ?? null, savedAt: new Date() } }, { upsert: true });
    };
    // Work out the category changes first and prove the margin column holds.
    const buyers = await Buyer.find({ category: null });
    const categoryPlan = [];
    for (const buyer of buyers) {
        const legacy = buyer;
        if (!legacy.isTrader && !legacy.tradePosition) {
            report.unclassified += 1;
            continue;
        }
        const category = legacy.isTrader
            ? 'Trader'
            : legacy.tradePosition.charAt(0).toUpperCase() + legacy.tradePosition.slice(1);
        const before = toRateTier({ isTrader: legacy.isTrader, tradePosition: legacy.tradePosition });
        const after = toRateTier({
            category,
            isTrader: legacy.isTrader,
            tradePosition: legacy.tradePosition,
        });
        if (before !== after)
            report.marginColumnMismatches.push(`${String(buyer._id)}: ${before} → ${after}`);
        categoryPlan.push({ id: buyer._id, category });
        report.categorySet[category] = (report.categorySet[category] ?? 0) + 1;
    }
    if (report.marginColumnMismatches.length > 0)
        return report;
    if (options.apply && report.legacyMobileIndex === 'present') {
        await Counterparty.collection.dropIndex('mobile_1');
        report.legacyMobileIndex = 'dropped';
    }
    if (options.apply)
        await Counterparty.createIndexes();
    const needContact = await Counterparty.find({ contactMobile: null, mobile: { $type: 'string' } });
    report.contactMobileFilled = needContact.length;
    const needPan = await Counterparty.find({ pan: null, gstin: { $type: 'string' } });
    report.panFilled = needPan.length;
    const needAddress = await Buyer.find({ address: null, gstPpobAddress: { $type: 'string' } });
    report.addressFilled = needAddress.length;
    if (!options.apply)
        return report;
    for (const cp of needContact) {
        await save('counterparty', cp._id, 'contactMobile', null);
        await Counterparty.updateOne({ _id: cp._id }, { $set: { contactMobile: cp.mobile } });
    }
    for (const cp of needPan) {
        await save('counterparty', cp._id, 'pan', null);
        await Counterparty.updateOne({ _id: cp._id }, { $set: { pan: cp.gstin.slice(2, 12) } });
    }
    for (const plan of categoryPlan) {
        await save('buyer', plan.id, 'category', null);
        await Buyer.updateOne({ _id: plan.id }, { $set: { category: plan.category } });
    }
    for (const buyer of needAddress) {
        await save('buyer', buyer._id, 'address', null);
        await Buyer.updateOne({ _id: buyer._id }, { $set: { address: buyer.gstPpobAddress } });
    }
    return report;
}
/**
 * Restores every value the migration changed. The index swap is not undone:
 * once a firm without a login mobile exists, the old index can no longer be
 * built — and nothing reads it.
 */
export async function rollbackBuyerIdentityMigration() {
    const backup = mongoose.connection.collection(BUYER_BACKUP_COLLECTION);
    const rows = await backup.find().toArray();
    for (const row of rows) {
        const model = row.collection === 'buyer' ? Buyer : Counterparty;
        await model.updateOne({ _id: row.docId }, { $set: { [row.field]: row.old } });
    }
    await backup.deleteMany({});
    return { restored: rows.length };
}
