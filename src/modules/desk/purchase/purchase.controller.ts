import { listAssignable } from '../../../shared/team.js';
import type { Request, Response } from 'express';
import * as purchaseService from './purchase.service.js';
import * as catalogService from '../../catalog/catalog.service.js';
import { getFunnelReport as getFunnelReportFromService } from './purchase.funnel.js';
import * as stages from './purchase.stages.js';
import {
  getSellerDealerships as getSellerDealershipsFromService,
  setSellerDealerships,
} from './purchase.catalogue.js';
import { getSellerStageFunnel } from './purchase.sellerFunnel.js';
import {
  draftManufacturerSchema,
  draftProductSchema,
  draftSkuSchema,
  nonOrderReasonSchema,
  requestStockHoldSchema,
  adjustStockHoldSchema,
  sellerCatalogueEntrySchema,
  sellerDealershipsSchema,
  sellerDispatchedSchema,
  sellerInvoiceSchema,
  stageCallNoteSchema,
} from './purchase.validation.js';

function ok(res: Response, req: Request, data: unknown, status = 200): void {
  res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}

function staffActor(req: Request): { employeeId: string; correlationId: string } {
  return { employeeId: req.auth!.employeeId!, correlationId: req.correlationId };
}

export async function getActiveDemandList(req: Request, res: Response): Promise<void> {
  const noSellerOnly = req.query.noSeller === 'true';
  ok(res, req, await purchaseService.getActiveDemandList({ noSellerOnly }));
}

export async function getQuoteGaps(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getQuoteGapsForAsk(req.params.askId as string));
}

export async function getAskSellerStates(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getAskSellerStates(req.params.askId as string));
}

export async function getCoverageMap(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getCoverageMap());
}

export async function getProductAnalysis(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getProductAnalysis(req.params.productId as string));
}

export async function getProductSellers(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getProductSellers(req.params.productId as string));
}

export async function getAbsorptionQueue(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getAbsorptionQueue());
}

export async function postNonOrderReason(req: Request, res: Response): Promise<void> {
  const input = nonOrderReasonSchema.parse(req.body);
  const result = await purchaseService.recordSupplyGapReason(input, {
    employeeId: req.auth!.employeeId!,
  });
  ok(res, req, result, 201);
}

export async function getReturnNoteAgeing(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getReturnNoteAgeing());
}

export async function getSellerRecoveryQueue(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getSellerRecoveryQueue());
}

export async function getFunnelReport(req: Request, res: Response): Promise<void> {
  ok(res, req, await getFunnelReportFromService());
}

// ---------------------------------------------------------------------------
// Purchase-desk v2.
// ---------------------------------------------------------------------------

export async function postSellerCatalogueEntry(req: Request, res: Response): Promise<void> {
  const input = sellerCatalogueEntrySchema.parse(req.body);
  const result = await purchaseService.upsertSellerCatalogueEntry(input, staffActor(req));
  ok(res, req, result, 201);
}

export async function getSellerCatalogue(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getSellerCatalogue(req.params.sellerId as string));
}

export async function getSellerDealerships(req: Request, res: Response): Promise<void> {
  ok(res, req, await getSellerDealershipsFromService(req.params.sellerId as string));
}

export async function putSellerDealerships(req: Request, res: Response): Promise<void> {
  const { manufacturerIds } = sellerDealershipsSchema.parse(req.body);
  ok(
    res,
    req,
    await setSellerDealerships(req.params.sellerId as string, manufacturerIds, staffActor(req)),
  );
}

export async function getSellerFile(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getSellerFile(req.params.sellerId as string));
}

export async function getSupplyMatrixByProduct(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getSupplyMatrixByProduct());
}

export async function getSupplyMatrixBySeller(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getSupplyMatrixBySeller());
}

export async function getPilesAwaitingDecision(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getPilesAwaitingDecision());
}

export async function getSellerStageFunnelRoute(req: Request, res: Response): Promise<void> {
  ok(res, req, await getSellerStageFunnel(req.params.sellerId as string));
}

