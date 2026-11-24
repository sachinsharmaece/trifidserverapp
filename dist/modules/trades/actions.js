export const TRADE_ACTIONS = {
    wantIt: { label: 'He wants it', desk: 'SALES', buyerFrom: ['B1_VIEWING'] },
    sendToSeller: { label: 'Send to seller', desk: 'SALES', buyerFrom: ['B2_INQUIRY'] },
    giveQuote: {
        label: 'Record the quote',
        desk: 'PURCHASE',
        buyerFrom: ['B3_PENDING_SELLER'],
        sellerFrom: ['S0_DEMAND'],
    },
    confirmStock: {
        label: 'Seller confirms',
        desk: 'PURCHASE',
        buyerFrom: ['B3_PENDING_SELLER'],
        sellerFrom: ['S1_CONFIRMATION'],
    },
    declineStock: {
        label: 'Seller declines',
        desk: 'PURCHASE',
        buyerFrom: ['B3_PENDING_SELLER'],
        sellerFrom: ['S1_CONFIRMATION'],
    },
    sendToBuyer: { label: 'Send to buyer', desk: 'SALES', buyerFrom: ['B4_SEND_CONFIRMATION'] },
    buyerYes: { label: 'Buyer says yes', desk: 'SALES', buyerFrom: ['B5_BUYERS_CALL'] },
    buyerNo: { label: 'Buyer says no', desk: 'SALES', buyerFrom: ['B5_BUYERS_CALL'] },
    leakAfterOrder: {
        label: 'Buyer drops the order',
        desk: 'SALES',
        buyerFrom: ['B6_ORDER_CONFIRMED'],
    },
    reopen: { label: 'Reopen', desk: 'SALES', buyerFrom: ['X_LEAKAGE'] },
};
export const TRADE_ACTION_NAMES = Object.keys(TRADE_ACTIONS);
export function isTradeAction(name) {
    return Object.hasOwn(TRADE_ACTIONS, name);
}
/** Is the trade at a stage where this action makes sense? */
export function isAtStage(action, trade) {
    const rule = TRADE_ACTIONS[action];
    if (!rule.buyerFrom.includes(trade.buyerStage))
        return false;
    if (!rule.sellerFrom)
        return true;
    return trade.sellerStage ? rule.sellerFrom.includes(trade.sellerStage) : false;
}
/** Founder and Admin have every right, so they may press any desk's button (client decision, 23 Nov 2026). */
export const PRESS_ANY_BUTTON_ROLES = ['FOUNDER', 'ADMIN'];
/** May this role press this action's button? Its own desk, or Founder/Admin. */
export function canPress(role, action) {
    return role === TRADE_ACTIONS[action].desk || PRESS_ANY_BUTTON_ROLES.includes(role);
}
/** Names people see for the desks, as in "Purchase does this". */
export const DESK_NAMES = { SALES: 'Sales', PURCHASE: 'Purchase' };
/** Labels for the history: the actions above plus the two that create a trade. */
export const HISTORY_LABELS = {
    openViewing: 'Opened from the rate board',
    askNotListed: 'Asked for an item that is not listed',
    ...Object.fromEntries(TRADE_ACTION_NAMES.map((name) => [name, TRADE_ACTIONS[name].label])),
};
//# sourceMappingURL=actions.js.map