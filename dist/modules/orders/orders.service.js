import { withTransaction } from '../../db/transaction.js';
import { So } from '../../models/So.js';
import { Po } from '../../models/Po.js';
import { Movement } from '../../models/Movement.js';
import { Buyer } from '../../models/Buyer.js';
import { Seller } from '../../models/Seller.js';
import { Complaint } from '../../models/Complaint.js';
import { Refund } from '../../models/Refund.js';
import { AppError } from '../../shared/errors.js';
import { writeAuditLog } from '../../shared/audit.js';
import { transitionToDispatchedLeg1, acceptPromotionOffer, rejectPromotionOffer, closeDeliveredSo, } from '../chain/chain.service.js';
import { PromotionOffer } from '../../models/PromotionOffer.js';
import { writeChainEvent } from '../chain/chain.events.js';
import { toBuyerSoDto, toSellerPoDto } from './orders.dto.js';
async function requireBuyer(buyerCounterpartyId) {
    const buyer = await Buyer.findOne({ counterpartyId: buyerCounterpartyId });
    if (!buyer)
        throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Buyers only.' });
    return buyer;
}
async function requireSeller(sellerCounterpartyId) {
    const seller = await Seller.findOne({ counterpartyId: sellerCounterpartyId });
    if (!seller)
        throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Sellers only.' });
    return seller;
}
// ---------------------------------------------------------------------------
// API-070 — 👤B side.
// ---------------------------------------------------------------------------
export async function listBuyerOrders(buyerCounterpartyId) {
    const buyer = await requireBuyer(buyerCounterpartyId);
    const sos = await So.find({ buyerId: buyer._id }).sort({ createdAt: -1 });
    const leg1s = await Movement.find({ chainId: { $in: sos.map((s) => s.chainId) }, leg: 1 });
    const leg1ByChain = new Map(leg1s.map((m) => [m.chainId.toString(), m]));
    return sos.map((so) => toBuyerSoDto(so, leg1ByChain.get(so.chainId.toString()) ?? null));
}
export async function getBuyerOrder(buyerCounterpartyId, soId) {
    const buyer = await requireBuyer(buyerCounterpartyId);
    const so = await So.findOne({ _id: soId, buyerId: buyer._id });
    if (!so)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
    const leg1 = await Movement.findOne({ chainId: so.chainId, leg: 1 });
    return toBuyerSoDto(so, leg1);
}
export async function getPromotionOffer(buyerCounterpartyId, soId) {
    const buyer = await requireBuyer(buyerCounterpartyId);
    const so = await So.findOne({ _id: soId, buyerId: buyer._id });
    if (!so)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
    const offer = await PromotionOffer.findOne({ soId: so._id, status: 'pending' });
    if (!offer)
        return null;
    return { expiresAt: offer.expiresAt.toISOString() };
}
export async function acceptPromotion(buyerCounterpartyId, soId, correlationId) {
    await requireBuyer(buyerCounterpartyId);
    await acceptPromotionOffer(soId, buyerCounterpartyId, correlationId);
}
export async function rejectPromotion(buyerCounterpartyId, soId) {
    await requireBuyer(buyerCounterpartyId);
    await rejectPromotionOffer(soId, buyerCounterpartyId);
}
// ---------------------------------------------------------------------------
// API-070 — 👤S side. BR-138 — blind on leg 2, no buyer identity ever.
// ---------------------------------------------------------------------------
export async function listSellerOrders(sellerCounterpartyId) {
    const seller = await requireSeller(sellerCounterpartyId);
    const pos = await Po.find({ sellerId: seller._id }).sort({ createdAt: -1 });
    const sos = await So.find({ _id: { $in: pos.map((p) => p.soId) } });
    const soById = new Map(sos.map((s) => [s._id.toString(), s]));
    const movements = await Movement.find({ chainId: { $in: pos.map((p) => p.chainId) } });
    const movementsByChain = new Map();
    for (const m of movements) {
        const key = m.chainId.toString();
        const list = movementsByChain.get(key) ?? [];
        list.push(m);
        movementsByChain.set(key, list);
    }
    return pos.map((po) => {
        const so = soById.get(po.soId.toString());
        const chainMovements = movementsByChain.get(po.chainId.toString()) ?? [];
        const leg1 = chainMovements.find((m) => m.leg === 1) ?? null;
        const leg2Exists = chainMovements.some((m) => m.leg === 2);
        return toSellerPoDto(po, so?.state ?? 'po_released', leg1, leg2Exists);
    });
}
export async function getSellerOrder(sellerCounterpartyId, poId) {
    const seller = await requireSeller(sellerCounterpartyId);
    const po = await Po.findOne({ _id: poId, sellerId: seller._id });
    if (!po)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
    const so = await So.findById(po.soId);
    const movements = await Movement.find({ chainId: po.chainId });
    const leg1 = movements.find((m) => m.leg === 1) ?? null;
    const leg2Exists = movements.some((m) => m.leg === 2);
    return toSellerPoDto(po, so?.state ?? 'po_released', leg1, leg2Exists);
}
export async function postDispatchLeg1(sellerCounterpartyId, poId, input, actor) {
    const seller = await requireSeller(sellerCounterpartyId);
    const po = await Po.findOne({ _id: poId, sellerId: seller._id });
    if (!po)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
    if (po.state !== 'released') {
        throw new AppError({
            code: 'ORDER_NOT_DISPATCHABLE',
            messageEn: 'This order has already been dispatched or is no longer active.',
        });
    }
    await withTransaction(async (session) => {
        await Movement.create([
            {
                chainId: po.chainId,
                leg: 1,
                mode: input.mode,
                transporter: input.transporter ?? null,
                lr: input.lr ?? null,
                busNo: input.busNo ?? null,
                driver: input.driver ?? null,
                driverMobile: input.driverMobile ?? null,
                photoRef: input.photoRef ?? null,
                freightTerms: input.freightTerms,
                freightAmountPaise: input.freightAmountPaise,
                recordedBy: seller._id,
            },
        ], { session, ordered: true });
        await writeChainEvent({
            chainId: po.chainId,
            type: 'leg1_dispatched',
            refCollection: 'po',
            refId: po._id,
            actorId: seller._id.toString(),
            actorType: 'counterparty',
            summary: `PO ${po.poNo} dispatched, leg 1 (${input.mode}).`,
        }, session);
        await writeAuditLog({
            actorId: seller._id.toString(),
            actorType: 'counterparty',
            entity: 'po',
            entityId: po._id,
            field: 'dispatch_leg1',
            newValue: { mode: input.mode },
            correlationId: actor.correlationId,
        }, session);
    });
    await transitionToDispatchedLeg1(po.soId.toString(), po._id.toString());
    return { dispatched: true };
}
// ---------------------------------------------------------------------------
// API-076 — 👤S. A desk lifeline flag; not auto-actioned (see Po.ts comment).
// ---------------------------------------------------------------------------
export async function postExtensionRequest(sellerCounterpartyId, poId, reason) {
    const seller = await requireSeller(sellerCounterpartyId);
    const po = await Po.findOne({ _id: poId, sellerId: seller._id });
    if (!po)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
    if (po.state !== 'released') {
        throw new AppError({
            code: 'ORDER_NOT_DISPATCHABLE',
            messageEn: 'An extension can only be requested before dispatch.',
        });
    }
    po.extensionRequestedAt = new Date();
    po.extensionReason = reason;
    await po.save();
    return { requested: true };
}
// ---------------------------------------------------------------------------
// API-073 — 👤B. BR-192 — the buyer's tap is an accelerator, not a
// requirement; silence defaults to the same outcome after seven days
// (M10: `runDeliveryAutoClose`, modules/clocks — both call `closeDeliveredSo`).
// ---------------------------------------------------------------------------
export async function confirmReceipt(buyerCounterpartyId, soId) {
    const buyer = await requireBuyer(buyerCounterpartyId);
    const so = await So.findOne({ _id: soId, buyerId: buyer._id });
    if (!so)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
    if (so.state !== 'dispatched_leg2') {
        throw new AppError({
            code: 'ORDER_NOT_YET_DELIVERABLE',
            messageEn: 'This order has not left Indore on its second leg yet.',
        });
    }
    // M10 — the same close the seven-day clock performs (BR-192): silence and the tap are one rule.
    const closed = await closeDeliveredSo(soId, { actorId: buyerCounterpartyId, actorType: 'counterparty' }, `confirm-receipt-${soId}`);
    if (!closed) {
        // Lost a race with a complaint or the auto-close between the read above and the claim.
        throw new AppError({
            code: 'ORDER_NOT_YET_DELIVERABLE',
            messageEn: 'This order can no longer be confirmed.',
        });
    }
    return { closed: true };
}
export async function postComplaint(buyerCounterpartyId, soId, input) {
    const buyer = await requireBuyer(buyerCounterpartyId);
    const so = await So.findOne({ _id: soId, buyerId: buyer._id });
    if (!so)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
    if (so.state !== 'dispatched_leg2' && so.state !== 'delivered') {
        throw new AppError({
            code: 'COMPLAINT_WINDOW_CLOSED',
            messageEn: 'A complaint can only be raised after leg 2 has dispatched, within the window.',
        });
    }
    // M10 — claim the order (→ disputed) and file the complaint in one transaction, so a
    // complaint and the seven-day auto-close (BR-192) can never both take the same order.
    return withTransaction(async (session) => {
        const claimed = await So.findOneAndUpdate({ _id: so._id, state: { $in: ['dispatched_leg2', 'delivered'] } }, { $set: { state: 'disputed' } }, { session, new: true });
        if (!claimed) {
            throw new AppError({
                code: 'COMPLAINT_WINDOW_CLOSED',
                messageEn: 'A complaint can only be raised after leg 2 has dispatched, within the window.',
            });
        }
        const [complaint] = await Complaint.create([
            {
                soId: so._id,
                buyerId: buyer._id,
                category: input.category,
                note: input.note ?? null,
            },
        ], { session, ordered: true });
        if (!complaint)
            throw new Error('Complaint.create returned no document.');
        return { complaintId: complaint._id.toString() };
    });
}
export async function getComplaints(buyerCounterpartyId, soId) {
    const buyer = await requireBuyer(buyerCounterpartyId);
    const so = await So.findOne({ _id: soId, buyerId: buyer._id });
    if (!so)
        throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
    const complaints = await Complaint.find({ soId: so._id }).sort({ createdAt: -1 });
    return complaints.map((c) => ({
        complaintId: c._id.toString(),
        category: c.category,
        state: c.state,
    }));
}
export async function listBuyerRefunds(buyerCounterpartyId) {
    const buyer = await requireBuyer(buyerCounterpartyId);
    const refunds = await Refund.find({ buyerId: buyer._id }).sort({ createdAt: -1 });
    return refunds.map((r) => ({
        refundId: r._id.toString(),
        amountPaise: r.amountPaise,
        reasonCode: r.reasonCode,
        state: r.state,
        createdAt: r.createdAt,
    }));
}
/**
 * The access token carries no buyer/seller discriminator (`shared/tokens.ts`
 * `AccessTokenClaims` — a `both` firm's counterpartyId is the same value
 * either app calls with), so ownership is resolved by trying both sides
 * rather than trusting a client-asserted role.
 */
