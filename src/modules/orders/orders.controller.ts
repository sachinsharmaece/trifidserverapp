import type { Request, Response } from 'express';
import * as ordersService from './orders.service.js';
import {
  dispatchLeg1Schema,
  extensionRequestSchema,
  postComplaintSchema,
} from './orders.validation.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

// API-070 — 👤B.
export async function getMyOrders(req: Request, res: Response): Promise<void> {
  ok(res, req, await ordersService.listBuyerOrders(req.auth!.counterpartyId!));
}
export async function getMyOrder(req: Request, res: Response): Promise<void> {
  ok(
    res,
    req,
    await ordersService.getBuyerOrder(req.auth!.counterpartyId!, req.params.id as string),
  );
}

// API-070 — 👤S.
export async function getMySellerOrders(req: Request, res: Response): Promise<void> {
  ok(res, req, await ordersService.listSellerOrders(req.auth!.counterpartyId!));
}
export async function getMySellerOrder(req: Request, res: Response): Promise<void> {
  ok(
    res,
    req,
    await ordersService.getSellerOrder(req.auth!.counterpartyId!, req.params.id as string),
  );
}

// API-075 — 👤S. Idempotency-Key required — moves the chain to stage leg1.
export async function postDispatch(req: Request, res: Response): Promise<void> {
  const input = dispatchLeg1Schema.parse(req.body);
  const result = await ordersService.postDispatchLeg1(
    req.auth!.counterpartyId!,
    req.params.id as string,
    input,
    { correlationId: req.correlationId },
  );
  ok(res, req, result, 201);
}

// API-076 — 👤S.
export async function postExtensionRequest(req: Request, res: Response): Promise<void> {
  const { reason } = extensionRequestSchema.parse(req.body);
  const result = await ordersService.postExtensionRequest(
    req.auth!.counterpartyId!,
    req.params.id as string,
    reason,
  );
  ok(res, req, result);
}

// API-073 — 👤B.
export async function postConfirmReceipt(req: Request, res: Response): Promise<void> {
  const result = await ordersService.confirmReceipt(
    req.auth!.counterpartyId!,
    req.params.id as string,
  );
  ok(res, req, result);
}

// API-074 — 👤B.
export async function postComplaint(req: Request, res: Response): Promise<void> {
  const input = postComplaintSchema.parse(req.body);
  const result = await ordersService.postComplaint(
    req.auth!.counterpartyId!,
    req.params.id as string,
    input,
  );
  ok(res, req, result, 201);
}
export async function getComplaints(req: Request, res: Response): Promise<void> {
  const result = await ordersService.getComplaints(
    req.auth!.counterpartyId!,
    req.params.id as string,
  );
  ok(res, req, result);
}

// New — 👤B. See orders.service.ts's own comment.
export async function getMyRefunds(req: Request, res: Response): Promise<void> {
  ok(res, req, await ordersService.listBuyerRefunds(req.auth!.counterpartyId!));
}

// API-077 — 👤B / 👤S — ownership resolved server-side, see orders.service.ts.
export async function getDocuments(req: Request, res: Response): Promise<void> {
  const result = await ordersService.getOrderDocuments(
    req.auth!.counterpartyId!,
    req.params.id as string,
  );
  ok(res, req, result);
}
