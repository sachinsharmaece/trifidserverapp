import { Pool } from '../../../models/Pool.js';
import { PoolCommitment } from '../../../models/PoolCommitment.js';
import { Buyer } from '../../../models/Buyer.js';
import { Counterparty } from '../../../models/Counterparty.js';
import { BookAssignment } from '../../../models/BookAssignment.js';
import { Employee } from '../../../models/Employee.js';
import { Sku } from '../../../models/Sku.js';
import { Product } from '../../../models/Product.js';
import { AppError } from '../../../shared/errors.js';
import { sumQty } from '../../pool/pool.service.js';
async function toPoolRow(pool) {
    // B-27 — the pool card showed a truncated SKU id and the raw
    // `conditionSetKey`, never the product name it's actually a pool on.
    const sku = await Sku.findById(pool.skuId);
    const product = sku ? await Product.findById(sku.productId) : null;
    const commitments = await PoolCommitment.find({ poolId: pool._id }).sort({ createdAt: 1 });
    const buyerIds = commitments.map((c) => c.buyerId);
    const buyers = await Buyer.find({ _id: { $in: buyerIds } });
    const buyerById = new Map(buyers.map((b) => [b._id.toString(), b]));
    const counterparties = await Counterparty.find({
        _id: { $in: buyers.map((b) => b.counterpartyId) },
    });
    const firmByCounterpartyId = new Map(counterparties.map((c) => [c._id.toString(), c.firm ?? '']));
    const assignments = await BookAssignment.find({ buyerId: { $in: buyerIds } });
    const ownerEmployeeIdByBuyer = new Map(assignments.map((a) => [a.buyerId.toString(), a.ownerEmployeeId]));
    const employees = await Employee.find({ _id: { $in: [...ownerEmployeeIdByBuyer.values()] } });
    const employeeNameById = new Map(employees.map((e) => [e._id.toString(), e.person]));
    const commitmentRows = commitments.map((c) => {
        const buyerIdStr = c.buyerId.toString();
        const buyer = buyerById.get(buyerIdStr);
        const firm = buyer
            ? (firmByCounterpartyId.get(buyer.counterpartyId.toString()) ?? '')
            : '';
        const ownerEmployeeId = ownerEmployeeIdByBuyer.get(buyerIdStr);
        return {
            poolCommitmentId: c._id.toString(),
            buyerId: buyerIdStr,
            buyerFirm: firm,
            ownerName: ownerEmployeeId
                ? (employeeNameById.get(ownerEmployeeId.toString()) ?? null)
                : null,
            qty: c.qty,
            isBinding: c.isBinding,
            reconfirmedAt: c.reconfirmedAt ? c.reconfirmedAt.toISOString() : null,
            paidAt: c.paidAt ? c.paidAt.toISOString() : null,
            withdrawnAt: c.withdrawnAt ? c.withdrawnAt.toISOString() : null,
        };
    });
    // A withdrawn commitment stays visible on the pool (so the desk can see who
    // dropped out) but no longer counts towards how close the pool is to MOQ.
    const live = commitmentRows.filter((c) => !c.withdrawnAt);
    // B-41 — "NaN of 200 boxes" (pool.service.ts's own sumQty comment has the
    // full trace); shared here rather than re-guarding the same reduce twice.
    const committedQty = sumQty(live);
    const bindingQty = sumQty(live.filter((c) => c.isBinding));
    return {
        poolId: pool._id.toString(),
        skuId: pool.skuId.toString(),
        brand: product?.brand ?? '',
        packLabel: sku?.packLabel ?? '',
        conditionSetKey: pool.conditionSetKey,
        expiryBand: pool.expiryBand,
        moqBand: pool.moqBand,
        deliveryBand: pool.deliveryBand,
        provenance: pool.provenance,
        moq: pool.moq,
        status: pool.status,
        isActive: pool.isActive,
        triggeredAt: pool.triggeredAt ? pool.triggeredAt.toISOString() : null,
        payDeadline: pool.payDeadline ? pool.payDeadline.toISOString() : null,
        committedQty,
        bindingQty,
        commitments: commitmentRows,
    };
}
export async function getPools() {
    const pools = await Pool.find({}).sort({ createdAt: -1 }).limit(300);
    const rows = [];
    for (const pool of pools)
        rows.push(await toPoolRow(pool));
    return rows;
}
export async function getPool(poolId) {
    const pool = await Pool.findById(poolId);
    if (!pool)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Pool not found.' });
    return toPoolRow(pool);
}
