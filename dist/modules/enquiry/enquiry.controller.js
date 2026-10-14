import { chainViewAudienceFor } from '../chain/chain.view.js';
import * as enquiryService from './enquiry.service.js';
import * as enquiryActions from './enquiry.actions.js';
import { enquiryIdParamsSchema, } from './enquiry.validation.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
function staff(req) {
    return {
        employeeId: req.auth.employeeId,
        audience: chainViewAudienceFor(req.auth.permissions),
        correlationId: req.correlationId,
        permissions: req.auth.permissions,
    };
}
const idOf = (req) => enquiryIdParamsSchema.parse(req.params).id;
// API-210 — 🏢 chain:read. Each desk receives only its own side (enquiry.service.ts).
export async function getEnquiries(req, res) {
    const query = req.validatedQuery;
    const ctx = staff(req);
    ok(res, req, await enquiryService.listEnquiries(ctx.audience, ctx.employeeId, query));
}
// API-211 — 🏢 chain:read.
export async function getEnquiry(req, res) {
    const ctx = staff(req);
    ok(res, req, await enquiryService.getEnquiry(ctx.audience, req.auth.permissions, idOf(req)));
}
// API-212 — 🏢 proxy:buyer_call OR proxy:seller_call, matched to `party` inside. DEC-052.
export async function postEnquiry(req, res) {
    const input = req.body;
    ok(res, req, await enquiryActions.createEnquiry(input, staff(req)), 201);
}
// API-219 — 🏢 proxy:buyer_call OR proxy:seller_call, matched to the enquiry's own party. DEC-052.
export async function postEdit(req, res) {
    const input = req.body;
    await enquiryActions.editEnquiry(idOf(req), input, staff(req));
    ok(res, req, { edited: true });
}
// API-213 — 🏢 proxy:buyer_call (Sales). DEC-052. Buyer party only.
export async function postConvert(req, res) {
    const input = req.body;
    ok(res, req, await enquiryActions.convertEnquiry(idOf(req), input, staff(req)), 201);
}
// API-214 — 🏢 proxy:buyer_call OR proxy:seller_call, matched to the enquiry's own party. DEC-052.
export async function postDrop(req, res) {
    const input = req.body;
    await enquiryActions.dropEnquiry(idOf(req), input, staff(req));
    ok(res, req, { dropped: true });
}
// API-220 — 🏢 proxy:seller_call (Purchase). DEC-052. Seller party only.
export async function postMarkListed(req, res) {
    const input = req.body;
    await enquiryActions.markEnquiryListed(idOf(req), input, staff(req));
    ok(res, req, { listed: true });
}
// API-215 — 🏢 enquiry:manage.
export async function postOwner(req, res) {
    const input = req.body;
    await enquiryActions.setOwner(idOf(req), input, staff(req));
    ok(res, req, { updated: true });
}
// API-216 — 🏢 enquiry:manage.
export async function postFollowUp(req, res) {
    const input = req.body;
    await enquiryActions.setFollowUp(idOf(req), input, staff(req));
    ok(res, req, { updated: true });
}
// API-217 — 🏢 enquiry:manage.
export async function postNote(req, res) {
    const input = req.body;
    await enquiryActions.addNote(idOf(req), input, staff(req));
    ok(res, req, { added: true }, 201);
}
// API-218 — 🏢 enquiry:manage.
export async function getAssignees(req, res) {
    const { desk } = req.validatedQuery;
    ok(res, req, await enquiryActions.listAssignees(desk, staff(req)));
}