// Stock → PO → Billed → Dispatch.
export async function getStockQueue(req: Request, res: Response): Promise<void> {
  ok(res, req, await stages.getStockQueue());
}
export async function postStockHold(req: Request, res: Response): Promise<void> {
  const { callNote, holdHours } = requestStockHoldSchema.parse(req.body);
  ok(
    res,
    req,
    await stages.requestStockHold(
      req.params.soId as string,
      { holdHours },
      staffActor(req),
      callNote,
    ),
    201,
  );
}
export async function postAdjustStockHold(req: Request, res: Response): Promise<void> {
  const { callNote, holdHours } = adjustStockHoldSchema.parse(req.body);
  ok(
    res,
    req,
    await stages.adjustStockHold(
      req.params.soId as string,
      { holdHours },
      staffActor(req),
      callNote,
    ),
  );
}
export async function postConfirmStockHold(req: Request, res: Response): Promise<void> {
  const { callNote } = stageCallNoteSchema.parse(req.body);
  ok(res, req, await stages.confirmStockHold(req.params.soId as string, staffActor(req), callNote));
}
export async function getPoQueue(req: Request, res: Response): Promise<void> {
  ok(res, req, await stages.getPoQueue());
}
export async function getBilledQueue(req: Request, res: Response): Promise<void> {
  ok(res, req, await stages.getBilledQueue());
}
export async function postSellerInvoice(req: Request, res: Response): Promise<void> {
  const { callNote, ...input } = sellerInvoiceSchema.parse(req.body);
  ok(
    res,
    req,
    await stages.recordSellerInvoice(req.params.poId as string, input, staffActor(req), callNote),
    201,
  );
}
export async function postSellerDispatched(req: Request, res: Response): Promise<void> {
  const { callNote, ...input } = sellerDispatchedSchema.parse(req.body);
  ok(
    res,
    req,
    await stages.recordSellerDispatch(req.params.poId as string, input, staffActor(req), callNote),
    201,
  );
}
export async function postHandToDispatch(req: Request, res: Response): Promise<void> {
  const { callNote } = stageCallNoteSchema.parse(req.body);
  ok(res, req, await stages.handToDispatch(req.params.poId as string, staffActor(req), callNote));
}

export async function getDispatchChaseQueue(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getDispatchChaseQueue());
}

export async function postDispatchChase(req: Request, res: Response): Promise<void> {
  await purchaseService.logDispatchChase(req.params.poId as string, staffActor(req));
  ok(res, req, { logged: true }, 201);
}

export async function postAskChase(req: Request, res: Response): Promise<void> {
  const { sellerId } = req.body as { sellerId: string };
  await purchaseService.logAskChase(req.params.askId as string, sellerId, staffActor(req));
  ok(res, req, { logged: true }, 201);
}

export async function postPileChase(req: Request, res: Response): Promise<void> {
  await purchaseService.logPileChase(req.params.pileId as string, staffActor(req));
  ok(res, req, { logged: true }, 201);
}

export async function getInspectionsPendingApply(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getInspectionsPendingApply());
}

export async function getProductAnalysisAll(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getProductAnalysisAll());
}

export async function getProductFunnelAll(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getProductFunnelAll());
}

export async function getDraftMasters(req: Request, res: Response): Promise<void> {
  ok(res, req, await catalogService.listDraftMasters());
}

// Purchase-desk v2 — read access to the manufacturer/product masters for the
// desk's own near-duplicate check (client-side) and picker, without granting
// the Admin-only CATALOG_WRITE these lists otherwise sit behind.
export async function getMastersManufacturers(req: Request, res: Response): Promise<void> {
  ok(res, req, await catalogService.listAllManufacturers());
}

export async function getMastersProducts(req: Request, res: Response): Promise<void> {
  ok(res, req, await catalogService.listAllProductsLite());
}

export async function getOpenSellerDebits(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getOpenSellerDebits());
}

export async function getSupplyMatrixCallList(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getSupplyMatrixCallList(req.params.productId as string));
}

export async function getOnBoardNotQuotedQueue(req: Request, res: Response): Promise<void> {
  ok(res, req, await purchaseService.getOnBoardNotQuotedQueue());
}

export async function postDraftManufacturer(req: Request, res: Response): Promise<void> {
  const { name, aka } = draftManufacturerSchema.parse(req.body);
  const result = await catalogService.createManufacturerDraft(name, req.auth!.employeeId!, aka);
  ok(res, req, result, 201);
}

export async function postDraftProduct(req: Request, res: Response): Promise<void> {
  const input = draftProductSchema.parse(req.body);
  const result = await catalogService.createProductDraft(input, req.auth!.employeeId!);
  ok(res, req, result, 201);
}

export async function postDraftSku(req: Request, res: Response): Promise<void> {
  const input = draftSkuSchema.parse(req.body);
  const result = await catalogService.createSkuDraft(input, req.auth!.employeeId!);
  ok(res, req, result, 201);
}

export async function getAssignees(req: Request, res: Response): Promise<void> {
  ok(
    res,
    req,
    await listAssignable('purchase', {
      employeeId: req.auth!.employeeId!,
      permissions: req.auth!.permissions,
    }),
  );
}
