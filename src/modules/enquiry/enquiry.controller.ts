import type { Request, Response } from 'express';
import type { z } from 'zod';
import { chainViewAudienceFor } from '../chain/chain.view.js';
import * as enquiryService from './enquiry.service.js';
import * as enquiryActions from './enquiry.actions.js';
import {
  enquiryIdParamsSchema,
  type addNoteSchema,
  type assigneesQuerySchema,
  type convertEnquirySchema,
  type createEnquirySchema,
  type dropEnquirySchema,
  type editEnquirySchema,
  type listEnquiriesQuerySchema,
  type markListedSchema,
  type setFollowUpSchema,
  type setOwnerSchema,
} from './enquiry.validation.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

function staff(req: Request): enquiryActions.StaffContext {
  return {
    employeeId: req.auth!.employeeId!,
    audience: chainViewAudienceFor(req.auth!.permissions),
    correlationId: req.correlationId,
    permissions: req.auth!.permissions,
  };
}

const idOf = (req: Request) => enquiryIdParamsSchema.parse(req.params).id;

// API-210 — 🏢 chain:read. Each desk receives only its own side (enquiry.service.ts).
export async function getEnquiries(req: Request, res: Response): Promise<void> {
  const query = req.validatedQuery as z.infer<typeof listEnquiriesQuerySchema>;
  const ctx = staff(req);
  ok(res, req, await enquiryService.listEnquiries(ctx.audience, ctx.employeeId, query));
}

// API-211 — 🏢 chain:read.
export async function getEnquiry(req: Request, res: Response): Promise<void> {
  const ctx = staff(req);
  ok(res, req, await enquiryService.getEnquiry(ctx.audience, req.auth!.permissions, idOf(req)));
}

// API-212 — 🏢 proxy:buyer_call OR proxy:seller_call, matched to `party` inside. DEC-052.
export async function postEnquiry(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof createEnquirySchema>;
  ok(res, req, await enquiryActions.createEnquiry(input, staff(req)), 201);
}

// API-219 — 🏢 proxy:buyer_call OR proxy:seller_call, matched to the enquiry's own party. DEC-052.
export async function postEdit(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof editEnquirySchema>;
  await enquiryActions.editEnquiry(idOf(req), input, staff(req));
  ok(res, req, { edited: true });
}

// API-213 — 🏢 proxy:buyer_call (Sales). DEC-052. Buyer party only.
export async function postConvert(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof convertEnquirySchema>;
  ok(res, req, await enquiryActions.convertEnquiry(idOf(req), input, staff(req)), 201);
}

// API-214 — 🏢 proxy:buyer_call OR proxy:seller_call, matched to the enquiry's own party. DEC-052.
export async function postDrop(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof dropEnquirySchema>;
  await enquiryActions.dropEnquiry(idOf(req), input, staff(req));
  ok(res, req, { dropped: true });
}

// API-220 — 🏢 proxy:seller_call (Purchase). DEC-052. Seller party only.
export async function postMarkListed(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof markListedSchema>;
  await enquiryActions.markEnquiryListed(idOf(req), input, staff(req));
  ok(res, req, { listed: true });
}

// API-215 — 🏢 enquiry:manage.
export async function postOwner(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof setOwnerSchema>;
  await enquiryActions.setOwner(idOf(req), input, staff(req));
  ok(res, req, { updated: true });
}

// API-216 — 🏢 enquiry:manage.
export async function postFollowUp(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof setFollowUpSchema>;
  await enquiryActions.setFollowUp(idOf(req), input, staff(req));
  ok(res, req, { updated: true });
}

// API-217 — 🏢 enquiry:manage.
export async function postNote(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof addNoteSchema>;
  await enquiryActions.addNote(idOf(req), input, staff(req));
  ok(res, req, { added: true }, 201);
}

// API-218 — 🏢 enquiry:manage.
export async function getAssignees(req: Request, res: Response): Promise<void> {
  const { desk } = req.validatedQuery as z.infer<typeof assigneesQuerySchema>;
  ok(res, req, await enquiryActions.listAssignees(desk, staff(req)));
}
