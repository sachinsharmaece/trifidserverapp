import { PERMISSIONS } from '../../config/permissions.js';
/**
 * Which projection a caller gets, decided from permissions (TD-007), never a
 * role name. Anyone whose permissions do not clearly point to exactly one desk
 * gets the narrowest view.
 */
export function chainViewAudienceFor(permissions) {
    if (permissions.includes(PERMISSIONS.CHAIN_READ_FULL))
        return 'full';
    const isSales = permissions.includes(PERMISSIONS.SO_CREATE);
    const isPurchase = permissions.includes(PERMISSIONS.PO_CREATE);
    if (isSales && !isPurchase)
        return 'sales';
    if (isPurchase && !isSales)
        return 'purchase';
    return 'logistics';
}
const eventsOf = (events) => events.map((event) => ({ type: event.type, at: event.at }));
export function projectChainView(audience, view) {
    const { chainNo, stage, so, po, events } = view;
    if (audience === 'full') {
        return { chainNo, stage, so: view.raw.so, po: view.raw.po, events: view.raw.events };
    }
    if (audience === 'sales') {
        // His side: the buyer and the buyer-facing value. No seller, no seller rate.
        return {
            chainNo,
            stage,
            so: so && {
                soId: String(so._id),
                soNo: so.soNo,
                state: so.state,
                buyerId: String(so.buyerId),
                totalPaise: so.totalPaise,
                payDeadline: so.payDeadline,
            },
            po: po && { poNo: po.poNo, state: po.state, dispatchDueDate: po.dispatchDueDate },
            events: eventsOf(events),
        };
    }
    if (audience === 'purchase') {
        // His side: the seller. No buyer, no buyer-side rupee value (CH §18.5).
        return {
            chainNo,
            stage,
            so: so && { soId: String(so._id), soNo: so.soNo, state: so.state },
            po: po && {
                poId: String(po._id),
                poNo: po.poNo,
                state: po.state,
                sellerId: String(po.sellerId),
                dispatchDueDate: po.dispatchDueDate,
            },
            events: eventsOf(events),
        };
    }
    // Logistics — no firm on either side and no money (CH §17.3.1, BR-071).
    return {
        chainNo,
        stage,
        so: so && { soNo: so.soNo, state: so.state },
        po: po && { poNo: po.poNo, state: po.state, dispatchDueDate: po.dispatchDueDate },
        events: eventsOf(events),
    };
}
