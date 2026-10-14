import { So } from '../../../models/So.js';
import { SoLine } from '../../../models/SoLine.js';
import { Sku } from '../../../models/Sku.js';
import { Product } from '../../../models/Product.js';
import { Buyer } from '../../../models/Buyer.js';
import { Counterparty } from '../../../models/Counterparty.js';
import { UpcomingReceipt } from '../../../models/UpcomingReceipt.js';
import { Chain } from '../../../models/Chain.js';
const CLOSED_SO_STATES = ['delivered', 'closed', 'cancelled', 'supply_failed'];
/** GET /staff/sales/orders?tab=live|closed — optionally scoped to one buyer for the buyer file. */
export async function listOrders(filters) {
    const query = {};
    if (filters.tab === 'closed')
        query.state = { $in: CLOSED_SO_STATES };
    else if (filters.tab === 'live')
        query.state = { $nin: CLOSED_SO_STATES };
    if (filters.buyerId)
        query.buyerId = filters.buyerId;
    const sos = await So.find(query).sort({ createdAt: -1 }).limit(500);
    if (sos.length === 0)
        return [];
    const buyerIds = [...new Set(sos.map((so) => so.buyerId.toString()))];
    const buyers = await Buyer.find({ _id: { $in: buyerIds } });
    const buyerById = new Map(buyers.map((b) => [b._id.toString(), b]));
    const counterparties = await Counterparty.find({
        _id: { $in: buyers.map((b) => b.counterpartyId) },
    });
    const firmByCounterpartyId = new Map(counterparties.map((c) => [c._id.toString(), c.firm ?? '']));
    const lines = await SoLine.find({ soId: { $in: sos.map((so) => so._id) } });
    const firstLineBySo = new Map();
    for (const line of lines) {
        const key = line.soId.toString();
        if (!firstLineBySo.has(key))
            firstLineBySo.set(key, line);
    }
    const skus = await Sku.find({ _id: { $in: lines.map((l) => l.skuId) } });
    const skuById = new Map(skus.map((s) => [s._id.toString(), s]));
    const products = await Product.find({ _id: { $in: skus.map((s) => s.productId) } });
    const productById = new Map(products.map((p) => [p._id.toString(), p]));
    const receipts = await UpcomingReceipt.find({ buyerId: { $in: buyerIds } });
    const chains = await Chain.find({ _id: { $in: sos.map((so) => so.chainId) } });
    const chainById = new Map(chains.map((c) => [c._id.toString(), c]));
    return sos.map((so) => {
        const soIdStr = so._id.toString();
        const buyerIdStr = so.buyerId.toString();
        const buyer = buyerById.get(buyerIdStr);
        const firm = buyer
            ? (firmByCounterpartyId.get(buyer.counterpartyId.toString()) ?? '')
            : '';
        const line = firstLineBySo.get(soIdStr);
        const sku = line ? skuById.get(line.skuId.toString()) : undefined;
        const product = sku ? productById.get(sku.productId.toString()) : undefined;
        const productDisplay = product && sku ? `${product.brand} — ${sku.packLabel}` : '';
        const buyerReceipts = receipts.filter((r) => r.buyerId.toString() === buyerIdStr);
        const appliedClaim = buyerReceipts.find((r) => r.soIds.some((id) => id.toString() === soIdStr));
        const waitingClaim = buyerReceipts.find((r) => r.state === 'waiting' &&
            !r.soIds.some((id) => id.toString() === soIdStr));
        const chain = chainById.get(so.chainId.toString());
        return {
            soId: soIdStr,
            soNo: so.soNo,
            chainId: so.chainId.toString(),
            buyerId: buyerIdStr,
            buyerCounterpartyId: buyer ? buyer.counterpartyId.toString() : '',
            buyerFirm: firm,
            productDisplay,
            totalPaise: so.totalPaise,
            state: so.state,
            chainStage: (chain?.stage ?? 'so'),
            payDeadline: so.payDeadline.toISOString(),
            claimNeedsApplying: Boolean(waitingClaim),
            upcomingReceiptId: waitingClaim ? waitingClaim._id.toString() : null,
            claimedAt: appliedClaim ? appliedClaim.claimedAt.toISOString() : null,
            claimedAmountPaise: appliedClaim ? appliedClaim.amountPaise : null,
        };
    });
}
