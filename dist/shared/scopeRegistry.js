/**
 * Phase 5 (DEC-060) — the staff GET routes that need no lead scope, each
 * with the reason. Every other staff GET route carries requireInScope or
 * scopeList (shared/scope.ts); tests/leadScopeInventory.test.ts fails on a
 * route that is neither, so a new endpoint has to be decided on.
 */
const AGGREGATE = 'Counts and totals only — names no buyer or seller.';
const PRODUCT = 'Product-level view — rows are products, not parties.';
const MASTER = 'Catalogue master data — no party on it.';
const ASSIGNEES = 'Lists staff to pick from — no party on it.';
const CONTROLLER = 'Controller/Admin desk only; those roles see every lead (LEADS_SEE_ALL).';
const ENQUIRY = 'Enquiry flow is off (ENQUIRY_FLOW_ENABLED, 2 Oct pivot); scope it when the flow is switched back on.';
export const LEAD_SCOPE_EXEMPT = {
    '/staff/accounts/snapshot': 'Accounts cash position — firm totals across all parties, read by the Accounts head.',
    '/staff/chains/:id': 'A chain is reached from an order or PO screen that is already scoped; the chain view itself is by desk.',
    '/staff/conduct/disagreements': CONTROLLER,
    '/staff/controller/disputes': CONTROLLER,
    '/staff/controller/exceptions': CONTROLLER,
    '/staff/purchase/demand': PRODUCT,
    '/staff/purchase/coverage-map': PRODUCT,
    '/staff/purchase/products/:productId/analysis': PRODUCT,
    '/staff/purchase/absorption': AGGREGATE,
    '/staff/purchase/return-notes/ageing': 'Rows carry the PO only — an ageing list for the hub, no party named.',
    '/staff/purchase/funnel': AGGREGATE,
    '/staff/purchase/matrix/by-product': PRODUCT,
    '/staff/purchase/demand/on-board-not-quoted': PRODUCT,
    '/staff/purchase/products/analysis': PRODUCT,
    '/staff/purchase/products/funnel': PRODUCT,
    '/staff/purchase/masters/drafts': MASTER,
    '/staff/purchase/masters/manufacturers': MASTER,
    '/staff/purchase/masters/products': MASTER,
    '/staff/purchase/assignees': ASSIGNEES,
    '/staff/sales/pulse': AGGREGATE,
    '/staff/sales/retention': AGGREGATE,
    '/staff/sales/complaints': 'Rows carry the order only — the complaint queue is worked by the desk lead.',
    '/staff/sales/board': PRODUCT,
    '/staff/sales/pools': 'Pool totals per product — the commitments inside a pool are scoped.',
    '/staff/sales/assignees': ASSIGNEES,
    '/staff/sales/funnel': AGGREGATE,
    '/staff/enquiries': ENQUIRY,
    '/staff/enquiries/assignees': ASSIGNEES,
    '/staff/enquiries/:id': ENQUIRY,
    '/staff/logistics/transporters': 'Transporter master — no buyer or seller on it.',
    '/staff/logistics/hub-position': 'Hub stock by product and PO — no party named.',
    '/staff/logistics/dashboard': AGGREGATE,
    '/staff/notifications/log': 'Notification delivery log, read by Admin for support.',
    '/staff/lookup': 'DEC-060 exact lookup — answers firm, side and leader only (the file only when in scope); rate-limited and audited.',
    '/staff/notifications/worklist': 'Notification delivery failures, read by Admin for support.',
    '/staff/sales/pushes': "Pushed to Purchase — filtered in the service by the pusher's team (an executive his own, a leader his team's).",
    '/staff/purchase/pushes': "From Sales — filtered in the service by the receiver's team (the receiver his own, a Purchase Leader his team's).",
    '/staff/purchase/pushes/:pushId': 'One push — the service lets in only the receiver, his Purchase Leader, or Admin; it carries no buyer trade.',
    '/staff/notices': "The caller's own in-app notices only.",
};