async function loadSoForActor(actorCounterpartyId, soId) {
    const buyer = await Buyer.findOne({ counterpartyId: actorCounterpartyId });
    if (buyer) {
        const so = await So.findOne({ _id: soId, buyerId: buyer._id });
        if (so)
            return so;
    }
    const seller = await Seller.findOne({ counterpartyId: actorCounterpartyId });
    if (seller) {
        const so = await So.findOne({ _id: soId, sellerId: seller._id });
        if (so)
            return so;
    }
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Order not found.' });
}
export async function getOrderDocuments(actorCounterpartyId, soId) {
    const so = await loadSoForActor(actorCounterpartyId, soId);
    const { MargBill } = await import('../../models/MargBill.js');
    const margBill = await MargBill.findOne({ soId: so._id, state: 'matched' });
    const leg1 = await Movement.findOne({ chainId: so.chainId, leg: 1 });
    return [
        { kind: 'invoice', available: !!margBill?.margPdfRef, ref: margBill?.margPdfRef ?? undefined },
        { kind: 'eway_bill', available: !!margBill?.ewayNo, ref: margBill?.ewayNo ?? undefined },
        { kind: 'lr', available: !!leg1?.lr, ref: leg1?.lr ?? undefined },
        {
            kind: 'dispatch_photo',
            available: !!leg1?.photoRef,
            ref: leg1?.photoRef ?? undefined,
        },
    ];
}
