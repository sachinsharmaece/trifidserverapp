/**
 * API-070 — "two different response types." `BuyerSoDto` never carries a
 * sellerId or a seller net rate (BR-060); `SellerPoDto` never carries a
 * buyerId or a delivery location, and its movement summary is blind on the
 * terminal leg-2 step (BR-138 — "the last step is blind... carries no
 * destination"). Both DTOs are built here, in the one place, rather than
 * inline in the service, so the wall is one function to review, not N.
 */
// The ladder rung a screen renders — coarser than SO_STATES/PO_STATES,
// finer than chain.stage. Includes the Round-2 correction: "Paperwork at
// Indore" (BR-030's stage-4 leg, covering at_indore/inspected/billed_in_marg)
// as its own rung rather than folding it into "Leg 1" or "Leg 2".
export const ORDER_RUNGS = [
    'placed',
    'payment',
    'seller_confirmed',
    'leg1_dispatch',
    'paperwork_at_indore',
    'leg2_dispatch',
    'delivered',
    'closed',
    'stopped',
];
const SO_STATE_TO_RUNG = {
    draft: 'placed',
    awaiting_seller_confirmation: 'placed',
    requote_offered: 'placed',
    awaiting_payment: 'payment',
    payment_verifying: 'payment',
    po_released: 'seller_confirmed',
    dispatched_leg1: 'leg1_dispatch',
    at_indore: 'paperwork_at_indore',
    inspected: 'paperwork_at_indore',
    billed_in_marg: 'paperwork_at_indore',
    dispatched_leg2: 'leg2_dispatch',
    delivered: 'delivered',
    closed: 'closed',
    cancelled: 'stopped',
    supply_failed: 'stopped',
    // M6/WF-11 — a replacement seller is being arranged; not stopped (a
    // resolution is actively in flight) and not yet a real "seller confirmed"
    // either. Closest existing rung until IC-14's own screen (a dedicated
    // interstitial, not a ladder state) fully replaces the need for one here.
    promotion_offered: 'seller_confirmed',
    disputed: 'stopped',
};
export function rungForSoState(state) {
    return SO_STATE_TO_RUNG[state];
}
export function toBuyerSoDto(so, leg1) {
    return {
        soId: so._id.toString(),
        soNo: so.soNo,
        rung: rungForSoState(so.state),
        soState: so.state,
        totalPaise: so.totalPaise,
        payDeadline: so.payDeadline,
        deliveryWindowEndsAt: so.deliveryWindowEndsAt ?? null,
        createdAt: so.createdAt,
        leg1: leg1 ? { mode: leg1.mode, dispatchedAt: leg1.dispatchedAt } : null,
        canConfirmReceipt: so.state === 'dispatched_leg2',
        canComplain: so.state === 'dispatched_leg2' || so.state === 'delivered',
        canPay: so.state === 'awaiting_payment',
    };
}
export function toSellerPoDto(po, soState, leg1, leg2Exists) {
    return {
        poId: po._id.toString(),
        poNo: po.poNo,
        rung: rungForSoState(soState),
        poState: po.state,
        dispatchDueDate: po.dispatchDueDate,
        promisedOutOfIndoreBy: po.promisedOutOfIndoreBy,
        hold: po.hold,
        failed: po.failed,
        requoteCount: po.requoteCount,
        extensionRequestedAt: po.extensionRequestedAt ?? null,
        leg1: leg1 ? { mode: leg1.mode, dispatchedAt: leg1.dispatchedAt } : null,
        leg2Dispatched: leg2Exists,
        canDispatchLeg1: po.state === 'released',
        canRequestExtension: po.state === 'released' && !po.extensionRequestedAt,
    };
}
